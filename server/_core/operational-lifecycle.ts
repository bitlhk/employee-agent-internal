import type { NextFunction, Request, Response } from "express";
import {
  observeServerDrain,
  setServerLifecycleState,
  setServerTrackedRequests,
  type ServerLifecycleState,
} from "./observability/metrics";
import { isLongLivedInternalMcpStreamRequest } from "./operational-capacity";

const DRAIN_RETRY_AFTER_SECONDS = 2;

let state: ServerLifecycleState = "starting";
let drainReason: string | null = null;
let activeRequests = 0;
let drainWaiters = new Set<() => void>();

setServerLifecycleState(state);
setServerTrackedRequests(activeRequests);

function notifyDrainWaiters(): void {
  if (activeRequests !== 0) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}

export function markServerReady(): void {
  if (state === "draining") return;
  state = "ready";
  setServerLifecycleState(state);
}

export function beginServerDrain(reason: string): boolean {
  if (state === "draining") return false;
  state = "draining";
  drainReason = reason.slice(0, 80);
  setServerLifecycleState(state);
  return true;
}

export function isServerDraining(): boolean {
  return state === "draining";
}

export function getServerLifecycleSnapshot(): {
  state: ServerLifecycleState;
  activeRequests: number;
  drainReason: string | null;
} {
  return { state, activeRequests, drainReason };
}

export function trackedRequestMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (state === "draining") {
    res.setHeader("Retry-After", String(DRAIN_RETRY_AFTER_SECONDS));
    res.setHeader("Connection", "close");
    res.status(503).json({
      error: "服务正在平滑重启，请稍后重试",
      code: "SERVER_DRAINING",
      retryAfter: DRAIN_RETRY_AFTER_SECONDS,
    });
    return;
  }

  // MCP GET streams remain open for the lifetime of a runtime client. They
  // are connections, not unfinished business requests, and must not prevent
  // graceful deploys from draining real in-flight work.
  if (isLongLivedInternalMcpStreamRequest(req)) {
    next();
    return;
  }

  activeRequests += 1;
  setServerTrackedRequests(activeRequests);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRequests = Math.max(0, activeRequests - 1);
    setServerTrackedRequests(activeRequests);
    notifyDrainWaiters();
  };
  res.once("finish", release);
  res.once("close", release);
  next();
}

export async function waitForRequestsToDrain(timeoutMs: number): Promise<boolean> {
  if (activeRequests === 0) {
    observeServerDrain("completed");
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  const drained = await new Promise<boolean>((resolve) => {
    const onDrained = () => {
      if (timer) clearTimeout(timer);
      drainWaiters.delete(onDrained);
      resolve(true);
    };
    drainWaiters.add(onDrained);
    timer = setTimeout(() => {
      drainWaiters.delete(onDrained);
      resolve(false);
    }, Math.max(0, timeoutMs));
    timer.unref();
  });
  observeServerDrain(drained ? "completed" : "timed_out");
  return drained;
}

export function resetServerLifecycleForTests(): void {
  state = "starting";
  drainReason = null;
  activeRequests = 0;
  drainWaiters.clear();
  setServerLifecycleState(state);
  setServerTrackedRequests(activeRequests);
}
