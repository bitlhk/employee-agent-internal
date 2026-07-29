import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../helpers";

export type SkillPackageIndexRow = Record<string, unknown> & {
  adoptId?: string;
  filename?: string;
  path?: string;
  sha256?: string;
  installedSkillId?: string;
  displayName?: string;
  displayDescription?: string;
  manifest?: Record<string, unknown>;
};

export type SkillPackageIndexMatch = {
  skillId?: string;
  sourcePath?: string;
  sha256?: string;
  filename?: string;
};

export function skillPackageIndexPath(): string {
  return path.join(APP_ROOT, "data", "skill-packages", "index.json");
}

export function readSkillPackageIndex(): SkillPackageIndexRow[] {
  const indexPath = skillPackageIndexPath();
  if (!existsSync(indexPath)) return [];
  try {
    const raw = String(readFileSync(indexPath, "utf-8") || "[]").trim();
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is SkillPackageIndexRow => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  } catch {
    return [];
  }
}

export function writeSkillPackageIndex(rows: SkillPackageIndexRow[]): void {
  const indexPath = skillPackageIndexPath();
  mkdirSync(path.dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(rows, null, 2), "utf-8");
}

export function removeSkillPackageIndexRows(adoptId: string, match: SkillPackageIndexMatch): SkillPackageIndexRow[] {
  const rows = readSkillPackageIndex();
  const removed: SkillPackageIndexRow[] = [];
  const retained = rows.filter((row) => {
    if (String(row.adoptId || "") !== adoptId) return true;
    const matches = (
      (match.skillId && String(row.installedSkillId || "") === match.skillId)
      || (match.sourcePath && String(row.path || "") === match.sourcePath)
      || (match.sha256 && String(row.sha256 || "") === match.sha256)
      || (match.filename && String(row.filename || "") === match.filename)
    );
    if (matches) removed.push(row);
    return !matches;
  });
  if (removed.length > 0) writeSkillPackageIndex(retained);
  return removed;
}
