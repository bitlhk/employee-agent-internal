import { createHash } from "crypto";
import express from "express";
import { createReadStream, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { sdk } from "./sdk";
import { getClawByAdoptId } from "../db";
import {
  createKnowledgeDocumentRecord,
  deleteKnowledgeDocumentRecord,
  findKnowledgeDocumentByHash,
  getAccessibleKnowledgeBase,
  getKnowledgeDocumentByPublicId,
} from "../db";
import {
  KNOWLEDGE_EXTENSIONS,
  knowledgeDocumentStoragePath,
  knowledgeExtension,
  knowledgeMimeType,
  removeKnowledgeDocumentFiles,
  resolveKnowledgeStoragePath,
  safeKnowledgeFilename,
} from "./knowledge-storage";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";
import { queueKnowledgeIndex } from "./knowledge-service";

const MAX_UPLOAD_BYTES = Math.max(1, Math.min(Number(process.env.KNOWLEDGE_MAX_UPLOAD_BYTES || 50 * 1024 * 1024), 50 * 1024 * 1024));

async function routeIdentity(req: express.Request, res: express.Response, adoptId: string) {
  try {
    const user = await sdk.authenticateRequest(req);
    const claw = await getClawByAdoptId(adoptId);
    if (!claw || Number(claw.userId) !== Number(user.id)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return null;
    }
    return { user, claw, userId: Number(user.id), groupId: Number(user.groupId || 0), roleTemplate: String(claw.roleTemplate || "general-assistant") };
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
}

async function routeBase(req: express.Request, res: express.Response, adoptId: string, publicId: string) {
  const actor = await routeIdentity(req, res, adoptId);
  if (!actor) return null;
  const base = await getAccessibleKnowledgeBase({ publicId, ...actor });
  if (!base) {
    res.status(404).json({ error: "knowledge base not found" });
    return null;
  }
  return { ...actor, base };
}

export function registerKnowledgeRoutes(app: express.Express): void {
  app.post("/api/knowledge/documents/upload", async (req, res) => {
    let temporaryPath = "";
    try {
      const body = req.body || {};
      const adoptId = String(body.adoptId || "").trim();
      const knowledgeBaseId = String(body.knowledgeBaseId || "").trim();
      const filename = safeKnowledgeFilename(String(body.filename || "").trim());
      const contentBase64 = String(body.contentBase64 || "");
      if (!adoptId || !knowledgeBaseId || !filename || !contentBase64) return res.status(400).json({ error: "missing upload fields" });
      const access = await routeBase(req, res, adoptId, knowledgeBaseId);
      if (!access) return;
      if (access.base.ownerUserId !== access.userId) return res.status(403).json({ error: "只读知识库不能上传文档" });
      const extension = knowledgeExtension(filename);
      if (!KNOWLEDGE_EXTENSIONS.has(extension)) return res.status(400).json({ error: `暂不支持 .${extension || "unknown"} 文件` });
      const buffer = decodeBase64Strict(contentBase64);
      if (!buffer) return res.status(400).json({ error: "invalid base64" });
      if (buffer.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: "文档超过上传大小限制" });
      const contentCheck = validateUploadContent(extension, buffer);
      if (!contentCheck.ok) return res.status(400).json({ error: contentCheck.error });
      const malwareCheck = await scanUploadForMalware(buffer);
      if (!malwareCheck.ok) return res.status(400).json({ error: malwareCheck.error });
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const duplicate = await findKnowledgeDocumentByHash(access.base.id, sha256);
      if (duplicate) return res.status(409).json({ error: "相同内容的文档已经存在", documentId: duplicate.publicId });
      const documentPublicId = `doc_${nanoid(18)}`;
      const storage = knowledgeDocumentStoragePath(access.base.publicId, documentPublicId, filename);
      temporaryPath = `${storage.absolute}.upload`;
      writeFileSync(temporaryPath, buffer, { mode: 0o600 });
      renameSync(temporaryPath, storage.absolute);
      temporaryPath = "";
      const document = await createKnowledgeDocumentRecord({
        publicId: documentPublicId,
        knowledgeBaseId: access.base.id,
        name: filename,
        extension,
        mimeType: knowledgeMimeType(extension),
        storagePath: storage.relative,
        sizeBytes: buffer.length,
        sha256,
      });
      void queueKnowledgeIndex({ ...access.base, documentCount: access.base.documentCount + 1, status: "indexing" }).catch(() => {});
      return res.json({ ok: true, document: { ...document, storagePath: undefined, sha256: undefined } });
    } catch (error) {
      if (temporaryPath && existsSync(temporaryPath)) try { unlinkSync(temporaryPath); } catch {}
      return res.status(500).json({ error: error instanceof Error ? error.message : "upload failed" });
    }
  });

  app.get("/api/knowledge/documents/:documentId/content", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const knowledgeBaseId = String(req.query.knowledgeBaseId || "").trim();
      const access = await routeBase(req, res, adoptId, knowledgeBaseId);
      if (!access) return;
      const document = await getKnowledgeDocumentByPublicId(String(req.params.documentId || ""));
      if (!document || document.knowledgeBaseId !== access.base.id) return res.status(404).json({ error: "document not found" });
      const absolute = resolveKnowledgeStoragePath(document.storagePath);
      if (!absolute || !statSync(absolute).isFile()) return res.status(404).json({ error: "document file not found" });
      const download = String(req.query.download || "") === "1";
      res.setHeader("Content-Type", knowledgeMimeType(document.extension));
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(document.name))}`);
      createReadStream(absolute).pipe(res);
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "document read failed" });
    }
  });

  app.delete("/api/knowledge/documents/:documentId", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const knowledgeBaseId = String(req.query.knowledgeBaseId || "").trim();
      const access = await routeBase(req, res, adoptId, knowledgeBaseId);
      if (!access) return;
      if (access.base.ownerUserId !== access.userId) return res.status(403).json({ error: "只读知识库不能删除文档" });
      const document = await getKnowledgeDocumentByPublicId(String(req.params.documentId || ""));
      if (!document || document.knowledgeBaseId !== access.base.id) return res.status(404).json({ error: "document not found" });
      await deleteKnowledgeDocumentRecord(document.id, access.base.id);
      removeKnowledgeDocumentFiles(access.base.publicId, document.publicId);
      void queueKnowledgeIndex(access.base).catch(() => {});
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "document delete failed" });
    }
  });
}
