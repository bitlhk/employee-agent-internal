import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open as openFile, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_ROOT } from "./helpers";
import { type DiscoveredEnterpriseArtifact } from "./enterprise-asset-discovery";
import { KNOWLEDGE_EXTENSIONS, knowledgeExtension } from "./knowledge-storage";
import { scanUploadForMalware, validateUploadContent } from "./upload-security";

export type FilesystemConnectorLimits = {
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export type FilesystemConnectorScan = {
  rootPath: string;
  artifacts: DiscoveredEnterpriseArtifact[];
  cursorAfter: string;
  scanComplete: true;
  skippedSymlinks: number;
  skippedUnsupported: number;
};

const DEFAULT_ROOT = path.join(APP_ROOT, "data", "enterprise-connectors");

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function filesystemConnectorLimits(): FilesystemConnectorLimits {
  return {
    maxFiles: boundedInteger(process.env.ENTERPRISE_FILESYSTEM_MAX_FILES, 10_000, 1, 100_000),
    maxDepth: boundedInteger(process.env.ENTERPRISE_FILESYSTEM_MAX_DEPTH, 24, 1, 128),
    maxFileBytes: boundedInteger(process.env.ENTERPRISE_FILESYSTEM_MAX_FILE_BYTES, 100 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    maxTotalBytes: boundedInteger(process.env.ENTERPRISE_FILESYSTEM_MAX_TOTAL_BYTES, 10 * 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
  };
}

function configuredRoots(): string[] {
  const configured = String(process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS || DEFAULT_ROOT)
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
  return [...new Set(configured.map(item => path.resolve(item)))];
}

function sourcePath(sourceUri: string): string {
  if (!sourceUri.startsWith("file://")) throw new Error("Filesystem Connector 来源必须使用 file:// URI");
  const parsed = new URL(sourceUri);
  if (parsed.protocol !== "file:" || parsed.hostname) throw new Error("Filesystem Connector 只支持本机 file:// URI");
  return path.resolve(fileURLToPath(parsed));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveAuthorizedRoot(sourceUri: string): Promise<string> {
  const requested = sourcePath(sourceUri);
  const requestedStat = await lstat(requested, { bigint: true });
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("Filesystem Connector 来源必须是非符号链接目录");
  }
  const requestedReal = await realpath(requested);
  const allowed = await Promise.all(configuredRoots().map(async root => {
    try { return await realpath(root); } catch { return path.resolve(root); }
  }));
  if (!allowed.some(root => isWithin(root, requestedReal))) {
    throw new Error("Filesystem Connector 来源不在 ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS 白名单内");
  }
  return requestedReal;
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function identityObservation(stat: Awaited<ReturnType<typeof lstat>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs].map(String).join(":");
}

function stableExternalItemId(stat: Awaited<ReturnType<typeof lstat>>): string {
  const device = String(stat.dev);
  const inode = String(stat.ino);
  const birthtimeNs = (stat as { birthtimeNs?: bigint }).birthtimeNs;
  const birthtime = birthtimeNs !== undefined ? String(birthtimeNs) : String(stat.birthtimeMs);
  if (device === "0" || inode === "0" || birthtime === "0") {
    throw new Error("文件系统未提供稳定 inode/birth-time，不能保证重命名和 inode 复用语义");
  }
  return `fs:${device}:${inode}:${birthtime}`;
}

async function loadValidatedContent(input: {
  absolutePath: string;
  extension: string;
  expectedHash: string;
  expectedSize: number;
  limits: FilesystemConnectorLimits;
}): Promise<Buffer> {
  const stat = await lstat(input.absolutePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("来源文件已变化或不再是普通文件");
  const size = Number(stat.size);
  if (size !== input.expectedSize || size > input.limits.maxFileBytes) throw new Error("来源文件在扫描后发生变化");
  const content = await readFile(input.absolutePath);
  const checksum = createHash("sha256").update(content).digest("hex");
  if (checksum !== input.expectedHash) throw new Error("来源文件在扫描后发生变化，请重新同步");
  const validation = validateUploadContent(input.extension, content);
  if (!validation.ok) throw new Error(`${path.basename(input.absolutePath)}: ${validation.error}`);
  const malware = await scanUploadForMalware(content);
  if (!malware.ok) throw new Error(`${path.basename(input.absolutePath)}: ${malware.error}`);
  return content;
}

async function loadTextExcerpt(filename: string, maxCharacters: number): Promise<string> {
  const handle = await openFile(filename, "r");
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(maxCharacters * 4, 64 * 1024)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(0, maxCharacters);
  } finally {
    await handle.close();
  }
}

export async function scanFilesystemSource(input: {
  sourceUri: string;
  limits?: Partial<FilesystemConnectorLimits>;
}): Promise<FilesystemConnectorScan> {
  const rootPath = await resolveAuthorizedRoot(input.sourceUri);
  const limits = { ...filesystemConnectorLimits(), ...input.limits };
  const artifacts: DiscoveredEnterpriseArtifact[] = [];
  let totalBytes = 0;
  let skippedSymlinks = 0;
  let skippedUnsupported = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) throw new Error(`Filesystem Connector 扫描深度超过 ${limits.maxDepth}`);
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
      const extension = knowledgeExtension(relativePath);
      if (!KNOWLEDGE_EXTENSIONS.has(extension)) {
        skippedUnsupported += 1;
        continue;
      }
      const stat = await lstat(absolutePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      const sizeBytes = Number(stat.size);
      if (sizeBytes <= 0) throw new Error(`${relativePath}: 空文件不能接入`);
      if (sizeBytes > limits.maxFileBytes) throw new Error(`${relativePath}: 文件超过单文件大小限制`);
      totalBytes += sizeBytes;
      if (totalBytes > limits.maxTotalBytes) throw new Error("Filesystem Connector 扫描总大小超过限制");
      if (artifacts.length >= limits.maxFiles) throw new Error(`Filesystem Connector 文件数超过 ${limits.maxFiles}`);
      const beforeHash = identityObservation(stat);
      const checksum = await sha256File(absolutePath);
      const afterHashStat = await lstat(absolutePath, { bigint: true });
      if (!afterHashStat.isFile() || afterHashStat.isSymbolicLink() || identityObservation(afterHashStat) !== beforeHash) {
        throw new Error(`${relativePath}: 文件在扫描期间发生变化，请重试同步`);
      }
      artifacts.push({
        externalItemId: stableExternalItemId(stat),
        relativePath,
        displayName: path.basename(relativePath),
        extension,
        sizeBytes,
        checksum,
        etag: checksum,
        sourceUri: pathToFileURL(absolutePath).href,
        sourceModifiedAt: new Date(Math.floor(Number(stat.mtimeMs) / 1000) * 1000).toISOString(),
        loadContent: () => loadValidatedContent({ absolutePath, extension, expectedHash: checksum, expectedSize: sizeBytes, limits }),
        ...(new Set(["md", "txt", "csv", "json", "yaml", "yml"]).has(extension)
          ? { loadTextExcerpt: (maxCharacters: number) => loadTextExcerpt(absolutePath, maxCharacters) }
          : {}),
      });
    }
  }

  await walk(rootPath, 0);
  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const cursor = createHash("sha256");
  for (const artifact of artifacts) {
    cursor.update(`${artifact.externalItemId}\0${artifact.relativePath}\0${artifact.checksum}\0`);
  }
  return {
    rootPath,
    artifacts,
    cursorAfter: `fs-v1:${cursor.digest("hex")}`,
    scanComplete: true,
    skippedSymlinks,
    skippedUnsupported,
  };
}
