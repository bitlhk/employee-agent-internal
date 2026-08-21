import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callEaAssistantModel: vi.fn() }));

vi.mock("./ea-assistant-model", () => ({ callEaAssistantModel: mocks.callEaAssistantModel }));

import { planKnowledgeQueries, shouldDecomposeKnowledgeQuery } from "./knowledge-query-planner";

describe("knowledge query planner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps simple questions on the single-query path", async () => {
    expect(shouldDecomposeKnowledgeQuery("住宿标准是多少")).toBe(false);
    await expect(planKnowledgeQueries("住宿标准是多少")).resolves.toEqual({
      queries: ["住宿标准是多少"],
      expansion: "skipped",
    });
    expect(mocks.callEaAssistantModel).not.toHaveBeenCalled();
  });

  it("deterministically decomposes explicit dimensions into retrieval-oriented searches", async () => {
    const original = "综合说明长鑫科技的核心业务、全球竞争地位和主要经营风险，每项结论标注来源页";

    await expect(planKnowledgeQueries(original)).resolves.toEqual({
      queries: [
        original,
        "长鑫科技 主营业务 主要产品 业务模式",
        "长鑫科技 全球竞争地位 市场份额 行业排名 竞争格局",
        "长鑫科技 风险因素 与发行人相关的风险 特别风险提示",
      ],
      expansion: "applied",
    });
    expect(mocks.callEaAssistantModel).not.toHaveBeenCalled();
  });

  it("decomposes product source and hard checks into evidence-oriented policy queries", async () => {
    const original = "资产配置方案筛选候选产品时，产品来源和硬性检查有什么要求？";

    await expect(planKnowledgeQueries(original, { deterministicOnly: true })).resolves.toEqual({
      queries: [
        original,
        "候选产品来源 当前可售集合",
        "正式产品推荐 前置条件",
        "产品风险等级匹配",
        "产品状态与渠道",
      ],
      expansion: "applied",
    });
    expect(mocks.callEaAssistantModel).not.toHaveBeenCalled();
  });

  it("decomposes before-and-after operational evidence without a model", async () => {
    const original = "创建客户跟进任务前需要确认哪些内容，执行后如何避免重复写入？";

    await expect(planKnowledgeQueries(original, { deterministicOnly: true })).resolves.toEqual({
      queries: [original, "创建客户跟进任务前需要确认哪些内容", "执行后如何避免重复写入"],
      expansion: "applied",
    });
    expect(mocks.callEaAssistantModel).not.toHaveBeenCalled();
  });

  it("does not call a model when deterministic-only planning has no rule", async () => {
    const original = "请分别说明产品适用对象、具体执行条件以及例外处理方式";

    await expect(planKnowledgeQueries(original, { deterministicOnly: true })).resolves.toEqual({
      queries: [original],
      expansion: "fallback",
    });
    expect(mocks.callEaAssistantModel).not.toHaveBeenCalled();
  });

  it("uses the model for compound questions without an explicit subject and dimension list", async () => {
    mocks.callEaAssistantModel.mockResolvedValue({
      content: JSON.stringify({ queries: ["产品适用对象", "产品例外条件"] }),
    });
    const original = "请分别说明产品适用对象、具体执行条件以及例外处理方式";
    await expect(planKnowledgeQueries(original)).resolves.toEqual({
      queries: [original, "产品适用对象", "产品例外条件"],
      expansion: "applied",
    });
  });

  it("falls back to the original query when the model is unavailable", async () => {
    mocks.callEaAssistantModel.mockRejectedValue(new Error("timeout"));
    const original = "请分别说明产品范围、适用客户以及主要风险";
    await expect(planKnowledgeQueries(original)).resolves.toEqual({ queries: [original], expansion: "fallback" });
  });
});
