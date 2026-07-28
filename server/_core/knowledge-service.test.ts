import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listKnowledgeDocuments: vi.fn(),
  createKnowledgeIndexJob: vi.fn(),
  getKnowledgeBaseById: vi.fn(),
  setKnowledgeIndexJobState: vi.fn(),
  setKnowledgeBaseIndexState: vi.fn(),
  setKnowledgeDocumentState: vi.fn(),
  resolveKnowledgeStoragePath: vi.fn(),
}));

vi.mock("../db", () => ({
  listKnowledgeDocuments: mocks.listKnowledgeDocuments,
  createKnowledgeIndexJob: mocks.createKnowledgeIndexJob,
  getKnowledgeBaseById: mocks.getKnowledgeBaseById,
  isKnowledgeDocumentCurrentlyActive: () => true,
  listRecoverableKnowledgeIndexJobs: vi.fn(async () => []),
  pruneKnowledgeIndexJobs: vi.fn(async () => {}),
  setKnowledgeIndexJobState: mocks.setKnowledgeIndexJobState,
  setKnowledgeBaseIndexState: mocks.setKnowledgeBaseIndexState,
  setKnowledgeDocumentState: mocks.setKnowledgeDocumentState,
}));

vi.mock("./knowledge-storage", () => ({
  knowledgeServiceToken: () => "test-token",
  resolveKnowledgeStoragePath: mocks.resolveKnowledgeStoragePath,
}));

import { queueKnowledgeIndex, retrieveAcrossKnowledgeBases } from "./knowledge-service";

describe("knowledge indexing queue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("runs a follow-up index when another upload arrives during indexing", async () => {
    const base = {
      id: 42,
      publicId: "kb_queuebase1",
      ownerUserId: 7,
      ownerGroupId: 3,
      scope: "personal" as const,
      isGlobal: false,
      roleTemplate: null,
      name: "测试知识库",
      description: "",
      status: "indexing" as const,
      documentCount: 1,
      chunkCount: 0,
      lastError: null,
      indexedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const document = {
      id: 9,
      publicId: "doc_queueitem1",
      knowledgeBaseId: 42,
      name: "制度.txt",
      extension: "txt",
      mimeType: "text/plain",
      storagePath: "documents/test.txt",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      status: "uploaded" as const,
      chunkCount: 0,
      lastError: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    mocks.listKnowledgeDocuments.mockResolvedValue([document]);
    mocks.getKnowledgeBaseById.mockResolvedValue(base);
    mocks.setKnowledgeIndexJobState.mockResolvedValue(undefined);
    mocks.createKnowledgeIndexJob
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({ id: 2 });
    mocks.resolveKnowledgeStoragePath.mockReturnValue("/safe/documents/test.txt");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      chunk_count: 1,
      document_chunks: { [document.publicId]: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const first = queueKnowledgeIndex(base);
    const second = queueKnowledgeIndex(base);
    await Promise.all([first, second]);

    expect(mocks.listKnowledgeDocuments).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("searches multiple accessible bases in one service request", async () => {
    const bases = [
      {
        id: 1,
        publicId: "kb_enterprise1",
        ownerUserId: 1,
        ownerGroupId: 0,
        scope: "enterprise" as const,
        isGlobal: true,
        roleTemplate: null,
        name: "企业制度",
        description: "",
        status: "ready" as const,
        documentCount: 1,
        chunkCount: 2,
        lastError: null,
        indexedAt: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      {
        id: 2,
        publicId: "kb_rolebase001",
        ownerUserId: 1,
        ownerGroupId: 0,
        scope: "role" as const,
        isGlobal: true,
        roleTemplate: "wealth-manager",
        name: "财富知识",
        description: "",
        status: "ready" as const,
        documentCount: 1,
        chunkCount: 2,
        lastError: null,
        indexedAt: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      triggered: true,
      retrieval: "hybrid",
      metrics: { knowledge_base_count: 2, bm25_max_score: 1.5, vector_min_distance: 0.7 },
      results: [{
        chunk_id: "doc_a:1",
        score: 0.03,
        text: "差旅制度内容",
        knowledge_base_id: bases[0].publicId,
        document_id: "doc_a",
        document_name: "差旅制度.md",
        position: "正文",
        ordinal: 1,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await retrieveAcrossKnowledgeBases(bases, "住宿标准", 4, "auto");

    expect(result.triggered).toBe(true);
    expect(result.results[0].knowledgeBaseName).toBe("企业制度");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      knowledge_base_ids: [bases[0].publicId, bases[1].publicId],
      mode: "auto",
      top_k: 4,
    });
  });
});
