import { describe, expect, it } from "vitest";

import { buildExpertHandoffRuntimeMessage, stripExpertHandoffRuntimeMessage } from "@shared/expert-handoff-context";

describe("expert handoff context", () => {
  it("adds bounded hidden context while preserving the visible user message", () => {
    const runtime = buildExpertHandoffRuntimeMessage("请继续分析", {
      schema: "ea.expert_handoff.v1",
      expertName: "报告专家",
      status: "completed",
      goal: "生成行业报告",
      latestSummary: "已完成初稿",
      artifacts: ["report.pdf"],
    });

    expect(runtime).toContain("EA_EXPERT_HANDOFF_V1");
    expect(runtime).toContain("report.pdf");
    expect(stripExpertHandoffRuntimeMessage(runtime)).toBe("请继续分析");
  });
});
