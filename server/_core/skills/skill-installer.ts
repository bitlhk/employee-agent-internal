import { existsSync, lstatSync, readdirSync } from "fs";
import { cp, mkdir, mkdtemp, rename, rm } from "fs/promises";
import { randomUUID } from "node:crypto";
import os from "os";
import path from "path";
import { normalizeSkillRuntimePermissions } from "./skill-runtime-permissions";
import { safeExtractZip } from "./skill-zip-extract";

export type SkillInstallKind = "directory" | "zip";

export type SkillInstallResult = {
  kind: SkillInstallKind;
  sourceRoot: string;
};

export interface SkillInstaller {
  installFromSource(
    sourcePath: string,
    runtimePath: string
  ): Promise<SkillInstallResult>;
  canInstall(sourcePath: string): boolean;
}



function isZipSource(sourcePath: string): boolean {
  const ext = path.extname(sourcePath).toLowerCase();
  return ext === ".zip" || ext === ".skill";
}

function hasSkillManifest(dir: string): boolean {
  return existsSync(path.join(dir, "SKILL.md"));
}

function findSkillRoot(dir: string, depth = 0): string | null {
  if (hasSkillManifest(dir)) return dir;
  if (depth >= 3) return null;
  const candidates: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findSkillRoot(path.join(dir, entry.name), depth + 1);
    if (found) candidates.push(found);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      "zip contains multiple skill roots; please upload one skill package at a time"
    );
  }
  return null;
}

function assertPhysicalDirectoryTree(rootDir: string): void {
  const rootStats = lstatSync(rootDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("skill source must be a physical directory");
  }
  const walk = (dir: string, relativeDir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(
          `skill source must not contain symbolic links: ${relativePath}`
        );
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relativePath);
    }
  };
  walk(rootDir, "");
}


export class FileSystemSkillInstaller implements SkillInstaller {
  canInstall(sourcePath: string): boolean {
    if (!existsSync(sourcePath)) return false;
    try {
      const stat = lstatSync(sourcePath);
      return (
        !stat.isSymbolicLink() &&
        (stat.isDirectory() || isZipSource(sourcePath))
      );
    } catch {
      return false;
    }
  }

  async installFromSource(
    sourcePath: string,
    runtimePath: string
  ): Promise<SkillInstallResult> {
    if (!existsSync(sourcePath)) throw new Error("skill source is missing");
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink())
      throw new Error("skill source must not be a symbolic link");
    if (stat.isDirectory()) assertPhysicalDirectoryTree(sourcePath);
    if (path.resolve(sourcePath) === path.resolve(runtimePath)) {
      if (!stat.isDirectory())
        throw new Error("an archive cannot install over itself");
      assertPhysicalDirectoryTree(sourcePath);
      normalizeSkillRuntimePermissions(runtimePath);
      return { kind: "directory", sourceRoot: sourcePath };
    }

    const operationId = randomUUID();
    const stagingPath = `${runtimePath}.staging-${operationId}`;
    const backupPath = `${runtimePath}.backup-${operationId}`;
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await rm(stagingPath, { recursive: true, force: true });
    await rm(backupPath, { recursive: true, force: true });

    let result: SkillInstallResult;
    try {
      if (stat.isDirectory()) {
        await cp(sourcePath, stagingPath, { recursive: true });
        normalizeSkillRuntimePermissions(stagingPath);
        result = { kind: "directory", sourceRoot: sourcePath };
      } else {
        if (!isZipSource(sourcePath)) {
          throw new Error(
            "unsupported skill source; expected directory or .zip package"
          );
        }

        const tempRoot = await mkdtemp(
          path.join(os.tmpdir(), "lingxia-skill-")
        );
        try {
          await safeExtractZip(sourcePath, tempRoot);
          const skillRoot = findSkillRoot(tempRoot);
          if (!skillRoot)
            throw new Error("zip package does not contain SKILL.md");
          await cp(skillRoot, stagingPath, { recursive: true });
          normalizeSkillRuntimePermissions(stagingPath);
          result = { kind: "zip", sourceRoot: skillRoot };
        } finally {
          await rm(tempRoot, { recursive: true, force: true });
        }
      }

      if (existsSync(runtimePath)) await rename(runtimePath, backupPath);
      try {
        await rename(stagingPath, runtimePath);
      } catch (error) {
        if (existsSync(backupPath) && !existsSync(runtimePath)) {
          await rename(backupPath, runtimePath);
        }
        throw error;
      }
      await rm(backupPath, { recursive: true, force: true });
      return result;
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      if (existsSync(backupPath) && !existsSync(runtimePath)) {
        await rename(backupPath, runtimePath);
      }
      throw error;
    }
  }
}

export const skillInstaller = new FileSystemSkillInstaller();
