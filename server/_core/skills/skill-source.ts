import { Buffer } from "buffer";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { sanitizeRelPath } from "../helpers";
import {
  MAX_SKILL_ZIP_UNCOMPRESSED_BYTES,
  normalizeSkillZipEntryName,
  validateSkillZipEnvelope,
  validateSkillZipMetadata,
} from "./skill-zip-security";

export const MAX_SKILL_PACKAGE_BYTES = 50 * 1024 * 1024;

export type SkillSourceFile = {
  path: string;
  content: string | Buffer;
};

export type ParsedSkillPackage = {
  skillId: string;
  displayName: string;
  description: string;
  manifest: any;
  mdMeta: { title: string; description: string };
  totalBytes: number;
  warnings: string[];
};

export function sanitizeSkillId(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/^[0-9]+-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated-skill";
}

export function parseSkillMarkdown(text: string): { name: string; title: string; description: string } {
  const lines = text.split(/\r?\n/);
  let i = 0;
  let frontmatterLines: string[] = [];
  if (lines[0]?.trim() === "---") {
    i = 1;
    const start = i;
    while (i < lines.length && lines[i]?.trim() !== "---") i++;
    frontmatterLines = lines.slice(start, i);
    if (i < lines.length) i++;
  }
  const frontmatterValue = (key: string): string => {
    const keyPattern = new RegExp(`^${key}:\\s*(.*)$`, "i");
    const index = frontmatterLines.findIndex((line) => keyPattern.test(line));
    if (index < 0) return "";
    let value = String(frontmatterLines[index]?.match(keyPattern)?.[1] || "").trim();
    if (value === "|" || value === ">") {
      const folded = value === ">";
      const block: string[] = [];
      for (let j = index + 1; j < frontmatterLines.length; j++) {
        const line = frontmatterLines[j] || "";
        if (line.trim() && !/^\s+/.test(line)) break;
        block.push(line.replace(/^\s+/, "").trimEnd());
      }
      value = folded ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    return value;
  };
  let title = "";
  let description = "";
  for (let j = i; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t.startsWith("#")) {
      title = t.replace(/^#+\s*/, "").trim();
      break;
    }
  }
  for (let j = i; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t && !t.startsWith("#") && !t.startsWith("---")) {
      description = t.replace(/\s+/g, " ").slice(0, 180);
      break;
    }
  }
  return {
    name: frontmatterValue("name"),
    title,
    description: frontmatterValue("description") || description,
  };
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""), "utf-8");
}

function textContent(content: string | Buffer, max = 20000): string {
  return toBuffer(content).toString("utf-8").slice(0, max);
}

export async function parseSkillPackageBuffer(fileBuf: Buffer, filename: string): Promise<ParsedSkillPackage> {
  validateSkillZipEnvelope(fileBuf);
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(fileBuf);
  const entries = zip.getEntries();
  validateSkillZipMetadata(entries.map((entry: any) => {
    const rawName = Buffer.isBuffer(entry.rawEntryName)
      ? entry.rawEntryName.toString("utf8")
      : String(entry.entryName || "");
    const unixMode = (Number(entry.attr || 0) >>> 16) & 0xffff;
    return {
      name: rawName,
      isDirectory: Boolean(entry.isDirectory),
      uncompressedSize: Number(entry.header?.size || 0),
      compressedSize: Number(entry.header?.compressedSize || 0),
      encrypted: Boolean(entry.header?.encrypted || (Number(entry.header?.flags || 0) & 1)),
      symbolicLink: (unixMode & 0xf000) === 0xa000,
      method: Number(entry.header?.method ?? 0),
    };
  }));

  const files: SkillSourceFile[] = [];
  let actualBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rawName = Buffer.isBuffer((entry as any).rawEntryName)
      ? (entry as any).rawEntryName.toString("utf8")
      : String(entry.entryName || "");
    const content = entry.getData();
    actualBytes += content.length;
    if (actualBytes > MAX_SKILL_ZIP_UNCOMPRESSED_BYTES) throw new Error("技能包实际解压后超过 50MB 限制");
    files.push({ path: normalizeSkillZipEntryName(rawName), content });
  }
  return parseSkillSourceFiles(files, filename);
}

