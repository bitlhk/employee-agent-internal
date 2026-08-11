import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../helpers";
import { writeJsonFileAtomicSync } from "../atomic-json-file";
import { withSerializedFileMutation } from "../serialized-file-mutation";

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
  writeJsonFileAtomicSync(skillPackageIndexPath(), rows);
}

export async function mutateSkillPackageIndex<T>(
  mutate: (rows: SkillPackageIndexRow[]) => { rows: SkillPackageIndexRow[]; value: T },
): Promise<T> {
  const indexPath = skillPackageIndexPath();
  return withSerializedFileMutation(indexPath, () => {
    const result = mutate(readSkillPackageIndex());
    writeSkillPackageIndex(result.rows);
    return result.value;
  });
}

export async function appendSkillPackageIndexRow(row: SkillPackageIndexRow): Promise<void> {
  await mutateSkillPackageIndex((rows) => ({
    rows: [
      ...rows.filter((current) => !(
        String(current.adoptId || "") === String(row.adoptId || "")
        && (
          (row.installedSkillId && String(current.installedSkillId || "") === String(row.installedSkillId))
          || (row.filename && String(current.filename || "") === String(row.filename))
        )
      )),
      row,
    ],
    value: undefined,
  }));
}

export async function removeSkillPackageIndexRows(adoptId: string, match: SkillPackageIndexMatch): Promise<SkillPackageIndexRow[]> {
  return mutateSkillPackageIndex((rows) => {
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
    return { rows: retained, value: removed };
  });
}
