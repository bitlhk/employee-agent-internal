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