export function parseSkillSourceFiles(files: SkillSourceFile[], fallbackName = "generated-skill"): ParsedSkillPackage {
  const errors: string[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  const normalized: Array<{ path: string; content: string | Buffer }> = [];

  if (!Array.isArray(files) || files.length === 0) errors.push("技能文件为空");
  if (files.length > 500) errors.push("文件数量超过 500 个");

  for (const file of files || []) {
    const rel = sanitizeRelPath(String(file?.path || ""));
    if (!rel) {
      errors.push(`存在非法路径: ${String(file?.path || "")}`);
      continue;
    }
    const buf = toBuffer(file.content);
    totalBytes += buf.length;
    normalized.push({ path: rel, content: file.content });
  }
  if (totalBytes > MAX_SKILL_PACKAGE_BYTES) errors.push("技能包超过 50MB 限制");

  const skillMd = normalized.find((file) => file.path.toLowerCase().endsWith("skill.md"));
  if (!skillMd) errors.push("技能缺少 SKILL.md");

  let manifest: any = {};
  const manifestFile = normalized.find((file) => /(^|\/)(manifest|skill)\.json$/i.test(file.path));
  if (manifestFile) {
    try {
      manifest = JSON.parse(textContent(manifestFile.content, 200000));
    } catch {
      errors.push("manifest.json 不是合法 JSON");
    }
  }

  const mdMeta = skillMd ? parseSkillMarkdown(textContent(skillMd.content, 16000)) : { name: "", title: "", description: "" };
  const fileStem = String(fallbackName || "generated-skill").replace(/\.(zip|skill)$/i, "");
  const skillMdTopDir = skillMd?.path.includes("/") ? skillMd.path.split("/")[0] : "";
  const topDirs = skillMdTopDir ? [skillMdTopDir] : [];
  const rawSkillId = String(manifest?.name || manifest?.id || mdMeta.name || (topDirs.length === 1 ? topDirs[0] : fileStem));
  const skillId = sanitizeSkillId(rawSkillId);
  const displayName = String(manifest?.displayName || manifest?.title || manifest?.name || mdMeta.title || mdMeta.name || fileStem).trim();
  const description = String(manifest?.description || mdMeta.description || "").replace(/\s+/g, " ").slice(0, 240);

  const dangerousPatterns = [
    { re: /\brm\s+-rf\s+\//i, label: "rm -rf /" },
    { re: /\beval\s*\(/i, label: "eval()" },
    { re: /\bchild_process\b/i, label: "child_process" },
    { re: /\bwget\s+https?:\/\//i, label: "wget 外部地址" },
    { re: /\bcurl\s+https?:\/\//i, label: "curl 外部地址" },
  ];
  for (const file of normalized) {
    if (!/\.(js|ts|py|sh|md|json|yaml|yml)$/i.test(file.path)) continue;
    const content = textContent(file.content);
    for (const item of dangerousPatterns) {
      if (item.re.test(content)) warnings.push(`${file.path}: ${item.label}`);
    }
  }

  if (!displayName || displayName.length < 2) errors.push("技能名称至少 2 个字");
  if (errors.length) throw new Error(errors.join("；"));

  return { skillId, displayName, description, manifest, mdMeta, totalBytes, warnings };
}

export function parseSkillSourceDirectory(sourceDir: string, fallbackName = "market-skill"): ParsedSkillPackage {
  const files: SkillSourceFile[] = [];

  function walk(dir: string, relBase = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        files.push({ path: rel, content: readFileSync(abs) });
      }
    }
  }

  const st = statSync(sourceDir);
  if (!st.isDirectory()) throw new Error("skill source is not a directory");
  walk(sourceDir);
  return parseSkillSourceFiles(files, fallbackName);
}
