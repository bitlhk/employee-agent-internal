import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listKnowledgeDocuments: vi.fn(),
  createKnowledgeIndexJob: vi.fn(),
  getKnowledgeBaseById: vi.fn(),
  listKnowledgeBasesForIndexRecovery: vi.fn(async () => []),
  listRecoverableKnowledgeIndexJobs: vi.fn(async () => []),
  pruneKnowledgeIndexJobs: vi.fn(async () => {}),
  setKnowledgeIndexJobState: vi.fn(),
  setKnowledgeBaseIndexState: vi.fn(),
  setKnowledgeDocumentState: vi.fn(),
  resolveKnowledgeStoragePath: vi.fn(),
  callEaAssistantModel: vi.fn(),
}));

vi.mock("../db", () => ({
  listKnowledgeDocuments: mocks.listKnowledgeDocuments,
  createKnowledgeIndexJob: mocks.createKnowledgeIndexJob,
  getKnowledgeBaseById: mocks.getKnowledgeBaseById,
  listKnowledgeBasesForIndexRecovery: mocks.listKnowledgeBasesForIndexRecovery,
  isKnowledgeDocumentCurrentlyActive: () => true,
  listRecoverableKnowledgeIndexJobs: mocks.listRecoverableKnowledgeIndexJobs,
  pruneKnowledgeIndexJobs: mocks.pruneKnowledgeIndexJobs,
  setKnowledgeIndexJobState: mocks.setKnowledgeIndexJobState,
  setKnowledgeBaseIndexState: mocks.setKnowledgeBaseIndexState,
  setKnowledgeDocumentState: mocks.setKnowledgeDocumentState,
}));

vi.mock("./knowledge-storage", () => ({
  knowledgeServiceToken: () => "test-token",
  resolveKnowledgeStoragePath: mocks.resolveKnowledgeStoragePath,
}));

vi.mock("./ea-assistant-model", () => ({
  callEaAssistantModel: mocks.callEaAssistantModel,
}));

