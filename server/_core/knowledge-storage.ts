import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";

export const KNOWLEDGE_ROOT = path.resolve(process.env.KNOWLEDGE_STORAGE_ROOT || path.join(process.env.APP_ROOT || process.cwd(), "data", "knowledge"));
export const KNOWLEDGE_DOCUMENT_ROOT = path.join(KNOWLEDGE_ROOT, "documents");
export const KNOWLEDGE_TOKEN_PATH = path.join(KNOWLEDGE_ROOT, ".service-token");

const SAFE_ID_RE = /^(?:kb|doc)_[A-Za-z0-9_-]{8,56}$/;
const KNOWLEDGE_SOURCE_METADATA_FILE = ".source.json";

export type KnowledgeDocumentSourceMetadata = {
  type: "upload" | "chat" | "workspace";
  capturedAt: string;
  adoptId?: string;
  conversationId?: string;
  messageId?: string;
  modelId?: string;
  workspacePath?: string;
  captureMode?: "answer" | "turn";
};

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

function knowledgeDocumentDirectory(knowledgeBasePublicId: string, documentPublicId: string): string | null {
  if (!SAFE_ID_RE.test(knowledgeBasePublicId) || !SAFE_ID_RE.test(documentPublicId)) return null;
  return path.join(KNOWLEDGE_DOCUMENT_ROOT, knowledgeBasePublicId, documentPublicId);
}

export function writeKnowledgeDocumentSourceMetadata(
  knowledgeBasePublicId: string,
  documentPublicId: string,
  metadata: KnowledgeDocumentSourceMetadata,
): void {
  const directory = knowledgeDocumentDirectory(knowledgeBasePublicId, documentPublicId);
  if (!directory) throw new Error("invalid knowledge storage id");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, KNOWLEDGE_SOURCE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

export function readKnowledgeDocumentSourceMetadata(
  knowledgeBasePublicId: string,
  documentPublicId: string,
): KnowledgeDocumentSourceMetadata | null {
  const directory = knowledgeDocumentDirectory(knowledgeBasePublicId, documentPublicId);
  if (!directory) return null;
  const metadataPath = path.join(directory, KNOWLEDGE_SOURCE_METADATA_FILE);
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (!parsed || !["upload", "chat", "workspace"].includes(String(parsed.type || ""))) return null;
    return parsed as KnowledgeDocumentSourceMetadata;
  } catch {
    return null;
  }
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
