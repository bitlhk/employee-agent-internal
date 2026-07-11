import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import os from "os";
import path from "path";
import {
  MAX_SKILL_ZIP_COMPRESSION_RATIO,
  MAX_SKILL_ZIP_ENTRIES,
  MAX_SKILL_ZIP_PATH_BYTES,
  MAX_SKILL_ZIP_PATH_DEPTH,
  MAX_SKILL_ZIP_UNCOMPRESSED_BYTES,
} from "./skill-zip-security";

export type SkillInstallKind = "directory" | "zip";

export type SkillInstallResult = {
  kind: SkillInstallKind;
  sourceRoot: string;
};

export interface SkillInstaller {
  installFromSource(sourcePath: string, runtimePath: string): SkillInstallResult;
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
    throw new Error("zip contains multiple skill roots; please upload one skill package at a time");
  }
  return null;
}

function safeExtractZip(zipPath: string, destPath: string): void {
  const script = `
import os, stat, sys, zipfile
zip_path, dest = sys.argv[1], sys.argv[2]
max_entries, max_total, max_ratio, max_depth, max_path = map(int, sys.argv[3:])
base = os.path.realpath(dest)
with zipfile.ZipFile(zip_path) as z:
    members = z.infolist()
    if len(members) > max_entries:
        raise RuntimeError("zip contains too many entries")
    declared_total = 0
    seen = set()
    for member in members:
        name = member.filename.replace("\\\\", "/")
        parts = [part for part in name.split("/") if part and part != "."]
        if not name or name.startswith("/") or "\\x00" in name or ".." in parts or (parts and ":" in parts[0]):
            raise RuntimeError("zip entry has invalid path: " + name)
        if len(parts) > max_depth or len(name.encode("utf-8")) > max_path:
            raise RuntimeError("zip entry path exceeds limit: " + name)
        normalized = "/".join(parts)
        if normalized in seen:
            raise RuntimeError("zip contains duplicate path: " + normalized)
        seen.add(normalized)
        if member.flag_bits & 1:
            raise RuntimeError("encrypted zip entries are not allowed: " + name)
        mode = (member.external_attr >> 16) & 0xffff
        if stat.S_ISLNK(mode):
            raise RuntimeError("zip symbolic links are not allowed: " + name)
        if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise RuntimeError("unsupported zip compression method: " + name)
        if not member.is_dir():
            declared_total += member.file_size
            if declared_total > max_total:
                raise RuntimeError("zip uncompressed size exceeds limit")
            if member.file_size >= 1024 * 1024 and member.file_size / max(member.compress_size, 1) > max_ratio:
                raise RuntimeError("zip compression ratio exceeds limit: " + name)

    actual_total = 0
    for member in members:
        name = member.filename.replace("\\\\", "/")
        parts = [part for part in name.split("/") if part and part != "."]
        target = os.path.realpath(os.path.join(dest, *parts))
        if target != base and not target.startswith(base + os.sep):
            raise RuntimeError("zip entry escapes target directory: " + name)
        if member.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        written = 0
        with z.open(member, "r") as source, open(target, "xb") as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                actual_total += len(chunk)
                if written > member.file_size or actual_total > max_total:
                    raise RuntimeError("zip actual extracted size exceeds limit")
                output.write(chunk)
`;
  execFileSync("python3", [
    "-c", script, zipPath, destPath,
    String(MAX_SKILL_ZIP_ENTRIES),
    String(MAX_SKILL_ZIP_UNCOMPRESSED_BYTES),
    String(MAX_SKILL_ZIP_COMPRESSION_RATIO),
    String(MAX_SKILL_ZIP_PATH_DEPTH),
    String(MAX_SKILL_ZIP_PATH_BYTES),
  ], { stdio: "pipe" });
}

export class FileSystemSkillInstaller implements SkillInstaller {
  canInstall(sourcePath: string): boolean {
    if (!existsSync(sourcePath)) return false;
    try {
      const stat = statSync(sourcePath);
      return stat.isDirectory() || isZipSource(sourcePath);
    } catch {
      return false;
    }
  }

  installFromSource(sourcePath: string, runtimePath: string): SkillInstallResult {
    if (!existsSync(sourcePath)) throw new Error("skill source is missing");
    const stat = statSync(sourcePath);
    rmSync(runtimePath, { recursive: true, force: true });
    mkdirSync(path.dirname(runtimePath), { recursive: true });

    if (stat.isDirectory()) {
      cpSync(sourcePath, runtimePath, { recursive: true });
      return { kind: "directory", sourceRoot: sourcePath };
    }

    if (!isZipSource(sourcePath)) {
      throw new Error("unsupported skill source; expected directory or .zip package");
    }

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "lingxia-skill-"));
    try {
      safeExtractZip(sourcePath, tempRoot);
      const skillRoot = findSkillRoot(tempRoot);
      if (!skillRoot) throw new Error("zip package does not contain SKILL.md");
      cpSync(skillRoot, runtimePath, { recursive: true });
      return { kind: "zip", sourceRoot: skillRoot };
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export const skillInstaller = new FileSystemSkillInstaller();
