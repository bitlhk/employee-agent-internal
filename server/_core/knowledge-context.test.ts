import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  listAccessibleKnowledgeBases: vi.fn(),
  retrieveAcrossKnowledgeBases: vi.fn(),
}));

vi.mock("../db", () => ({
  getUserById: mocks.getUserById,
  listAccessibleKnowledgeBases: mocks.listAccessibleKnowledgeBases,
}));

vi.mock("./knowledge-service", () => ({
  retrieveAcrossKnowledgeBases: mocks.retrieveAcrossKnowledgeBases,
}));

import { buildChatKnowledgeContext, knowledgeRetrievalQuery, publicChatKnowledgeSources } from "./knowledge-context";
import { buildExpertHandoffRuntimeMessage } from "../../shared/expert-handoff-context";

const readyBase = {
  id: 1,
  publicId: "kb_readybase1",
  ownerUserId: 7,
  ownerGroupId: 3,
  scope: "personal",
  isGlobal: false,
  roleTemplate: null,
  name: "制度库",
  description: "",
  status: "ready",
  documentCount: 1,
  chunkCount: 2,
  lastError: null,
  indexedAt: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("knowledge chat context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({ id: 7, groupId: 3 });
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([
      readyBase,
      { ...readyBase, id: 2, publicId: "kb_processing1", status: "indexing" },
    ]);
    mocks.retrieveAcrossKnowledgeBases.mockResolvedValue({
      triggered: true,
      retrieval: "hybrid",
      metrics: { knowledgeBaseCount: 1, bm25MaxScore: 2.1, vectorMinDistance: 0.65 },
      results: [{
        chunkId: "doc_policy001:1",
        score: 0.9,
        text: "住宿标准为每晚六百元。",
        documentId: "doc_policy001",
        documentName: "差旅制度.pdf",
        position: "第 3 页",
        ordinal: 1,
        knowledgeBaseId: readyBase.publicId,
        knowledgeBaseName: readyBase.name,
      }],
    });
  });

  it("uses only selected ready bases and marks retrieved text as untrusted evidence", async () => {
    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [readyBase.publicId, "kb_processing1", "../../invalid"],
      query: "住宿标准是多少",
    });

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith([readyBase], "住宿标准是多少", 6, "forced");
    expect(result.mode).toBe("manual");
    expect(result.context).toContain("不可信数据");
    expect(result.context).toContain("[知识1]");
    expect(result.context).toContain("差旅制度.pdf · 第 3 页");
    expect(result.sources[0].text).toContain("六百元");
  });

  it("automatically considers only shared enterprise and current-role knowledge", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    const role = { ...readyBase, id: 4, publicId: "kb_rolebase001", scope: "role", isGlobal: true, roleTemplate: "wealth-manager", name: "财富岗位知识" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([readyBase, enterprise, role]);

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: undefined,
      query: "客户适当性要求",
    });

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith([enterprise, role], "客户适当性要求", 4, "auto");
    expect(result.mode).toBe("auto");
  });

  it("does not inject sources when automatic relevance gating does not trigger", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);
    mocks.retrieveAcrossKnowledgeBases.mockResolvedValue({
      triggered: false,
      retrieval: "hybrid",
      metrics: { knowledgeBaseCount: 1, bm25MaxScore: 0, vectorMinDistance: 1.1 },
      results: [],
    });

    const result = await buildChatKnowledgeContext({ userId: 7, roleTemplate: "wealth-manager", requestedIds: [], query: "你好" });

    expect(result.context).toBe("");
    expect(result.sources).toEqual([]);
    expect(result.mode).toBe("auto");
  });

  it("strips expert handoff context and skips automatic retrieval for weather", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);
    const query = knowledgeRetrievalQuery(buildExpertHandoffRuntimeMessage("北京今晚还会下雨吗", {
      schema: "ea.expert_handoff.v1",
      expertName: "投研专家",
      status: "completed",
      latestSummary: "一段与天气无关的金融研究摘要".repeat(80),
    }));

    const result = await buildChatKnowledgeContext({ userId: 7, roleTemplate: "wealth-manager", requestedIds: [], query });

    expect(query).toBe("北京今晚还会下雨吗");
    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
    expect(result.retrieval).toBe("skipped");
    expect(result.sources).toEqual([]);
  });

  it("merges repeated chunks from the same displayed document", async () => {
    mocks.retrieveAcrossKnowledgeBases.mockResolvedValue({
      triggered: true,
      retrieval: "hybrid",
      metrics: { knowledgeBaseCount: 2, bm25MaxScore: 2.1, vectorMinDistance: 0.65 },
      results: [
        {
          chunkId: "source:1", score: 0.9, text: "第一段来源说明。", documentId: "doc_source1",
          documentName: "SOURCES.md", position: "正文", ordinal: 1,
          knowledgeBaseId: readyBase.publicId, knowledgeBaseName: readyBase.name,
        },
        {
          chunkId: "source:2", score: 0.8, text: "第二段来源说明。", documentId: "doc_source2",
          documentName: "SOURCES.md", position: "正文", ordinal: 2,
          knowledgeBaseId: "kb_otherbase1", knowledgeBaseName: "岗位知识",
        },
      ],
    });

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [readyBase.publicId],
      query: "制度来源",
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].text).toContain("第一段来源说明");
    expect(result.sources[0].text).toContain("第二段来源说明");
  });

  it("does not return retrieved passages to the browser source metadata", async () => {
    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [readyBase.publicId],
      query: "住宿标准是多少",
    });

    expect(publicChatKnowledgeSources(result.sources)).toEqual([{
      index: 1,
      knowledgeBaseId: readyBase.publicId,
      knowledgeBaseName: "制度库",
      documentId: "doc_policy001",
      documentName: "差旅制度.pdf",
      documentVersion: "1.0",
      position: "第 3 页",
      headingPath: [],
      page: null,
      sourceDepartment: "",
      authority: "reference",
    }]);
  });
});
