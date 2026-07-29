import {
  observeBackgroundWorkerStop,
  setBackgroundWorkerState,
  type BackgroundWorkerName,
} from "./observability/metrics";
import { logError, logInfo, logWarn } from "./observability/logger";

export type BackgroundWorkerStop = () => void | Promise<void>;
export type BackgroundWorkerState = "running" | "stopping" | "stopped" | "failed";

type WorkerRecord = {
  name: BackgroundWorkerName;
  state: BackgroundWorkerState;
  startedAt: number;
  stoppedAt: number | null;
  stop: BackgroundWorkerStop;
  error: string | null;
};

const workers = new Map<BackgroundWorkerName, WorkerRecord>();

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 180);
}

export function startManagedWorker(name: BackgroundWorkerName, start: () => BackgroundWorkerStop): void {
  const existing = workers.get(name);
  if (existing?.state === "running" || existing?.state === "stopping") return;
  try {
    const record: WorkerRecord = {
      name,
      state: "running",
      startedAt: Date.now(),
      stoppedAt: null,
      stop: start(),
      error: null,
    };
    workers.set(name, record);
    setBackgroundWorkerState(name, "running");
    logInfo("background_worker.started", { worker: name });
  } catch (error) {
    workers.set(name, {
      name,
      state: "failed",
      startedAt: Date.now(),
      stoppedAt: Date.now(),
      stop: () => {},
      error: cleanError(error),
    });
    setBackgroundWorkerState(name, "failed");
    logError("background_worker.start_failed", error, { worker: name });
  }
}

export async function startManagedWorkerAsync(
  name: BackgroundWorkerName,
  start: () => Promise<BackgroundWorkerStop>,
): Promise<void> {
  const existing = workers.get(name);
  if (existing?.state === "running" || existing?.state === "stopping") return;
  try {
    const stop = await start();
    const record: WorkerRecord = {
      name,
      state: "running",
      startedAt: Date.now(),
      stoppedAt: null,
      stop,
      error: null,
    };
    workers.set(name, record);
    setBackgroundWorkerState(name, "running");
    logInfo("background_worker.started", { worker: name });
  } catch (error) {
    workers.set(name, {
      name,
      state: "failed",
      startedAt: Date.now(),
      stoppedAt: Date.now(),
      stop: () => {},
      error: cleanError(error),
    });
    setBackgroundWorkerState(name, "failed");
    logError("background_worker.start_failed", error, { worker: name });
  }
}

async function stopWorker(record: WorkerRecord, timeoutMs: number): Promise<void> {
  if (record.state !== "running") return;
  record.state = "stopping";
  setBackgroundWorkerState(record.name, "stopping");
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(record.stop),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("worker stop timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
    record.state = "stopped";
    record.stoppedAt = Date.now();
    setBackgroundWorkerState(record.name, "stopped");
    observeBackgroundWorkerStop(record.name, "success", Date.now() - startedAt);
  } catch (error) {
    record.state = "failed";
    record.error = cleanError(error);
    record.stoppedAt = Date.now();
    setBackgroundWorkerState(record.name, "failed");
    observeBackgroundWorkerStop(record.name, "error", Date.now() - startedAt);
    logWarn("background_worker.stop_failed", { worker: record.name, error: record.error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function stopManagedWorkers(timeoutMs = 5_000): Promise<void> {
  const running = Array.from(workers.values()).filter((worker) => worker.state === "running").reverse();
  await Promise.all(running.map((worker) => stopWorker(worker, timeoutMs)));
  logInfo("background_workers.stopped", { count: running.length });
}

export function getBackgroundWorkerSnapshot(): Array<{
  name: BackgroundWorkerName;
  state: BackgroundWorkerState;
  uptimeMs: number;
  error: string | null;
}> {
  const now = Date.now();
  return Array.from(workers.values()).map((worker) => ({
    name: worker.name,
    state: worker.state,
    uptimeMs: Math.max(0, (worker.stoppedAt || now) - worker.startedAt),
    error: worker.error,
  }));
}

export function resetBackgroundWorkersForTests(): void {
  workers.clear();
}
