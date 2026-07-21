import { describe, expect, it } from "vitest";

import {
  agentInteractionAgentInput,
  agentInteractionResponseText,
  parseAgentInteraction,
  parseAgentInteractionResponse,
} from "@shared/agent-interaction";

const interaction = parseAgentInteraction({
  schema: "ea.interaction.v1",
  interactionId: "ppt-outline-1",
  type: "single_choice",
  title: "请选择演示文稿风格",
  options: [
    { id: "consulting", label: "咨询报告", recommended: true },
    { id: "briefing", label: "领导汇报" },
  ],
  allowCustom: true,
  allowNote: true,
  submitMode: "confirm",
});

describe("agent interaction contract", () => {
  it("normalizes a valid interaction", () => {
    expect(interaction).toMatchObject({
      interactionId: "ppt-outline-1",
      submitMode: "confirm",
    });
    expect(interaction?.options[0]).toEqual({ id: "consulting", label: "咨询报告", recommended: true });
  });

  it("rejects duplicate or malformed options", () => {
    expect(parseAgentInteraction({
      schema: "ea.interaction.v1",
      interactionId: "choice-1",
      type: "single_choice",
      title: "Choose",
      options: [{ id: "same", label: "A" }, { id: "same", label: "B" }],
    })).toBeNull();
  });

  it("validates and formats a response", () => {
    expect(interaction).not.toBeNull();
    const response = parseAgentInteractionResponse({
      interactionId: "ppt-outline-1",
      optionId: "consulting",
      note: "控制在 12 页",
    }, interaction!);

    expect(response).not.toBeNull();
    expect(agentInteractionResponseText(interaction!, response!)).toBe("咨询报告\n补充：控制在 12 页");
    expect(agentInteractionAgentInput(interaction!, response!)).toContain("选择：咨询报告");
  });

  it("rejects an option outside the current prompt", () => {
    expect(parseAgentInteractionResponse({
      interactionId: "ppt-outline-1",
      optionId: "unknown",
    }, interaction!)).toBeNull();
  });
});
