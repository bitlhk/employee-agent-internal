type SessionActivityToucherOptions = {
  intervalMs?: number;
  now?: () => number;
  update: (userId: number, signedInAt: Date) => Promise<void>;
  onError?: (error: unknown) => void;
};

const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_TOUCH_INTERVAL_MS = 60 * 1000;
const MAX_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRACKED_USERS = 10_000;

function configuredTouchInterval(): number {
  const requested = Number(
    process.env.SESSION_ACTIVITY_TOUCH_INTERVAL_MS ?? DEFAULT_TOUCH_INTERVAL_MS,
  );
  if (!Number.isFinite(requested)) return DEFAULT_TOUCH_INTERVAL_MS;
  return Math.min(
    MAX_TOUCH_INTERVAL_MS,
    Math.max(MIN_TOUCH_INTERVAL_MS, Math.floor(requested)),
  );
}

export function createSessionActivityToucher(options: SessionActivityToucherOptions) {
  const intervalMs = options.intervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const lastTouchedAt = new Map<number, number>();
  const inFlight = new Map<number, Promise<void>>();

  function prune(currentTime: number): void {
    if (lastTouchedAt.size <= MAX_TRACKED_USERS) return;
    const cutoff = currentTime - intervalMs * 2;
    for (const [userId, touchedAt] of lastTouchedAt) {
      if (touchedAt < cutoff && !inFlight.has(userId)) lastTouchedAt.delete(userId);
      if (lastTouchedAt.size <= MAX_TRACKED_USERS) break;
    }
  }

  return {
    touch(userId: number, signedInAt = new Date()): void {
      if (!Number.isInteger(userId) || userId <= 0 || inFlight.has(userId)) return;
      const currentTime = now();
      const previous = lastTouchedAt.get(userId);
      if (previous !== undefined && currentTime - previous < intervalMs) return;

      lastTouchedAt.set(userId, currentTime);
      const task = options.update(userId, signedInAt)
        .catch((error) => {
          if (lastTouchedAt.get(userId) === currentTime) lastTouchedAt.delete(userId);
          options.onError?.(error);
        })
        .finally(() => {
          if (inFlight.get(userId) === task) inFlight.delete(userId);
        });
      inFlight.set(userId, task);
      prune(currentTime);
    },
    clear(): void {
      lastTouchedAt.clear();
      inFlight.clear();
    },
  };
}

const sessionActivityToucher = createSessionActivityToucher({
  intervalMs: configuredTouchInterval(),
  update: async (userId, signedInAt) => {
    const db = await import("../db");
    await db.updateUser(userId, { lastSignedIn: signedInAt });
  },
  onError: (error) => {
    console.warn("[Auth] Failed to update session activity", String(error));
  },
});

export function touchAuthenticatedUserActivity(
  userId: number,
  signedInAt = new Date(),
): void {
  sessionActivityToucher.touch(userId, signedInAt);
}
