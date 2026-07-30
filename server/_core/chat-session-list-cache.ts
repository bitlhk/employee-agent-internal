import { createBoundedAsyncCache } from "./bounded-async-cache";

type ChatSessionListCacheOptions = {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
};

export function createChatSessionListCache<T>(
  options: ChatSessionListCacheOptions = {},
) {
  return createBoundedAsyncCache<T>(options);
}
