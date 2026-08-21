import { createHash } from "node:crypto";
import path from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { type EnterpriseAssetSourceItem } from "../../drizzle/schema";
import { type DiscoveredEnterpriseArtifact } from "./enterprise-asset-discovery";
import { KNOWLEDGE_EXTENSIONS, knowledgeExtension } from "./knowledge-storage";
import { scanUploadForMalware, validateUploadContent } from "./upload-security";

export type ObjectStorageConnectorConfig = {
  scheme: "s3" | "obs";
  endpoint?: string;
  bucket: string;
  prefix: string;
  region: string;
  credentialRef: string;
  forcePathStyle: boolean;
};

export type ObjectStorageConnectorLimits = {
  maxObjects: number;
  maxObjectBytes: number;
  maxDownloadBytes: number;
  maxPages: number;
};

export type ObjectStorageListItem = {
  key: string;
  etag?: string | null;
  lastModified?: Date | null;
  sizeBytes: number;
};

export type ObjectStorageClient = {
  listPage(input: {
    bucket: string;
    prefix: string;
    continuationToken?: string;
  }): Promise<{
    items: ObjectStorageListItem[];
    nextContinuationToken?: string;
    truncated: boolean;
  }>;
  getObject(input: { bucket: string; key: string }): Promise<{
    content: Buffer;
    etag?: string | null;
    lastModified?: Date | null;
  }>;
  destroy?(): void;
};

export type ObjectStorageConnectorScan = {
  config: Omit<ObjectStorageConnectorConfig, "credentialRef"> & { credentialRef: string };
  artifacts: DiscoveredEnterpriseArtifact[];
  cursorAfter: string;
  scanComplete: true;
  pages: number;
  downloaded: number;
  reusedContentHashes: number;
  skippedUnsupported: number;
};

const ALLOWED_QUERY_PARAMETERS = new Set(["endpoint", "region", "credentialRef", "forcePathStyle"]);

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function objectStorageConnectorLimits(): ObjectStorageConnectorLimits {
  return {
    maxObjects: boundedInteger(process.env.ENTERPRISE_OBJECT_STORAGE_MAX_OBJECTS, 100_000, 1, 500_000),
    maxObjectBytes: boundedInteger(process.env.ENTERPRISE_OBJECT_STORAGE_MAX_OBJECT_BYTES, 100 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    maxDownloadBytes: boundedInteger(process.env.ENTERPRISE_OBJECT_STORAGE_MAX_DOWNLOAD_BYTES, 10 * 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
    maxPages: boundedInteger(process.env.ENTERPRISE_OBJECT_STORAGE_MAX_PAGES, 1_000, 1, 10_000),
  };
}

function decodePrefix(pathname: string): string {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("对象存储 Prefix 编码无效");
  }
}

function allowedEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("对象存储 Endpoint 无效");
  }
  if (!new Set(["https:", "http:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("对象存储 Endpoint 必须是无凭据、无查询参数的 HTTP(S) Origin");
  }
  const origin = parsed.origin;
  const allowlist = String(process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS || "")
    .split(",")
    .map(item => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (!allowlist.includes(origin)) {
    throw new Error("对象存储 Endpoint 不在 ENTERPRISE_OBJECT_STORAGE_ENDPOINTS 白名单内");
  }
  return origin;
}

export function parseObjectStorageSourceUri(sourceUri: string): ObjectStorageConnectorConfig {
  let parsed: URL;
  try {
    parsed = new URL(sourceUri);
  } catch {
    throw new Error("对象存储来源地址无效");
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== "s3" && scheme !== "obs") throw new Error("对象存储来源必须使用 s3:// 或 obs:// URI");
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) throw new Error(`对象存储来源包含不允许的配置项：${key}`);
  }
  const bucket = parsed.hostname.trim();
  if (!bucket || bucket.length > 255) throw new Error("对象存储 Bucket 无效");
  const credentialRef = parsed.searchParams.get("credentialRef") || "";
  if (!/^env:\/\/[A-Z][A-Z0-9_]{2,63}$/.test(credentialRef)) {
    throw new Error("Credential Reference 必须使用 env://NAME，且不能包含真实凭据");
  }
  const endpointValue = parsed.searchParams.get("endpoint") || undefined;
  const endpoint = endpointValue ? allowedEndpoint(endpointValue) : undefined;
  if (scheme === "obs" && !endpoint) throw new Error("OBS Connector 必须配置受信 Endpoint");
  const forcePathStyleValue = parsed.searchParams.get("forcePathStyle");
  if (forcePathStyleValue && !new Set(["true", "false"]).has(forcePathStyleValue)) {
    throw new Error("forcePathStyle 只能是 true 或 false");
  }
  return {
    scheme,
    endpoint,
    bucket,
    prefix: decodePrefix(parsed.pathname),
    region: parsed.searchParams.get("region") || "us-east-1",
    credentialRef,
    forcePathStyle: forcePathStyleValue ? forcePathStyleValue === "true" : Boolean(endpoint),
  };
}

