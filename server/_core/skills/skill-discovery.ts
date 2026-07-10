import { existsSync, lstatSync, realpathSync, statSync } from "fs";
import path from "path";

function pathInside(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

export function generatedSkillDiscoveryExcludedRoots(openclawHome: string, extraRoots: string[] = []): string[] {
  return Array.from(new Set([
    path.join(openclawHome, "skill-market", "approved"),
    path.join(openclawHome, "skills-shared"),
    ...extraRoots,
  ])).filter((dir) => existsSync(dir)).map((dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  });
}

export function shouldDiscoverGeneratedRuntimeSkill(
  sourceDir: string,
  excludedRoots: string[],
): { ok: true } | { ok: false; reason: string } {
  try {
    const lst = lstatSync(sourceDir);
    if (lst.isSymbolicLink()) {
      return { ok: false, reason: "managed_or_shared_skill_link" };
    }

    const st = statSync(sourceDir);
    if (!st.isDirectory()) return { ok: false, reason: "not_directory" };

    const realSourceDir = realpathSync(sourceDir);
    if (excludedRoots.some((root) => pathInside(realSourceDir, root))) {
      return { ok: false, reason: "managed_or_shared_skill_source" };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e || "unreadable") };
  }
}

export function managedSkillPathReason(
  candidatePath: string | undefined,
  excludedRoots: string[],
): string | null {
  if (!candidatePath) return null;
  try {
    if (!existsSync(candidatePath)) return null;
    const realCandidate = realpathSync(candidatePath);
    const isManaged = excludedRoots.some((root) => pathInside(realCandidate, root));
    if (!isManaged) return null;
    const lst = lstatSync(candidatePath);
    return lst.isSymbolicLink()
      ? "managed_or_shared_skill_link"
      : "managed_or_shared_skill_source";
  } catch {
    return null;
  }
}
