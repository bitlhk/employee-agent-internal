import { BoundedWorkQueue, WorkQueueFullError, type WorkQueueSnapshot } from "../bounded-work-queue";
import {
  beginSkillWork,
  observeSkillWorkRejection,
  setSkillWorkQueue,
} from "../observability/metrics";

export type SkillWorkLane = "scan" | "install";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function createQueue(lane: SkillWorkLane): BoundedWorkQueue {
  const scan = lane === "scan";
  const concurrency = boundedInteger(
    process.env[scan ? "EA_SKILL_SCAN_CONCURRENCY" : "EA_SKILL_INSTALL_CONCURRENCY"],
    scan ? 4 : 2,
    1,
    32,
  );
  const maxQueued = boundedInteger(
    process.env[scan ? "EA_SKILL_SCAN_MAX_QUEUE" : "EA_SKILL_INSTALL_MAX_QUEUE"],
    100,
    0,
    1_000,
  );
  return new BoundedWorkQueue(lane, concurrency, maxQueued, (snapshot) => {
    setSkillWorkQueue({ lane, ...snapshot });
  });
}

const queues: Record<SkillWorkLane, BoundedWorkQueue> = {
  scan: createQueue("scan"),
  install: createQueue("install"),
};

export async function runSkillWork<T>(lane: SkillWorkLane, task: () => Promise<T> | T): Promise<T> {
  const finish = beginSkillWork(lane);
  try {
    const result = await queues[lane].run(task);
    finish("success");
    return result;
  } catch (error) {
    if (error instanceof WorkQueueFullError) observeSkillWorkRejection(lane);
    finish("error");
    throw error;
  }
}

export function skillWorkQueueSnapshots(): Record<SkillWorkLane, WorkQueueSnapshot> {
  return { scan: queues.scan.snapshot(), install: queues.install.snapshot() };
}

export { WorkQueueFullError };