function credentialsForReference(reference: string): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  const name = reference.slice("env://".length);
  const accessKeyId = process.env[`${name}_ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`${name}_SECRET_ACCESS_KEY`];
  const sessionToken = process.env[`${name}_SESSION_TOKEN`];
  if (!accessKeyId || !secretAccessKey) throw new Error(`Credential Reference ${reference} 未配置或不完整`);
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function awsClient(config: ObjectStorageConnectorConfig): ObjectStorageClient {
  const client = new S3Client({
    region: config.region,
    credentials: credentialsForReference(config.credentialRef),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 3,
  });
  return {
    async listPage(input) {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix || undefined,
        ContinuationToken: input.continuationToken,
        MaxKeys: 1_000,
      }));
      return {
        items: (result.Contents || []).flatMap(item => item.Key && item.Size !== undefined ? [{
          key: item.Key,
          etag: item.ETag || null,
          lastModified: item.LastModified || null,
          sizeBytes: item.Size,
        }] : []),
        nextContinuationToken: result.NextContinuationToken,
        truncated: Boolean(result.IsTruncated),
      };
    },
    async getObject(input) {
      const result: GetObjectCommandOutput = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
      if (!result.Body) throw new Error(`${input.key}: 对象正文为空`);
      return {
        content: Buffer.from(await result.Body.transformToByteArray()),
        etag: result.ETag || null,
        lastModified: result.LastModified || null,
      };
    },
    destroy: () => client.destroy(),
  };
}

function normalizedEtag(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.replace(/^"|"$/g, "") : null;
}

function normalizedModifiedAt(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString();
}

export function objectStorageExternalItemId(bucket: string, key: string): string {
  const canonicalIdentity = `${bucket}\0${key}`;
  return `object:${createHash("sha256").update(canonicalIdentity).digest("hex")}`;
}

function sourceObjectUri(config: ObjectStorageConnectorConfig, key: string): string {
  return `${config.scheme}://${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function canReuseContentHash(existing: EnterpriseAssetSourceItem | undefined, item: ObjectStorageListItem): boolean {
  if (!existing || existing.state === "retired") return false;
  const etag = normalizedEtag(item.etag);
  return Boolean(etag)
    && normalizedEtag(existing.etag) === etag
    && existing.sizeBytes === item.sizeBytes
    && (existing.sourceModifiedAt?.toISOString() || null) === normalizedModifiedAt(item.lastModified);
}

async function validatedObjectContent(input: {
  client: ObjectStorageClient;
  bucket: string;
  key: string;
  extension: string;
  expectedSize: number;
  expectedEtag?: string | null;
  expectedModifiedAt?: Date | null;
  maxObjectBytes: number;
}): Promise<Buffer> {
  const downloaded = await input.client.getObject({ bucket: input.bucket, key: input.key });
  const content = downloaded.content;
  if (content.length !== input.expectedSize) throw new Error(`${input.key}: 下载大小与对象清单不一致，请重试同步`);
  if (downloaded.etag && normalizedEtag(downloaded.etag) !== normalizedEtag(input.expectedEtag)) {
    throw new Error(`${input.key}: 对象在 Listing 后发生变化，请重试同步`);
  }
  if (downloaded.lastModified && normalizedModifiedAt(downloaded.lastModified) !== normalizedModifiedAt(input.expectedModifiedAt)) {
    throw new Error(`${input.key}: 对象在 Listing 后发生变化，请重试同步`);
  }
  if (content.length <= 0 || content.length > input.maxObjectBytes) throw new Error(`${input.key}: 对象大小超出接入限制`);
  const validation = validateUploadContent(input.extension, content);
  if (!validation.ok) throw new Error(`${path.posix.basename(input.key)}: ${validation.error}`);
  const malware = await scanUploadForMalware(content);
  if (!malware.ok) throw new Error(`${path.posix.basename(input.key)}: ${malware.error}`);
  return content;
}

