import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type EnterpriseAssetSourceItem } from "../../drizzle/schema";
import {
  objectStorageExternalItemId,
  parseObjectStorageSourceUri,
  scanObjectStorageSource,
  type ObjectStorageClient,
  type ObjectStorageListItem,
} from "./object-storage-source-connector";

const endpoint = "http://127.0.0.1:5901";
const originalEndpoints = process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS;

function sourceUri(prefix = "wealth/"): string {
  const query = new URLSearchParams({
    endpoint,
    region: "cn-east-3",
    credentialRef: "env://TEST_OBS",
    forcePathStyle: "true",
  });
  return `obs://demo-bank/${prefix}?${query}`;
}

function fakeClient(input: {
  pages: Array<{ items: ObjectStorageListItem[]; token?: string }>;
  content: Record<string, string>;
  failPage?: number;
}) {
  const downloads: string[] = [];
  const tokens: Array<string | undefined> = [];
  const client: ObjectStorageClient = {
    async listPage(request) {
      tokens.push(request.continuationToken);
      const pageIndex = request.continuationToken ? Number(request.continuationToken.replace("page-", "")) : 0;
      if (pageIndex === input.failPage) throw new Error("listing interrupted");
      const page = input.pages[pageIndex];
      if (!page) throw new Error(`unexpected page ${pageIndex}`);
      return {
        items: page.items,
        truncated: Boolean(page.token),
        nextContinuationToken: page.token,
      };
    },
    async getObject(request) {
      downloads.push(request.key);
      const value = input.content[request.key];
      if (value === undefined) throw new Error("download failed");
      const listed = input.pages.flatMap(page => page.items).find(item => item.key === request.key);
      return {
        content: Buffer.from(value),
        etag: listed?.etag,
        lastModified: listed?.lastModified,
      };
    },
  };
  return { client, downloads, tokens };
}

