import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";

const mocks = vi.hoisted(() => ({
  listAccessibleKnowledgeBases: vi.fn(),
  listKnowledgeDocumentsForBases: vi.fn(),
}));

vi.mock("../db", () => ({
  listAccessibleKnowledgeBases: mocks.listAccessibleKnowledgeBases,
  listKnowledgeDocumentsForBases: mocks.listKnowledgeDocumentsForBases,
}));

import { resolveWealthPolicyBasis, resolveWealthSuitabilityPolicySource } from "./wealth-policy-source";

const base: KnowledgeBaseRecord = {
  id: 1,
  publicId: "kb_wealth",
  ownerUserId: 1,
  ownerGroupId: 3,
  scope: "role",
  isGlobal: false,
  roleTemplate: "wealth-manager",
  name: "财富经理岗位知识",
  description: "",
  classification: "internal",
  externalProcessingAllowed: true,
  status: "ready",
  documentCount: 2,
  chunkCount: 20,
  lastError: null,
  indexVersion: "v1",
  indexSchemaVersion: 1,
  indexedAt: "2026-08-10T00:00:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

function document(input: Partial<KnowledgeDocumentRecord> & Pick<KnowledgeDocumentRecord, "publicId" | "name" | "versionLabel">): KnowledgeDocumentRecord {
  return {
    id: input.publicId === "doc_policy_v22" ? 22 : 21,
    publicId: input.publicId,
    knowledgeBaseId: 1,
    extension: ".md",
    mimeType: "text/markdown",
    storagePath: `/tmp/${input.name}`,
    sizeBytes: 100,
    sha256: "a".repeat(64),
    lifecycle: "active",
    sourceDepartment: "财富管理部",
    classification: "internal",
    authority: "approved",
    externalProcessingAllowed: true,
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: null,
    status: "ready",
    chunkCount: 10,
    lastError: null,
    parserVersion: "v1",
    indexVersion: "v1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...input,
  };
}

const current = document({
  publicId: "doc_policy_v22",
  name: "15-财富产品适当性销售管理细则（V2.2现行）.md",
  versionLabel: "V2.2",
});
const historical = document({
  publicId: "doc_policy_v21",
  name: "15-财富产品适当性销售管理细则（V2.1历史）.md",
  versionLabel: "V2.1",
  lifecycle: "expired",
  effectiveAt: "2025-07-01T00:00:00.000Z",
  expiresAt: "2026-06-30T23:59:59.000Z",
});

describe("wealth policy source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([base]);
    mocks.listKnowledgeDocumentsForBases.mockResolvedValue([current, historical]);
  });

  it("selects the configured current version and proves historical filtering", async () => {
    const result = await resolveWealthPolicyBasis({
      userId: 7,
      groupId: 3,
      actorRole: "user",
      roleTemplate: "wealth-manager",
      now: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(result.status).toBe("ready");
    expect(result.selected).toMatchObject({ sourceAssetId: "doc_policy_v22", versionLabel: "V2.2" });
    expect(result.governance).toMatchObject({ historicalVersionFiltered: true, filteredForValidity: 1 });
    expect(result.userMessage).toContain("V2.2");
    expect(result.userMessage).not.toContain("V2.1");

    const source = await resolveWealthSuitabilityPolicySource({
      userId: 7,
      groupId: 3,
      actorRole: "user",
      roleTemplate: "wealth-manager",
      now: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(source).toMatchObject({ ready: true, sourceAssetId: "doc_policy_v22", versionLabel: "V2.2" });
  });

  it("fails safely when the configured current version is no longer eligible", async () => {
    mocks.listKnowledgeDocumentsForBases.mockResolvedValue([
      { ...current, lifecycle: "expired", expiresAt: "2026-08-01T00:00:00.000Z" },
      historical,
    ]);
    const result = await resolveWealthPolicyBasis({
      userId: 7,
      groupId: 3,
      actorRole: "user",
      roleTemplate: "wealth-manager",
      now: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(result.status).toBe("unavailable");
    expect(result.selected).toBeNull();
    expect(result.userMessage).toContain("暂不能据此形成正式业务判断");
  });
});
