import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "fs";
import path from "path";

const DEFAULT_JIUWENBOX_RUNTIME_GROUP = "jiuwenswarm";

export type SkillRuntimePermissionOptions = {
  runtimeGid?: number | null;
};

function resolveRuntimeGid(): number | null {
  const configured = String(
    process.env.JIUWENBOX_RUNTIME_GROUP || DEFAULT_JIUWENBOX_RUNTIME_GROUP,
  ).trim();
  if (!configured) return null;
  if (/^\d+$/.test(configured)) return Number(configured);

  try {
    for (const line of readFileSync("/etc/group", "utf8").split(/\r?\n/)) {
      const fields = line.split(":");
      if (fields[0] !== configured || !/^\d+$/.test(fields[2] || "")) continue;
      return Number(fields[2]);
    }
  } catch {}
  return null;
}

/** Make a physical Skill copy readable by JiuwenBox without making it world-readable. */
export function normalizeSkillRuntimePermissions(
  rootDir: string,
  options: SkillRuntimePermissionOptions = {},
): void {
  if (!existsSync(rootDir)) return;
  const runtimeGid = options.runtimeGid === undefined ? resolveRuntimeGid() : options.runtimeGid;

  const visit = (target: string): void => {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`runtime skill must not contain symbolic links: ${path.relative(rootDir, target) || "."}`);
    }
    if (runtimeGid !== null) chownSync(target, stats.uid, runtimeGid);
    if (stats.isDirectory()) {
      chmodSync(target, 0o750);
      for (const entry of readdirSync(target)) visit(path.join(target, entry));
      return;
    }
    if (stats.isFile()) chmodSync(target, stats.mode & 0o111 ? 0o750 : 0o640);
  };

  visit(rootDir);
}