function existingItem(input: {
  key: string;
  content: string;
  etag: string;
  modifiedAt: Date;
}): EnterpriseAssetSourceItem {
  return {
    id: 1,
    sourceItemId: "easi-existing",
    sourceId: "obs-source",
    externalItemId: objectStorageExternalItemId("demo-bank", input.key),
    enterpriseAssetId: "asset-existing",
    relativePath: input.key.replace(/^wealth\//, ""),
    sourceUri: `obs://demo-bank/${input.key}`,
    etag: input.etag,
    sourceModifiedAt: input.modifiedAt,
    contentHash: createHash("sha256").update(input.content).digest("hex"),
    latestSourceVersion: "1.0",
    sizeBytes: Buffer.byteLength(input.content),
    state: "active",
    lastSeenRunId: "run-1",
    missingSinceRunId: null,
    latestCandidateId: "candidate-1",
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

afterEach(() => {
  process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = originalEndpoints;
});

describe("OBS/S3 Connector V1", () => {
  it("parses only non-sensitive connector references and enforces endpoint scope", () => {
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    expect(parseObjectStorageSourceUri(sourceUri())).toMatchObject({
      scheme: "obs",
      endpoint,
      bucket: "demo-bank",
      prefix: "wealth/",
      credentialRef: "env://TEST_OBS",
      forcePathStyle: true,
    });
    expect(() => parseObjectStorageSourceUri(sourceUri().replace("credentialRef=env%3A%2F%2FTEST_OBS", "accessKey=secret")))
      .toThrow(/不允许的配置项/);
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = "https://obs.example.com";
    expect(() => parseObjectStorageSourceUri(sourceUri())).toThrow(/白名单/);
  });

  it("follows continuation tokens and materializes supported objects after a complete listing", async () => {
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    const firstModified = new Date("2026-08-21T01:00:00.000Z");
    const secondModified = new Date("2026-08-21T02:00:00.000Z");
    const storage = fakeClient({
      pages: [
        {
          items: [{ key: "wealth/policy-v1.md", etag: '"etag-a-2"', lastModified: firstModified, sizeBytes: 10 }],
          token: "page-1",
        },
        {
          items: [
            { key: "wealth/policy-v2.md", etag: '"etag-b"', lastModified: secondModified, sizeBytes: 10 },
            { key: "wealth/readme.exe", etag: '"ignored"', lastModified: secondModified, sizeBytes: 4 },
          ],
        },
      ],
      content: {
        "wealth/policy-v1.md": "policy-v1\n",
        "wealth/policy-v2.md": "policy-v2\n",
      },
    });

    const scan = await scanObjectStorageSource({ sourceUri: sourceUri(), client: storage.client });

    expect(storage.tokens).toEqual([undefined, "page-1"]);
    expect(storage.downloads).toEqual(["wealth/policy-v1.md", "wealth/policy-v2.md"]);
    expect(scan).toMatchObject({ scanComplete: true, pages: 2, downloaded: 2, reusedContentHashes: 0, skippedUnsupported: 1 });
    expect(scan.artifacts.map(item => item.relativePath)).toEqual(["policy-v1.md", "policy-v2.md"]);
    expect(scan.artifacts[0].etag).toBe("etag-a-2");
    expect(scan.artifacts[0].checksum).toBe(createHash("sha256").update("policy-v1\n").digest("hex"));
    expect(scan.cursorAfter).toMatch(/^object-v1:[a-f0-9]{64}$/);
  });

  it("uses ETag only as a fast validator and preserves the stored content hash", async () => {
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    const modifiedAt = new Date("2026-08-21T01:00:00.000Z");
    const existing = existingItem({ key: "wealth/policy-v1.md", content: "policy-v1\n", etag: "multipart-etag-2", modifiedAt });
    const storage = fakeClient({
      pages: [{ items: [{ key: "wealth/policy-v1.md", etag: '"multipart-etag-2"', lastModified: modifiedAt, sizeBytes: 10 }] }],
      content: {},
    });

    const scan = await scanObjectStorageSource({
      sourceUri: sourceUri(),
      existingItems: [existing],
      client: storage.client,
    });

    expect(storage.downloads).toEqual([]);
    expect(scan.reusedContentHashes).toBe(1);
    expect(scan.artifacts[0].checksum).toBe(existing.contentHash);
    expect(scan.artifacts[0].checksum).not.toBe(scan.artifacts[0].etag);
    expect(scan.artifacts[0].content).toBeUndefined();
  });

  it("downloads again when object metadata changes, even if the ETag is unchanged", async () => {
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    const existing = existingItem({
      key: "wealth/policy-v1.md",
      content: "policy-v1\n",
      etag: "etag-a",
      modifiedAt: new Date("2026-08-21T01:00:00.000Z"),
    });
    const storage = fakeClient({
      pages: [{ items: [{
        key: "wealth/policy-v1.md",
        etag: '"etag-a"',
        lastModified: new Date("2026-08-21T02:00:00.000Z"),
        sizeBytes: 10,
      }] }],
      content: { "wealth/policy-v1.md": "policy-v2\n" },
    });

    const scan = await scanObjectStorageSource({ sourceUri: sourceUri(), existingItems: [existing], client: storage.client });

    expect(storage.downloads).toEqual(["wealth/policy-v1.md"]);
    expect(scan.artifacts[0].checksum).not.toBe(existing.contentHash);
  });

  it("does not return a complete snapshot when pagination or download fails", async () => {
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    const interrupted = fakeClient({
      pages: [{ items: [], token: "page-1" }, { items: [] }],
      content: {},
      failPage: 1,
    });
    await expect(scanObjectStorageSource({ sourceUri: sourceUri(), client: interrupted.client })).rejects.toThrow(/listing interrupted/);

    const failedDownload = fakeClient({
      pages: [{ items: [{ key: "wealth/missing.md", etag: "etag", lastModified: new Date(), sizeBytes: 1 }] }],
      content: {},
    });
    await expect(scanObjectStorageSource({ sourceUri: sourceUri(), client: failedDownload.client })).rejects.toThrow(/download failed/);
  });

  it("rejects an object replaced between listing and download", async () => {
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    const client: ObjectStorageClient = {
      async listPage() {
        return {
          items: [{ key: "wealth/policy.md", etag: "listed-etag", lastModified: new Date("2026-08-21T01:00:00Z"), sizeBytes: 8 }],
          truncated: false,
        };
      },
      async getObject() {
        return {
          content: Buffer.from("changed\n"),
          etag: "new-etag",
          lastModified: new Date("2026-08-21T02:00:00Z"),
        };
      },
    };
    await expect(scanObjectStorageSource({ sourceUri: sourceUri(), client })).rejects.toThrow(/Listing 后发生变化/);
  });
});
