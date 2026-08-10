import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  listAccessibleKnowledgeBases: vi.fn(),
  listKnowledgeDocumentsForBases: vi.fn(),
  retrieveAcrossKnowledgeBases: vi.fn(),
}));

vi.mock("../db", () => ({
  getUserById: mocks.getUserById,
  listAccessibleKnowledgeBases: mocks.listAccessibleKnowledgeBases,
  listKnowledgeDocumentsForBases: mocks.listKnowledgeDocumentsForBases,
}));

vi.mock("./knowledge-service", () => ({
  retrieveAcrossKnowledgeBases: mocks.retrieveAcrossKnowledgeBases,
}));

import {
  buildChatKnowledgeContext,
  knowledgeRetrievalQuery,
  publicChatKnowledgeSources,
  selectAutomaticKnowledgeBases,
} from "./knowledge-context";
import { buildExpertHandoffRuntimeMessage } from "../../shared/expert-handoff-context";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";

const readyBase: KnowledgeBaseRecord = {
  id: 1,
  publicId: "kb_readybase1",
  ownerUserId: 7,
  ownerGroupId: 3,
  scope: "personal",
  isGlobal: false,
  roleTemplate: null,
  name: "制度库",
  description: "",
  classification: "internal",
  externalProcessingAllowed: true,
  status: "ready",
  documentCount: 1,
  chunkCount: 2,
  lastError: null,
  indexVersion: null,
  indexSchemaVersion: 2,
  indexedAt: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function readyDocument(knowledgeBaseId: number): KnowledgeDocumentRecord {
  return {
    id: knowledgeBaseId,
    publicId: `doc_policy${String(knowledgeBaseId).padStart(3, "0")}`,
    knowledgeBaseId,
    name: "差旅制度.pdf",
    extension: "pdf",
    mimeType: "application/pdf",
    storagePath: `documents/${knowledgeBaseId}.pdf`,
    sizeBytes: 10,
    sha256: "a".repeat(64),
    versionLabel: "1.0",
    lifecycle: "active",
    sourceDepartment: "",
    classification: "internal",
    authority: "reference",
    externalProcessingAllowed: true,
    effectiveAt: null,
    expiresAt: null,
    status: "ready",
    chunkCount: 1,
    lastError: null,
    parserVersion: "2.1",
    indexVersion: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("knowledge chat context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({ id: 7, groupId: 3, role: "user" });
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([
      readyBase,
      { ...readyBase, id: 2, publicId: "kb_processing1", status: "indexing" },
    ]);
    mocks.listKnowledgeDocumentsForBases.mockImplementation(async (ids: number[]) => ids.map(readyDocument));
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

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith(
      [readyBase], "住宿标准是多少", 6, "forced",
      expect.objectContaining({ documentIds: ["doc_policy001"] }),
    );
    expect(result.mode).toBe("manual");
    expect(result.context).toContain("不可信数据");
    expect(result.context).toContain("[知识1]");
    expect(result.context).toContain("差旅制度.pdf · 第 3 页");
    expect(result.context).toContain("统计期间、单位和口径");
    expect(result.context).toContain("资料发布方预计");
    expect(result.context).toContain("不得扩写成资料未提供");
    expect(result.context).toContain("转换与创作任务");
    expect(result.context).toContain("不强制在交付正文的每段插入引用");
    expect(result.context).toContain("至少 3 个可按相同指标和口径比较");
    expect(result.context).toContain("必须静默完成证据自检");
    expect(result.context).toContain("至少两个可比期间");
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

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith(
      [role, enterprise], "客户适当性要求", 4, "auto",
      expect.objectContaining({ documentIds: ["doc_policy003", "doc_policy004"] }),
    );
    expect(result.mode).toBe("auto");
    expect(result.metrics.routeReason).toBe("governed-topic");
    expect(result.metrics.routedBaseCount).toBe(2);
  });

  it("routes governed wealth-manager task requests through role knowledge", async () => {
    const role = {
      ...readyBase,
      id: 4,
      publicId: "kb_rolebase001",
      scope: "role" as const,
      isGlobal: true,
      roleTemplate: "wealth-manager",
      name: "财富经理岗位操作规范",
      description: "客户访前准备、资产配置与客户经营",
    };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([role]);

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [],
      query: "明天下午要拜访这位客户，帮我准备访前简报和沟通提纲",
    });

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith(
      [role],
      "明天下午要拜访这位客户，帮我准备访前简报和沟通提纲",
      4,
      "auto",
      expect.objectContaining({ documentIds: ["doc_policy004"] }),
    );
    expect(result.metrics.routeReason).toBe("governed-topic");
  });

  it("does not treat general substantive questions or broad business nouns as knowledge intent", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    for (const query of [
      "最新的 Kimi K3 为什么比较强",
      "人工智能实施行动计划已经发布了吗",
      "帮我分析一下这个客户的产品偏好",
      "这个业务未来会怎么发展",
    ]) {
      const result = await buildChatKnowledgeContext({
        userId: 7,
        roleTemplate: "wealth-manager",
        requestedIds: [],
        query,
      });
      expect(result.retrieval).toBe("skipped");
      expect(result.metrics.routeReason).toMatch(/^skipped-/);
    }

    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
  });

  it("routes only the two most relevant automatic knowledge bases", () => {
    const role: KnowledgeBaseRecord = {
      ...readyBase,
      id: 4,
      publicId: "kb_rolebase001",
      scope: "role",
      roleTemplate: "wealth-manager",
      name: "财富经理岗位知识",
      description: "客户经营与资产配置",
    };
    const travel: KnowledgeBaseRecord = {
      ...readyBase,
      id: 5,
      publicId: "kb_travel001",
      scope: "enterprise",
      name: "差旅报销制度",
      description: "住宿、机票和审批标准",
    };
    const aml: KnowledgeBaseRecord = {
      ...readyBase,
      id: 6,
      publicId: "kb_aml000001",
      scope: "enterprise",
      name: "反洗钱指引",
      description: "客户尽职调查与可疑交易",
    };

    expect(selectAutomaticKnowledgeBases([role, aml, travel], "差旅报销的住宿标准是多少")).toEqual([
      travel,
      role,
    ]);
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

  it("skips automatic retrieval for conversation and memory meta questions", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    for (const query of ["是第一次对话吗", "这是我们第一次对话吗", "你还记得我吗", "上次我们聊了什么", "你的记忆文件是空的吗"]) {
      const result = await buildChatKnowledgeContext({
        userId: 7,
        roleTemplate: "wealth-manager",
        requestedIds: [],
        query,
      });
      expect(result.retrieval).toBe("skipped");
      expect(result.sources).toEqual([]);
    }
    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
  });

  it("skips automatic retrieval for platform model questions", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    for (const query of ["你用的什么模型啊", "你现在使用的是哪个模型", "当前对话选择了什么模型", "你的模型版本是什么"]) {
      const result = await buildChatKnowledgeContext({
        userId: 7,
        roleTemplate: "wealth-manager",
        requestedIds: [],
        query,
      });
      expect(result.retrieval).toBe("skipped");
      expect(result.sources).toEqual([]);
    }
    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
  });

  it("keeps automatic retrieval for business questions about model governance", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [],
      query: "根据模型风险管理规范说明模型验证要求",
    });

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith(
      [enterprise],
      "根据模型风险管理规范说明模型验证要求",
      4,
      "auto",
      expect.objectContaining({ documentIds: ["doc_policy003"] }),
    );
  });

  it("skips automatic retrieval for open-ended trend discussion without enterprise context", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [],
      query: "你怎么看最近的人工智能趋势？我感觉模型开始转向持续学习",
    });

    expect(result.retrieval).toBe("skipped");
    expect(result.sources).toEqual([]);
    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
  });

  it("does not let a generic policy word override an open-ended discussion", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [],
      query: "你怎么看全球人工智能政策的未来趋势",
    });

    expect(result.retrieval).toBe("skipped");
    expect(result.metrics.routeReason).toBe("skipped-open-discussion");
    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
  });

  it("keeps automatic retrieval for an enterprise question phrased as an opinion", async () => {
    const enterprise = { ...readyBase, id: 3, publicId: "kb_enterprise1", scope: "enterprise", isGlobal: true, name: "企业制度" };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([enterprise]);

    await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [],
      query: "你怎么看本行客户信息分级制度",
    });

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith(
      [enterprise],
      "你怎么看本行客户信息分级制度",
      4,
      "auto",
      expect.objectContaining({ documentIds: ["doc_policy003"] }),
    );
  });

  it("honors an explicit knowledge selection for a conversation meta question", async () => {
    await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [readyBase.publicId],
      query: "这是我们第一次对话吗",
    });

    expect(mocks.retrieveAcrossKnowledgeBases).toHaveBeenCalledWith(
      [readyBase],
      "这是我们第一次对话吗",
      6,
      "forced",
      expect.objectContaining({ documentIds: ["doc_policy001"] }),
    );
  });

  it("does not call retrieval when governance excludes every selected document", async () => {
    mocks.listKnowledgeDocumentsForBases.mockResolvedValue([
      { ...readyDocument(1), expiresAt: "2025-01-01T00:00:00.000Z" },
    ]);

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [readyBase.publicId],
      query: "住宿标准是多少",
    });

    expect(result.retrieval).toBe("governed-empty");
    expect(result.metrics.eligibleFilteredOut).toBe(1);
    expect(result.context).toContain("未通过当前有效性校验");
    expect(result.context).toContain("不得使用模型参数知识");
    expect(result.evidence).toEqual(expect.objectContaining({
      contextEligibilityFingerprint: expect.any(String),
      selectedKnowledgeIds: [],
    }));
    expect(mocks.retrieveAcrossKnowledgeBases).not.toHaveBeenCalled();
  });

  it("does not reveal restricted knowledge details when every candidate is denied", async () => {
    const restrictedBase = {
      ...readyBase,
      scope: "role" as const,
      roleTemplate: "wealth-manager",
      ownerUserId: 99,
    };
    mocks.listAccessibleKnowledgeBases.mockResolvedValue([restrictedBase]);
    mocks.listKnowledgeDocumentsForBases.mockResolvedValue([
      { ...readyDocument(1), classification: "restricted" },
    ]);

    const result = await buildChatKnowledgeContext({
      userId: 7,
      roleTemplate: "wealth-manager",
      requestedIds: [restrictedBase.publicId],
      query: "根据制度准备客户访前材料",
    });

    expect(result.context).toContain("没有可授权用于本次任务的企业知识依据");
    expect(result.context).not.toContain("restricted");
    expect(result.context).not.toContain("差旅制度");
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
    expect(result.context).toContain("不得引用“此前检索、先前回答、历史对话中看到过”的事实");
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
      chunkId: "doc_policy001:1",
      parentId: "doc_policy001:1",
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
