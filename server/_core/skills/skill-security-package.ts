import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import type { Skill } from "../../../shared/types/skill";

const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;
const FIXED_ZIP_TIME = new Date("1980-01-01T00:00:00.000Z");
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".venv", "dist"]);

export type SkillSecuritySubject = {
  file: Buffer;
  filename: string;
  fingerprint: string;
  sourcePath: string;
};

function sourceCandidate(skill: Skill): string | null {
  const candidates = [skill.source.sourcePath, skill.sync.runtimePath]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || null;
}

function collectDirectoryFiles(root: string): Array<{ relativePath: string; content: Buffer }> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  let totalBytes = 0;
  const walk = (current: string, base = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relativePath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile() || lstatSync(absolute).isSymbolicLink()) continue;
      const content = readFileSync(absolute);
      totalBytes += content.length;
      if (files.length + 1 > MAX_FILES) throw new Error("技能文件数量超过 500 个");
      if (totalBytes > MAX_BYTES) throw new Error("技能内容超过 50MB 限制");
      files.push({ relativePath: relativePath.replace(/\\/g, "/"), content });
    }
  };
  walk(root);
  if (!files.some(file => file.relativePath.toLowerCase() === "skill.md")) {
    throw new Error("技能目录缺少根级 SKILL.md");
  }
  return files;
}

function deterministicDirectoryZip(root: string): Buffer {
  const archive = new AdmZip();
  for (const item of collectDirectoryFiles(root)) {
    archive.addFile(item.relativePath, item.content, "", 0o100644 << 16);
    const entry = archive.getEntry(item.relativePath);
    if (entry) entry.header.time = FIXED_ZIP_TIME;
  }
  return archive.toBuffer();
}

export function buildSkillSecuritySubject(skill: Skill): SkillSecuritySubject {
  const sourcePath = sourceCandidate(skill);
  if (!sourcePath) throw new Error("技能源码与运行目录均不存在");
  const sourceStat = statSync(sourcePath);
  let file: Buffer;
  if (sourceStat.isDirectory()) {
    file = deterministicDirectoryZip(sourcePath);
  } else if (/\.(zip|skill)$/i.test(sourcePath)) {
    file = readFileSync(sourcePath);
  } else {
    throw new Error("技能来源不是目录或受支持的技能包");
  }
  return {
    file,
    filename: `${skill.id}.zip`,
    fingerprint: createHash("sha256").update(file).digest("hex"),
    sourcePath,
  };
}
