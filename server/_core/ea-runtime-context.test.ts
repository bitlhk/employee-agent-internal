import { describe, expect, it } from "vitest";
import {
  stripEaInternalRuntimeContext,
  stripEaKnowledgeRuntimeContext,
  stripEaSelectedSkillRuntimeContext,
} from "@shared/ea-runtime-context";

describe("EA runtime context display cleanup", () => {
  it("keeps ordinary user text unchanged", () => {
    expect(stripEaInternalRuntimeContext("  帮我比较两只基金  ")).toBe("帮我比较两只基金");
  });

  it("extracts the visible request from knowledge context", () => {
    const runtime = [
      "<ea_knowledge_context>",
      "[知识1] 内部制度原文",
      "</ea_knowledge_context>",
      "",
      "<user_request>",
      "报销酒店的标准是多少？",
      "</user_request>",
    ].join("\n");
    expect(stripEaKnowledgeRuntimeContext(runtime)).toBe("报销酒店的标准是多少？");
  });

  it("also removes selected skill instructions nested in a knowledge request", () => {
    const runtime = [
      "<ea_knowledge_context>",
      "[知识1] 产品说明",
      "</ea_knowledge_context>",
      "<user_request>",
      "【本轮已由用户在输入框选择技能 Chip】",
      "selectedSkillId: fund-comparison",
      "要求：本轮必须优先使用用户选择的技能。",
      "",
      "用户问题：比较这两只基金",
      "</user_request>",
    ].join("\n");
    expect(stripEaInternalRuntimeContext(runtime)).toBe("比较这两只基金");
  });

  it("keeps malformed internal context visible instead of dropping the message", () => {
    const malformed = "【本轮已由用户在输入框选择技能 Chip】\nselectedSkillId: demo";
    expect(stripEaSelectedSkillRuntimeContext(malformed)).toBe(malformed);
  });
});
