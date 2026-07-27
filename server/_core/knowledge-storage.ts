import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";

export const KNOWLEDGE_ROOT = path.resolve(process.env.KNOWLEDGE_STORAGE_ROOT || path.join(process.env.APP_ROOT || process.cwd(), "data", "knowledge"));
export const KNOWLEDGE_DOCUMENT_ROOT = path.join(KNOWLEDGE_ROOT, "documents");
export const KNOWLEDGE_TOKEN_PATH = path.join(KNOWLEDGE_ROOT, ".service-token");

const SAFE_ID_RE = /^(?:kb|doc)_[A-Za-z0-9_-]{8,56}$/;

export const KNOWLEDGE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "yaml", "yml", "pdf", "docx", "xlsx", "pptx"]);

const KNOWLEDGE_MIME_TYPES: Record<string, string> = {
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function knowledgeMimeType(extension: string): string {
  return KNOWLEDGE_MIME_TYPES[String(extension || "").toLowerCase()] || "application/octet-stream";
}

export function safeKnowledgeFilename(value: string): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 220);
}

export function knowledgeExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index < 0 ? "" : filename.slice(index + 1).toLowerCase();
}

export function ensureKnowledgeStorage(): void {
  mkdirSync(KNOWLEDGE_DOCUMENT_ROOT, { recursive: true, mode: 0o700 });
  try { chmodSync(KNOWLEDGE_ROOT, 0o700); } catch {}
}

export function knowledgeServiceToken(): string {
  ensureKnowledgeStorage();
  if (existsSync(KNOWLEDGE_TOKEN_PATH)) {
    const existing = readFileSync(KNOWLEDGE_TOKEN_PATH, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(KNOWLEDGE_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  try { chmodSync(KNOWLEDGE_TOKEN_PATH, 0o600); } catch {}
  return token;
}

export function knowledgeDocumentStoragePath(knowledgeBasePublicId: string, documentPublicId: string, filename: string): { absolute: string; relative: string } {
  if (!SAFE_ID_RE.test(knowledgeBasePublicId) || !SAFE_ID_RE.test(documentPublicId)) throw new Error("invalid knowledge storage id");
  const safeName = safeKnowledgeFilename(filename);
  if (!safeName) throw new Error("invalid knowledge filename");
  ensureKnowledgeStorage();
  const directory = path.join(KNOWLEDGE_DOCUMENT_ROOT, knowledgeBasePublicId, documentPublicId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const absolute = path.join(directory, safeName);
  return { absolute, relative: path.relative(KNOWLEDGE_ROOT, absolute).replace(/\\/g, "/") };
}

export function resolveKnowledgeStoragePath(relativePath: string): string | null {
  ensureKnowledgeStorage();
  const candidate = path.resolve(KNOWLEDGE_ROOT, String(relativePath || ""));
  const relative = path.relative(KNOWLEDGE_ROOT, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!existsSync(candidate)) return null;
  try {
    const rootReal = realpathSync(KNOWLEDGE_ROOT);
    const candidateReal = realpathSync(candidate);
    const realRelative = path.relative(rootReal, candidateReal);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
    return candidateReal;
  } catch {
    return null;
  }
}

export function removeKnowledgeBaseFiles(publicId: string): void {
  if (!SAFE_ID_RE.test(publicId)) return;
  rmSync(path.join(KNOWLEDGE_DOCUMENT_ROOT, publicId), { recursive: true, force: true });
  rmSync(path.join(KNOWLEDGE_ROOT, "indexes", publicId), { recursive: true, force: true });
}

export function removeKnowledgeDocumentFiles(publicId: string, documentPublicId: string): void {
  if (!SAFE_ID_RE.test(publicId) || !SAFE_ID_RE.test(documentPublicId)) return;
  rmSync(path.join(KNOWLEDGE_DOCUMENT_ROOT, publicId, documentPublicId), { recursive: true, force: true });
}
