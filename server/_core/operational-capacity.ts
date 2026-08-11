import type { NextFunction, Request, Response } from "express";
import { observeCapacityRejection, setCapacityLane, setCapacityQueue } from "./observability/metrics";

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

type CapacityWaiter = {
  req: Request;
  res: Response;
  next: NextFunction;
  timer: ReturnType<typeof setTimeout>;
  dispatched: boolean;
};

const waiters: Record<CapacityLane, CapacityWaiter[]> = {
  api: [],
  chat_http: [],
  chat_ws: [],
};
const queueLimits: Record<CapacityLane, number> = { api: 0, chat_http: 0, chat_ws: 0 };

function publishQueue(lane: CapacityLane): void {
  setCapacityQueue(lane, waiters[lane].length, queueLimits[lane]);
}

function removeWaiter(lane: CapacityLane, waiter: CapacityWaiter): boolean {
  const index = waiters[lane].indexOf(waiter);
  if (index < 0) return false;
  waiters[lane].splice(index, 1);
  publishQueue(lane);
  return true;
}

function attachRelease(res: Response, release: () => void): void {
  res.once("finish", release);
  res.once("close", release);
}

function drainWaiters(lane: CapacityLane): void {
  while (waiters[lane].length > 0 && states[lane].active < states[lane].limit) {
    const waiter = waiters[lane].shift()!;
    publishQueue(lane);
    if (waiter.req.destroyed || waiter.res.destroyed || waiter.res.headersSent) {
      clearTimeout(waiter.timer);
      continue;
    }
    const release = acquireCapacity(lane, false);
    if (!release) {
      waiters[lane].unshift(waiter);
      publishQueue(lane);
      return;
    }
    waiter.dispatched = true;
    clearTimeout(waiter.timer);
    attachRelease(waiter.res, release);
    waiter.next();
  }
}

function acquireCapacity(lane: CapacityLane, recordRejection: boolean): (() => void) | null {
  const laneState = states[lane];
  if (laneState.active >= laneState.limit) {
    if (recordRejection) observeCapacityRejection(lane);
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
    queueMicrotask(() => drainWaiters(lane));
  };
}

export function tryAcquireCapacity(lane: CapacityLane): (() => void) | null {
  return acquireCapacity(lane, true);
}

export function capacityQueueGuard(
  lane: CapacityLane,
  options: { maxQueued: number; maxWaitMs: number },
) {
  const maxQueued = Math.max(0, Math.floor(options.maxQueued));
  const maxWaitMs = Math.max(1_000, Math.floor(options.maxWaitMs));
  queueLimits[lane] = maxQueued;
  publishQueue(lane);
  return (req: Request, res: Response, next: NextFunction): void => {
    const release = acquireCapacity(lane, false);
    if (release) {
      attachRelease(res, release);
      next();
      return;
    }
    if (maxQueued === 0 || waiters[lane].length >= maxQueued) {
      observeCapacityRejection(lane);
      res.setHeader("Retry-After", "3");
      res.status(503).json({
        error: "当前请求较多，请稍后重试",
        code: "CAPACITY_EXCEEDED",
        lane,
        retryAfter: 3,
      });
      return;
    }

    const waiter = {} as CapacityWaiter;
    const cancel = () => {
      if (waiter.dispatched) return;
      if (removeWaiter(lane, waiter)) clearTimeout(waiter.timer);
    };
    Object.assign(waiter, {
      req,
      res,
      next,
      dispatched: false,
      timer: setTimeout(() => {
        if (!removeWaiter(lane, waiter) || res.headersSent || res.destroyed) return;
        observeCapacityRejection(lane);
        res.setHeader("Retry-After", "3");
        res.status(503).json({
          error: "当前排队请求较多，请稍后重试",
          code: "CAPACITY_QUEUE_TIMEOUT",
          lane,
          retryAfter: 3,
        });
      }, maxWaitMs),
    });
    waiter.timer.unref?.();
    waiters[lane].push(waiter);
    publishQueue(lane);
    req.once("aborted", cancel);
    res.once("close", cancel);
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
  for (const lane of Object.keys(waiters) as CapacityLane[]) {
    for (const waiter of waiters[lane]) clearTimeout(waiter.timer);
    waiters[lane] = [];
    queueLimits[lane] = 0;
    publishQueue(lane);
  }
  states = createStates();
  for (const [lane, limit] of Object.entries(limits || {})) {
    if (limit && limit > 0) states[lane as CapacityLane].limit = limit;
  }
  for (const [lane, laneState] of Object.entries(states)) {
    setCapacityLane(lane, laneState.active, laneState.limit);
  }
}
