import path from "path";
import { existsSync, mkdirSync, realpathSync, rmSync, cpSync, readdirSync } from "fs";
import { expandHomePath, OPENCLAW_HOME, OPENCLAW_BASE_HOME } from "../helpers";

export const SKILL_STORE_ROOT = path.resolve(
  expandHomePath(process.env.SKILL_STORE || path.join(OPENCLAW_BASE_HOME, "skill-store"))
);

export function skillStorePath(...parts: string[]): string {
  return path.join(SKILL_STORE_ROOT, ...parts);
}

export function skillStoreMarketplaceDir(status?: "pending" | "approved" | "rejected" | "offline" | string): string {
  return status ? skillStorePath("marketplace", status) : skillStorePath("marketplace");
}

export function skillStoreUploadedDir(adoptId: string, skillId?: string): string {
  return skillId ? skillStorePath("uploaded", adoptId, skillId) : skillStorePath("uploaded", adoptId);
}

export function skillStoreGeneratedDir(adoptId: string, skillId?: string): string {
  return skillId ? skillStorePath("generated", adoptId, skillId) : skillStorePath("generated", adoptId);
}

export function legacySkillMarketDir(status?: string): string {
  return status ? path.join(OPENCLAW_HOME, "skill-market", status) : path.join(OPENCLAW_HOME, "skill-market");
}

export function legacySharedSkillsDir(): string {
  return path.join(OPENCLAW_HOME, "skills-shared");
}

export function skillSourceDirsForRuntime(): string[] {
  return [
    skillStoreMarketplaceDir("approved"),
    legacySkillMarketDir("approved"),
    legacySharedSkillsDir(),
  ].filter((dir, index, arr) => existsSync(dir) && arr.indexOf(dir) === index);
}

export function ensureSkillStoreDirs(): void {
  for (const dir of [
    skillStoreMarketplaceDir("pending"),
    skillStoreMarketplaceDir("approved"),
    skillStoreMarketplaceDir("rejected"),
    skillStoreMarketplaceDir("offline"),
    skillStorePath("uploaded"),
    skillStorePath("generated"),
    skillStorePath("archive"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function safeSkillStorePath(candidatePath: string): string {
  ensureSkillStoreDirs();
  const root = existsSync(SKILL_STORE_ROOT) ? realpathSync(SKILL_STORE_ROOT) : path.resolve(SKILL_STORE_ROOT);
  const resolved = path.resolve(candidatePath);
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (real === root || real.startsWith(`${root}${path.sep}`)) return real;
  }
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
  throw new Error("path is outside SKILL_STORE");
}

export function remapLegacySkillMarketPath(rawPath: string): string {
  const value = String(rawPath || "").trim();
  if (!value) return value;
  const marker = `${path.sep}.openclaw${path.sep}skill-market${path.sep}`;
  const idx = value.indexOf(marker);
  if (idx >= 0) {
    const rel = value.slice(idx + marker.length);
    const candidate = path.join(skillStoreMarketplaceDir(), rel);
    if (existsSync(candidate)) return candidate;
  }
  return value;
}

export function migrateLegacySkillMarketToStore(): { copied: number; skipped: number } {
  ensureSkillStoreDirs();
  let copied = 0;
  let skipped = 0;
  for (const status of ["pending", "approved", "rejected", "offline"]) {
    const oldDir = legacySkillMarketDir(status);
    const newDir = skillStoreMarketplaceDir(status);
    if (!existsSync(oldDir)) continue;
    mkdirSync(newDir, { recursive: true });
    for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const src = path.join(oldDir, entry.name);
      const dst = path.join(newDir, entry.name);
      if (existsSync(dst)) {
        skipped++;
        continue;
      }
      cpSync(src, dst, { recursive: true, dereference: false });
      copied++;
    }
  }
  return { copied, skipped };
}

export function removeSkillStorePath(candidatePath: string): void {
  const safePath = safeSkillStorePath(candidatePath);
  rmSync(safePath, { recursive: true, force: true });
}
