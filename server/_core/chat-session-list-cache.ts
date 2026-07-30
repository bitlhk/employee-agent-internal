type ChatSessionListCacheOptions = {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
};

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

export function createChatSessionListCache<T>(
  options: ChatSessionListCacheOptions = {},
) {
  const ttlMs = Math.max(100, options.ttlMs ?? 2_500);
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(10, options.maxEntries ?? 500);
  const values = new Map<string, CachedValue<T>>();
  const inFlight = new Map<string, Promise<T>>();
  const keyVersions = new Map<string, number>();
  let clearGeneration = 0;

  function prune(currentTime: number): void {
    for (const [key, entry] of values) {
      if (entry.expiresAt <= currentTime) values.delete(key);
    }
    while (values.size > maxEntries) {
      const firstKey = values.keys().next().value;
      if (firstKey === undefined) break;
      values.delete(firstKey);
    }
  }

  return {
    getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
      const currentTime = now();
      const cached = values.get(key);
      if (cached && cached.expiresAt > currentTime) return Promise.resolve(cached.value);
      if (cached) values.delete(key);

      const pending = inFlight.get(key);
      if (pending) return pending;

      const loadClearGeneration = clearGeneration;
      const loadKeyVersion = keyVersions.get(key) ?? 0;
      const task = loader()
        .then((value) => {
          if (
            clearGeneration === loadClearGeneration
            && (keyVersions.get(key) ?? 0) === loadKeyVersion
          ) {
            values.set(key, { expiresAt: now() + ttlMs, value });
            prune(now());
          }
          return value;
        })
        .finally(() => {
          if (inFlight.get(key) === task) inFlight.delete(key);
          if (!values.has(key) && !inFlight.has(key)) keyVersions.delete(key);
        });
      inFlight.set(key, task);
      return task;
    },
    invalidatePrefix(prefix: string): void {
      const matchingKeys = new Set([...values.keys(), ...inFlight.keys()]);
      for (const key of matchingKeys) {
        if (!key.startsWith(prefix)) continue;
        keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
        values.delete(key);
      }
    },
    clear(): void {
      clearGeneration += 1;
      values.clear();
      inFlight.clear();
      keyVersions.clear();
    },
  };
}
