import { createHash } from "crypto";
import { writeFileSync } from "fs";
import path from "path";

import { EA_ARTIFACT_SCHEMA, type AgentTaskArtifact } from "@shared/agent-artifact";
import type { A2AAgentConnection, A2ARemoteArtifact } from "./a2a-expert-client";
import { resolveWorkspaceWritePath } from "./file-path-security";
import { resolveTrustedLocalProfileA2ATarget } from "./local-profile-a2a-proxy";
import { safeAgentRequest } from "./safe-agent-http";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";

const MAX_ARTIFACTS = 20;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  "md", "txt", "csv", "json", "yaml", "yml", "xml", "log",
  "pdf", "docx", "xls", "xlsx", "pptx",
  "png", "jpg", "jpeg", "gif", "svg", "webp",
  "html", "htm", "zip", "tar", "gz",
  "mp3", "wav", "m4a", "aac", "mp4", "webm", "ogg",
]);

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function safeFilename(value: unknown): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 200);
}

function extensionFor(name: string, mimeType: string): string {
  const extension = path.extname(name).slice(1).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(extension)) return extension;
  return MIME_EXTENSIONS[String(mimeType || "").split(";", 1)[0].trim().toLowerCase()] || "";
}

function uniqueFilename(name: string, extension: string, used: Set<string>): string {
  const initial = safeFilename(name) || `artifact.${extension}`;
  const base = path.basename(initial, path.extname(initial)).slice(0, 160) || "artifact";
  const suffix = `.${extension}`;
  let candidate = initial.toLowerCase().endsWith(suffix) ? initial : `${base}${suffix}`;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${index}${suffix}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function readResponseBuffer(response: Awaited<ReturnType<typeof safeAgentRequest>>): Promise<Buffer> {
  const contentLength = Number(response.headers["content-length"] || 0);
  if (contentLength > MAX_ARTIFACT_BYTES) {
    response.body.destroy();
    throw new Error("artifact exceeds the maximum file size");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_ARTIFACT_BYTES) {
      response.body.destroy(new Error("artifact response is too large"));
      throw new Error("artifact exceeds the maximum file size");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

async function artifactBuffer(
  artifact: A2ARemoteArtifact,
  connection: A2AAgentConnection,
): Promise<Buffer> {
  if (artifact.bytesBase64) {
    const decoded = decodeBase64Strict(artifact.bytesBase64);
    if (!decoded) throw new Error("artifact contains invalid base64 data");
    if (decoded.length > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the maximum file size");
    return decoded;
  }
  if (!artifact.uri) throw new Error("artifact does not contain file data");
  const headers: Record<string, string> = { Accept: artifact.mimeType || "application/octet-stream" };
  if (connection.apiToken && sameOrigin(artifact.uri, connection.apiUrl)) {
    headers.Authorization = `Bearer ${connection.apiToken}`;
  }
  const target = resolveTrustedLocalProfileA2ATarget(artifact.uri);
  const response = await safeAgentRequest(target.url, {
    method: "GET",
    headers,
    timeoutMs: 60_000,
    allowPrivate: target.allowPrivate,
  });
  if (response.status < 200 || response.status >= 300) {
    response.body.resume();
    throw new Error(`artifact download failed with HTTP ${response.status}`);
  }
  return readResponseBuffer(response);
}

export async function materializeA2AArtifacts(args: {
  taskId: string;
  workspaceDir: string;
  connection: A2AAgentConnection;
  artifacts?: A2ARemoteArtifact[];
}): Promise<AgentTaskArtifact[]> {
  if (!/^agt_[A-Za-z0-9]{8,64}$/.test(args.taskId)) throw new Error("task id is invalid");
  const sources = (args.artifacts || [])
    .filter((artifact) => artifact.role !== "internal")
    .slice(0, MAX_ARTIFACTS);
  const usedNames = new Set<string>();
  const saved: AgentTaskArtifact[] = [];
  let totalBytes = 0;

  for (const [index, source] of sources.entries()) {
    try {
      const extension = extensionFor(source.name, source.mimeType);
      if (!extension) throw new Error("artifact type is not supported");
      if (source.size && source.size > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the maximum file size");
      const filename = uniqueFilename(source.name, extension, usedNames);
      const buffer = await artifactBuffer(source, args.connection);
      if (totalBytes + buffer.length > MAX_TOTAL_BYTES) throw new Error("task artifacts exceed the total size limit");
      const validation = validateUploadContent(extension, buffer);
      if (!validation.ok) throw new Error(validation.error);
      const malwareScan = await scanUploadForMalware(buffer);
      if (!malwareScan.ok) throw new Error(malwareScan.error);
      const relativePath = `agent-artifacts/${args.taskId}/${filename}`;
      const target = resolveWorkspaceWritePath(args.workspaceDir, relativePath);
      if (!target) throw new Error("artifact path is outside the workspace");
      writeFileSync(target, buffer);
      totalBytes += buffer.length;
      const rawId = String(source.id || "").trim();
      const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawId)
        ? rawId
        : `artifact-${index + 1}`;
      saved.push({
        schema: EA_ARTIFACT_SCHEMA,
        id,
        name: filename,
        mimeType: source.mimeType || "application/octet-stream",
        size: buffer.length,
        role: source.role === "preview" || source.role === "supporting" ? source.role : "primary",
        path: relativePath,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        ...(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(source.previewOf || ""))
          ? { previewOf: String(source.previewOf) }
          : {}),
      });
    } catch (error) {
      console.warn("[AGENT-ARTIFACT] skipped", {
        taskId: args.taskId,
        name: String(source.name || "").slice(0, 200),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return saved;
}
