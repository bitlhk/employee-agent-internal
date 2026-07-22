import { describe, expect, it } from "vitest";

import {
  expertSupportsAttachments,
  expertTaskMessage,
  normalizeExpertAgents,
} from "./expert-agents";

describe("expert agents", () => {
  it("normalizes and prioritizes ready experts", () => {
    const experts = normalizeExpertAgents({
      agents: [
        { id: "offline", name: "离线专家", routeReady: false },
        { id: "alice", name: "万得金融专家", routeReady: true, capabilities: ["a2a"], usageCount: 12 },
      ],
    });

    expect(experts.map((expert) => expert.id)).toEqual(["alice", "offline"]);
    expect(experts[0].usageCount).toBe(12);
    expect(experts[1].usageCount).toBe(0);
  });

  it("detects declared attachment support", () => {
    const [expert] = normalizeExpertAgents({
      agents: [{ id: "files", name: "文件专家", routeReady: true, capabilities: ["files"] }],
    });

    expect(expertSupportsAttachments(expert)).toBe(true);
  });

  it("keeps the personal expert source marker", () => {
    const [expert] = normalizeExpertAgents({
      agents: [{ id: "mine", name: "我的专家", source: "personal", routeReady: true }],
    });

    expect(expert.source).toBe("personal");
    expect(expert.interactionMode).toBe("single");
  });

  it("keeps the continuous interaction mode advertised by an expert", () => {
    const [expert] = normalizeExpertAgents({
      agents: [{ id: "session", name: "PPT 专家", interactionMode: "session", routeReady: true }],
    });

    expect(expert.interactionMode).toBe("session");
  });

  it("uses natural task copy without exposing the internal task id", () => {
    expect(expertTaskMessage("万得金融专家", "agt_12345678")).toBe(
      "**万得金融专家** 已接手，正在为你处理。",
    );
    expect(expertTaskMessage("万得金融专家", "agt_12345678", true)).toBe(
      "好的，已将你的选择交给 **万得金融专家**，它会继续处理。",
    );
  });
});
