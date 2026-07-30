import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

export function writeJsonFileAtomicSync(
  targetPath: string,
  value: unknown,
  mode = 0o600,
): void {
  const directory = path.dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode,
    });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}
