import type { NextFunction, Request, Response } from "express";
import { observeCapacityRejection, setCapacityLane } from "./observability/metrics";

export type CapacityLane = "api" | "chat_http" | "chat_ws";

export type CapacityState = {
  active: number;
  limit: number;
};

const LANE_CONFIG: Record<CapacityLane, { env: string; defaultValue: number; maxValue: number }> = {
  api: { env: "EA_API_MAX_CONCURRENCY", defaultValue: 200, maxValue: 5_000 },
  chat_http: { env: "EA_CHAT_HTTP_MAX_CONCURRENCY", defaultValue: 60, maxValue: 1_000 },
  chat_ws: { env: "EA_CHAT_WS_MAX_CONNECTIONS", defaultValue: 120, maxValue: 2_000 },
};

function boundedPositiveInteger(value: string | undefined, fallback: number, maxValue: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maxValue);
}

function createStates(): Record<CapacityLane, CapacityState> {
  return Object.fromEntries(
    Object.entries(LANE_CONFIG).map(([lane, config]) => [
      lane,
      {
        active: 0,
        limit: boundedPositiveInteger(process.env[config.env], config.defaultValue, config.maxValue),
      },
    ]),
  ) as Record<CapacityLane, CapacityState>;
}

let states = createStates();
for (const [lane, laneState] of Object.entries(states)) {
  setCapacityLane(lane, laneState.active, laneState.limit);
}

export function tryAcquireCapacity(lane: CapacityLane): (() => void) | null {
  const laneState = states[lane];
  if (laneState.active >= laneState.limit) {
    observeCapacityRejection(lane);
    return null;
  }
  laneState.active += 1;
  setCapacityLane(lane, laneState.active, laneState.limit);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    laneState.active = Math.max(0, laneState.active - 1);
    setCapacityLane(lane, laneState.active, laneState.limit);
  };
}

export function capacityGuard(lane: CapacityLane) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const release = tryAcquireCapacity(lane);
    if (!release) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({
        error: "当前请求较多，请稍后重试",
        code: "CAPACITY_EXCEEDED",
        lane,
        retryAfter: 2,
      });
      return;
    }
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

export function getCapacitySnapshot(): Record<CapacityLane, CapacityState> {
  return {
    api: { ...states.api },
    chat_http: { ...states.chat_http },
    chat_ws: { ...states.chat_ws },
  };
}

export async function waitForCapacityToDrain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Object.values(states).some((lane) => lane.active > 0)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export function resetCapacityForTests(limits?: Partial<Record<CapacityLane, number>>): void {
  states = createStates();
  for (const [lane, limit] of Object.entries(limits || {})) {
    if (limit && limit > 0) states[lane as CapacityLane].limit = limit;
  }
  for (const [lane, laneState] of Object.entries(states)) {
    setCapacityLane(lane, laneState.active, laneState.limit);
  }
}
