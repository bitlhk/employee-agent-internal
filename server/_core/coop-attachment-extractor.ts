/**
 * coop-attachment-extractor.ts — 协作汇总用的附件提取
 *
 * A 阶段（演示前）：只列附件清单（name + size），LLM 知道存在但不读内容
 * B 阶段（演示后）：opts.extractText=true 时解析 docx/pdf/txt 提取摘要喂给 LLM
 *   - 装包：mammoth (docx) / pdf-parse (pdf)
 *   - 加 maxCharsPerFile 截断防超 token
 */
import { existsSync, statSync, readFileSync } from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { lxCoopFiles } from "../../drizzle/schema";
import { COOP_FILES_DIR } from "../db/coop-files";
import { getDb } from "../db/connection";

export type Attachment = {
  name: string;
  url: string;
  source?: "chat" | "task" | "agent_workspace";
  size?: number;
  fileId?: number;
};

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const COOP_UPLOAD_DIR = `${APP_ROOT}/data/coop-uploads`;

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 从 attachment.url 解析本地文件路径
 * url 格式：/api/coop/file?sessionId=cs-xxx&requestId=N&file=ts-name.ext
 * 本地路径：/data/coop-uploads/{sessionId}/{requestId}/{file}
 */
async function resolveLocalPath(att: Attachment): Promise<string | null> {
  try {
    const fileId = Number(att.fileId || String(att.url || "").match(/\/api\/coop\/files\/(\d+)/)?.[1] || 0);
    if (fileId > 0) {
      const db = await getDb();
      if (!db) return null;
      const rows = await db.select().from(lxCoopFiles).where(eq(lxCoopFiles.id, fileId)).limit(1);
      const row = rows[0];
      if (!row) return null;
      const fp = path.resolve(COOP_FILES_DIR, row.storedPath);
      const root = path.resolve(COOP_FILES_DIR);
      return fp.startsWith(root + path.sep) && existsSync(fp) ? fp : null;
    }
    const u = new URL(att.url, "http://placeholder");
    const sid = u.searchParams.get("sessionId");
    const rid = u.searchParams.get("requestId");
    const f = u.searchParams.get("file");
    if (!sid || !rid || !f) return null;
    const fp = path.join(COOP_UPLOAD_DIR, sid, rid, f);
    return existsSync(fp) ? fp : null;
  } catch {
    return null;
  }
}

/**
 * B 阶段（演示后）：解析文件文本内容
 * 演示前 A 阶段：只识别 .txt / .md，docx/pdf 留 TODO
 */
async function extractFileText(att: Attachment, maxChars = 3000): Promise<string | null> {
  const fp = await resolveLocalPath(att);
  if (!fp) return null;

  const ext = path.extname(att.name).toLowerCase();
  const stat = statSync(fp);
  // 大于 5MB 的不解析（避免 OOM）
  if (stat.size > 5 * 1024 * 1024) return null;

  // A 阶段只解析纯文本类型；B 阶段加 mammoth (docx) / pdf-parse (pdf)
  if (ext === ".txt" || ext === ".md" || ext === ".csv" || ext === ".json") {
    try {
      const text = readFileSync(fp, "utf-8");
      return text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
    } catch {
      return null;
    }
  }
  // TODO B 阶段:
  //   if (ext === ".docx") { const m = await import("mammoth"); ... }
  //   if (ext === ".pdf") { const p = await import("pdf-parse"); ... }
  //   if (ext === ".pptx") { const px = await import("officeparser"); ... }
  return null;
}

/**
 * 拼装附件块给 LLM consolidate prompt 用
 *
 * 用法：
 *   const block = await buildAttachmentsBlock(atts);                  // A 阶段（默认）
 *   const block = await buildAttachmentsBlock(atts, { extractText: true }); // B 阶段
 */
export async function buildAttachmentsBlock(
  attachments: Attachment[] | undefined | null,
  opts?: { extractText?: boolean; maxCharsPerFile?: number }
): Promise<string> {
  if (!attachments?.length) return "";

  const lines: string[] = [`\n**附件清单（共 ${attachments.length} 个）**：`];
  for (const att of attachments) {
    const sizeStr = formatSize(att.size);
    let line = `- 📎 **${att.name}**`;
    if (sizeStr) line += ` (${sizeStr})`;
    if (att.source === "task") line += " · 🤖 task 产物";
    lines.push(line);

    if (opts?.extractText) {
      const text = await extractFileText(att, opts.maxCharsPerFile || 3000);
      if (text) {
        lines.push(`  内容摘要：\n  > ${text.replace(/\n/g, "\n  > ")}`);
      }
    }
  }
  if (!opts?.extractText) {
    lines.push(`\n（注：附件内容未自动提取，请在汇总中**显式提及**这些文件供发起人下载查看，但不要凭空编造附件里的具体内容。）`);
  }
  return lines.join("\n");
}
