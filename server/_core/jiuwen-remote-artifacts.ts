import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JiuwenSessionArtifactFile } from "./jiuwen-session-artifacts";

const MAX_REMOTE_FILES = 20;
const MAX_REMOTE_FILE_BYTES = 50 * 1024 * 1024;
const REMOTE_ARTIFACT_ROOT = "enterprise-artifacts";

type RemoteFileCandidate = {
  name: string;
  size: number;
  url: URL;
};

function gatewayHttpOrigin(wsUrl: string): URL | null {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed;
  } catch {
    return null;
  }
}

function safeSegment(value: unknown, fallback: string, maxLength: number): string {
  const sanitized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/]/gu, "_")
    .trim()
    .replace(/^\.+$/u, "")
    .slice(0, maxLength);
  return sanitized || fallback;
}

function remoteFileCandidates(delta: unknown, wsUrl: string): RemoteFileCandidate[] {
  const origin = gatewayHttpOrigin(wsUrl);
  if (!origin) return [];
  const payload = delta && typeof delta === "object" ? delta as Record<string, unknown> : {};
  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  const files: RemoteFileCandidate[] = [];
  for (const rawFile of rawFiles.slice(0, MAX_REMOTE_FILES)) {
    const file = rawFile && typeof rawFile === "object" ? rawFile as Record<string, unknown> : {};
    const rawDownloadUrl = String(file.download_url || "").trim();
    if (!rawDownloadUrl) continue;
    let url: URL;
    try {
      url = new URL(rawDownloadUrl, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin.origin || url.pathname !== "/file-api/download") continue;
    if (!url.searchParams.get("token") || url.username || url.password) continue;
    const size = Math.max(0, Number(file.size || 0) || 0);
    if (size > MAX_REMOTE_FILE_BYTES) continue;
    files.push({
      name: safeSegment(file.name || file.filename, "download.bin", 240),
      size,
      url,
    });
  }
  return files;
}

async function readResponseWithLimit(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_REMOTE_FILE_BYTES) throw new Error("remote artifact exceeds size limit");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_REMOTE_FILE_BYTES) throw new Error("remote artifact exceeds size limit");
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function materializeRemoteJiuwenFiles(args: {
  delta: unknown;
  wsUrl: string;
  workspaceDir: string;
  requestId: string;
  fetchImpl?: typeof fetch;
}): Promise<JiuwenSessionArtifactFile[]> {
  const candidates = remoteFileCandidates(args.delta, args.wsUrl);
  if (!candidates.length) return [];

  const requestDirName = safeSegment(args.requestId, `request-${Date.now()}`, 180);
  const workspaceRoot = await realpath(args.workspaceDir);
  const outputDir = path.join(workspaceRoot, REMOTE_ARTIFACT_ROOT, requestDirName);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputDirReal = await realpath(outputDir);
  const relativeOutputDir = path.relative(workspaceRoot, outputDirReal);
  if (!relativeOutputDir || relativeOutputDir.startsWith("..") || path.isAbsolute(relativeOutputDir)) {
    throw new Error("remote artifact directory escaped workspace");
  }

  const fetchImpl = args.fetchImpl || fetch;
  const files: JiuwenSessionArtifactFile[] = [];
  const usedNames = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    let name = candidate.name;
    if (usedNames.has(name)) {
      const extension = path.extname(name);
      name = `${path.basename(name, extension)}-${index + 1}${extension}`;
    }
    usedNames.add(name);
    const destination = path.join(outputDirReal, name);
    const tempPath = `${destination}.tmp-${process.pid}-${Date.now()}-${index}`;
    try {
      const response = await fetchImpl(candidate.url.toString(), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`remote artifact download failed: HTTP ${response.status}`);
      const content = await readResponseWithLimit(response);
      await writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
      await rename(tempPath, destination);
      await chmod(destination, 0o600).catch(() => {});
      files.push({
        name,
        size: content.length,
        path: path.posix.join(REMOTE_ARTIFACT_ROOT, requestDirName, name),
      });
    } catch {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
  return files;
}

