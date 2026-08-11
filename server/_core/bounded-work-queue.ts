export class WorkQueueFullError extends Error {
  readonly code = "WORK_QUEUE_FULL";

  constructor(readonly queue: string, readonly retryAfterSeconds: number) {
    super(`${queue} queue is full`);
    this.name = "WorkQueueFullError";
  }
}

export type WorkQueueSnapshot = {
  name: string;
  active: number;
  queued: number;
  concurrency: number;
  maxQueued: number;
};

type PendingWork<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class BoundedWorkQueue {
  private active = 0;
  private readonly pending: PendingWork<unknown>[] = [];

  constructor(
    readonly name: string,
    readonly concurrency: number,
    readonly maxQueued: number,
    private readonly onSnapshot?: (snapshot: WorkQueueSnapshot) => void,
    private readonly retryAfterSeconds = 3,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("queue concurrency must be positive");
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error("queue maxQueued must be non-negative");
    this.publish();
  }

  snapshot(): WorkQueueSnapshot {
    return {
      name: this.name,
      active: this.active,
      queued: this.pending.length,
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
    };
  }

  run<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.active >= this.concurrency && this.pending.length >= this.maxQueued) {
      throw new WorkQueueFullError(this.name, this.retryAfterSeconds);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task: async () => task(),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.publish();
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const work = this.pending.shift()!;
      this.active += 1;
      this.publish();
      void work.task()
        .then(work.resolve, work.reject)
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.publish();
          this.drain();
        });
    }
  }

  private publish(): void {
    this.onSnapshot?.(this.snapshot());
  }
}