import { queueKnowledgeIndex, retrieveAcrossKnowledgeBases, startKnowledgeIndexRecovery } from "./knowledge-service";

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

  it("queues a durable rebuild when database metadata exists but the physical index is missing", async () => {
    const base = {
      id: 77,
      publicId: "kb_restorebase1",
      ownerUserId: 7,
      ownerGroupId: 3,
      scope: "personal" as const,
      isGlobal: false,
      roleTemplate: null,
      name: "恢复知识库",
      description: "",
      classification: "internal" as const,
      externalProcessingAllowed: false,
      status: "ready" as const,
      documentCount: 1,
      chunkCount: 1,
      lastError: null,
      indexVersion: "old-version",
      indexSchemaVersion: 2,
      indexedAt: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const document = {
      id: 10,
      publicId: "doc_restore001",
      knowledgeBaseId: 77,
      name: "制度.txt",
      extension: "txt",
      mimeType: "text/plain",
      storagePath: "documents/restore.txt",
      sizeBytes: 10,
      sha256: "b".repeat(64),
      versionLabel: "1.0",
      lifecycle: "active" as const,
      sourceDepartment: "",
      classification: "internal" as const,
      authority: "reference" as const,
      externalProcessingAllowed: false,
      effectiveAt: null,
      expiresAt: null,
      status: "ready" as const,
      chunkCount: 1,
      lastError: null,
      parserVersion: "2.1",
      indexVersion: "old-version",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    mocks.listKnowledgeBasesForIndexRecovery.mockResolvedValueOnce([base]);
    mocks.listRecoverableKnowledgeIndexJobs.mockResolvedValueOnce([]);
    mocks.getKnowledgeBaseById.mockResolvedValue(base);
    mocks.listKnowledgeDocuments.mockResolvedValue([document]);
    mocks.createKnowledgeIndexJob.mockResolvedValue({ id: 17 });
    mocks.resolveKnowledgeStoragePath.mockReturnValue("/safe/documents/restore.txt");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/index-status")) {
        return new Response(JSON.stringify({
          ok: true,
          items: [{ knowledge_base_id: base.publicId, exists: false, index_version: "" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        chunk_count: 1,
        document_chunks: { [document.publicId]: 1 },
        index_version: "new-version",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const stop = startKnowledgeIndexRecovery();
    try {
      await vi.waitFor(() => expect(mocks.createKnowledgeIndexJob).toHaveBeenCalledWith(77, "index_missing_recovery"));
      await vi.waitFor(() => expect(mocks.setKnowledgeIndexJobState).toHaveBeenCalledWith({
        id: 17,
        status: "succeeded",
        error: null,
      }));
    } finally {
      stop();
    }
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

  it("searches the original and decomposed questions in parallel and preserves coverage", async () => {
    const bases = [{
      id: 1,
      publicId: "kb_prospectus1",
      ownerUserId: 7,
      ownerGroupId: 0,
      scope: "personal" as const,
      isGlobal: false,
      roleTemplate: null,
      name: "招股书",
      description: "",
      status: "ready" as const,
      documentCount: 1,
      chunkCount: 100,
      lastError: null,
      indexedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }];
    mocks.callEaAssistantModel.mockResolvedValue({
      content: JSON.stringify({ queries: ["长鑫科技核心业务", "长鑫科技全球竞争地位", "长鑫科技主要经营风险"] }),
    });
    const pages = [162, 25, 27, 32];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const page = pages[Math.min(fetchMock.mock.calls.length - 1, pages.length - 1)];
      return new Response(JSON.stringify({
        ok: true,
        triggered: true,
        retrieval: "hybrid",
        metrics: {
          knowledge_base_count: 1,
          bm25_max_score: 2,
          vector_min_distance: 0.5,
          reranker: "disabled",
          cache_hit: false,
          external_query_allowed: true,
        },
        results: [{
          chunk_id: `doc_a:${page}`,
          parent_id: `doc_a:page:${page}`,
          score: 0.03,
          text: `${body.query}的资料`,
          knowledge_base_id: bases[0].publicId,
          document_id: "doc_a",
          document_name: "招股书.pdf",
          position: `第 ${page} 页`,
          page,
          ordinal: page,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await retrieveAcrossKnowledgeBases(
      bases,
      "综合说明长鑫科技的核心业务、全球竞争地位和主要经营风险，每项结论标注来源页",
      6,
      "forced",
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.results.map((item) => item.page)).toEqual([25, 27, 32, 162]);
    expect(result.retrieval).toContain("multi_query");
    expect(result.metrics).toMatchObject({ queryCount: 4, queryExpansion: "applied" });
  });

  it("keeps the original retrieval result when expanded searches fail", async () => {
    const base = {
      id: 3,
      publicId: "kb_fallback001",
      ownerUserId: 7,
      ownerGroupId: 0,
      scope: "personal" as const,
      isGlobal: false,
      roleTemplate: null,
      name: "回退知识库",
      description: "",
      status: "ready" as const,
      documentCount: 1,
      chunkCount: 10,
      lastError: null,
      indexedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const original = "请分别说明产品范围、适用客户以及主要风险";
    mocks.callEaAssistantModel.mockResolvedValue({ content: JSON.stringify({ queries: ["产品范围", "适用客户", "主要风险"] }) });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query !== original) throw new Error("expanded search unavailable");
      return new Response(JSON.stringify({
        ok: true,
        triggered: true,
        retrieval: "bm25",
        metrics: { knowledge_base_count: 1, bm25_max_score: 2, reranker: "disabled" },
        results: [{
          chunk_id: "doc_fallback:1",
          parent_id: "doc_fallback:page:1",
          score: 0.1,
          text: "原问题检索结果",
          knowledge_base_id: base.publicId,
          document_id: "doc_fallback",
          document_name: "制度.md",
          position: "正文",
          ordinal: 1,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const result = await retrieveAcrossKnowledgeBases([base], original, 4, "forced");

    expect(result.results.map((item) => item.text)).toEqual(["原问题检索结果"]);
    expect(result.metrics.queryCount).toBe(1);
  });
});
