const mutationTails = new Map<string, Promise<void>>();

/**
 * Serializes read-modify-write operations for one file inside this process.
 * Production currently runs one EA process; multi-instance deployments must
 * move this state to a transactional store or a distributed lock.
 */
export async function withSerializedFileMutation<T>(
  filePath: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const previous = mutationTails.get(filePath) || Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  mutationTails.set(filePath, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (mutationTails.get(filePath) === tail) mutationTails.delete(filePath);
  }
}

export function serializedFileMutationCountForTests(): number {
  return mutationTails.size;
}