export async function scanObjectStorageSource(input: {
  sourceUri: string;
  existingItems?: EnterpriseAssetSourceItem[];
  client?: ObjectStorageClient;
  limits?: Partial<ObjectStorageConnectorLimits>;
}): Promise<ObjectStorageConnectorScan> {
  const config = parseObjectStorageSourceUri(input.sourceUri);
  const limits = { ...objectStorageConnectorLimits(), ...input.limits };
  const client = input.client || awsClient(config);
  const existingByExternalId = new Map((input.existingItems || []).map(item => [item.externalItemId, item]));
  const listed: ObjectStorageListItem[] = [];
  let continuationToken: string | undefined;
  let pages = 0;

  try {
    do {
      if (pages >= limits.maxPages) throw new Error(`对象存储 Listing 页数超过 ${limits.maxPages}`);
      const page = await client.listPage({ bucket: config.bucket, prefix: config.prefix, continuationToken });
      pages += 1;
      listed.push(...page.items);
      if (listed.length > limits.maxObjects) throw new Error(`对象存储文件数超过 ${limits.maxObjects}`);
      if (page.truncated && !page.nextContinuationToken) throw new Error("对象存储分页响应缺少 Continuation Token");
      continuationToken = page.truncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);

    const seenKeys = new Set<string>();
    const artifacts: DiscoveredEnterpriseArtifact[] = [];
    let skippedUnsupported = 0;
    let downloaded = 0;
    let reusedContentHashes = 0;
    let downloadedBytes = 0;

    for (const item of listed.sort((a, b) => a.key.localeCompare(b.key))) {
      if (!item.key || seenKeys.has(item.key)) throw new Error(`对象存储 Listing 包含重复 Key：${item.key || "(empty)"}`);
      seenKeys.add(item.key);
      if (config.prefix && !item.key.startsWith(config.prefix)) throw new Error(`对象 Key 超出已登记 Prefix：${item.key}`);
      if (item.key.endsWith("/")) continue;
      const relativePath = config.prefix && item.key.startsWith(config.prefix)
        ? item.key.slice(config.prefix.length).replace(/^\/+/, "")
        : item.key;
      if (!relativePath) continue;
      const displayName = path.posix.basename(relativePath);
      const originUri = sourceObjectUri(config, item.key);
      if (relativePath.length > 700 || displayName.length > 240 || originUri.length > 1_000) {
        throw new Error(`${item.key}: 对象 Key 超出 GRACE V1 可治理长度`);
      }
      const extension = knowledgeExtension(relativePath);
      if (!KNOWLEDGE_EXTENSIONS.has(extension)) {
        skippedUnsupported += 1;
        continue;
      }
      if (item.sizeBytes <= 0 || item.sizeBytes > limits.maxObjectBytes) throw new Error(`${item.key}: 对象大小超出接入限制`);
      const externalItemId = objectStorageExternalItemId(config.bucket, item.key);
      const existing = existingByExternalId.get(externalItemId);
      let content: Buffer | undefined;
      let checksum: string;
      if (canReuseContentHash(existing, item)) {
        checksum = existing!.contentHash;
        reusedContentHashes += 1;
      } else {
        downloadedBytes += item.sizeBytes;
        if (downloadedBytes > limits.maxDownloadBytes) throw new Error("对象存储本次下载总量超过限制");
        content = await validatedObjectContent({
          client,
          bucket: config.bucket,
          key: item.key,
          extension,
          expectedSize: item.sizeBytes,
          expectedEtag: item.etag,
          expectedModifiedAt: item.lastModified,
          maxObjectBytes: limits.maxObjectBytes,
        });
        checksum = createHash("sha256").update(content).digest("hex");
        downloaded += 1;
      }
      artifacts.push({
        externalItemId,
        relativePath,
        displayName,
        extension,
        sizeBytes: item.sizeBytes,
        checksum,
        etag: normalizedEtag(item.etag) || undefined,
        sourceUri: originUri,
        sourceModifiedAt: normalizedModifiedAt(item.lastModified) || undefined,
        ...(content ? {
          content,
          ...(new Set(["md", "txt", "csv", "json", "yaml", "yml"]).has(extension)
            ? { loadTextExcerpt: async (maxCharacters: number) => content!.toString("utf8").slice(0, maxCharacters) }
            : {}),
        } : {}),
      });
    }

    const cursor = createHash("sha256");
    for (const artifact of artifacts) {
      cursor.update(`${artifact.externalItemId}\0${artifact.relativePath}\0${artifact.etag || ""}\0${artifact.checksum}\0`);
    }
    return {
      config: { ...config, credentialRef: config.credentialRef },
      artifacts,
      cursorAfter: `object-v1:${cursor.digest("hex")}`,
      scanComplete: true,
      pages,
      downloaded,
      reusedContentHashes,
      skippedUnsupported,
    };
  } finally {
    if (!input.client) client.destroy?.();
  }
}
