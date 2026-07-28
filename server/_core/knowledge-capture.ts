import { createHash } from "crypto";
import { rename, rm, writeFile } from "fs/promises";
import {
  createKnowledgeDocumentRecord,
  findKnowledgeDocumentByHash,
  type KnowledgeBaseRecord,
} from "../db";
import { stripEaInternalRuntimeContext } from "../../shared/ea-runtime-context";
import { stripExpertHandoffRuntimeMessage } from "../../shared/expert-handoff-context";
import { sanitizePublicRuntimePaths } from "../../shared/lib/public-runtime-path";
import { queueKnowledgeIndex } from "./knowledge-service";
import {
  knowledgeDocumentStoragePath,
  knowledgeExtension,
  knowledgeMimeType,
  removeKnowledgeDocumentFiles,
  safeKnowledgeFilename,
  writeKnowledgeDocumentSourceMetadata,
  type KnowledgeDocumentSourceMetadata,
} from "./knowledge-storage";
import { nanoid } from "nanoid";

const MAX_CAPTURE_TEXT_CHARS = 120_000;

export function normalizeCapturedKnowledgeText(value: unknown): string {
  return sanitizePublicRuntimePaths(
    stripExpertHandoffRuntimeMessage(stripEaInternalRuntimeContext(value)),
  ).trim().slice(0, MAX_CAPTURE_TEXT_CHARS);
}

export function normalizeCapturedKnowledgeTitle(value: unknown): string {
  return String(value || "")
    .replace(/^#+\s*/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 120);
}

export function buildCapturedKnowledgeMarkdown(input: {
  title: string;
  answer: string;
  question?: string;
  includeQuestion?: boolean;
  capturedAt?: Date;
}): string {
  const title = normalizeCapturedKnowledgeTitle(input.title) || "岗位智能体工作沉淀";
  const answer = normalizeCapturedKnowledgeText(input.answer);
  const question = input.includeQuestion ? normalizeCapturedKnowledgeText(input.question) : "";
  if (!answer) throw new Error("没有可沉淀的回复内容");
  const capturedAt = input.capturedAt || new Date();
  return [
    `# ${title}`,
    "",
    `> 来源：岗位智能体对话 · ${capturedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    ...(question ? ["", "## 本轮问题", "", question] : []),
    "",
    "## 沉淀内容",
    "",
    answer,
    "",
  ].join("\n");
}

export async function persistCapturedKnowledge(input: {
  base: KnowledgeBaseRecord;
  filename: string;
  content: Buffer;
  metadata: KnowledgeDocumentSourceMetadata;
}): Promise<{ document: Awaited<ReturnType<typeof createKnowledgeDocumentRecord>>; duplicate: boolean }> {
  const extension = knowledgeExtension(input.filename);
  if (!extension) throw new Error("知识文档缺少文件扩展名");
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const duplicate = await findKnowledgeDocumentByHash(input.base.id, sha256);
  if (duplicate) return { document: duplicate, duplicate: true };

  const documentPublicId = `doc_${nanoid(18)}`;
  const filename = safeKnowledgeFilename(input.filename);
  const storage = knowledgeDocumentStoragePath(input.base.publicId, documentPublicId, filename);
  const temporaryPath = `${storage.absolute}.capture`;
  try {
    await writeFile(temporaryPath, input.content, { mode: 0o600 });
    await rename(temporaryPath, storage.absolute);
    writeKnowledgeDocumentSourceMetadata(input.base.publicId, documentPublicId, input.metadata);
    const document = await createKnowledgeDocumentRecord({
      publicId: documentPublicId,
      knowledgeBaseId: input.base.id,
      name: filename,
      extension,
      mimeType: knowledgeMimeType(extension),
      storagePath: storage.relative,
      sizeBytes: input.content.length,
      sha256,
      classification: input.base.classification,
      authority: "personal",
      externalProcessingAllowed: input.base.externalProcessingAllowed,
    });
    void queueKnowledgeIndex({ ...input.base, status: "indexing", documentCount: input.base.documentCount + 1 }, "captured_knowledge").catch(() => {});
    return { document, duplicate: false };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    removeKnowledgeDocumentFiles(input.base.publicId, documentPublicId);
    throw error;
  }
}
