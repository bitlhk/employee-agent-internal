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
        { id: "alice", name: "万得金融专家", routeReady: true, capabilities: ["a2a"] },
      ],
    });

    expect(experts.map((expert) => expert.id)).toEqual(["alice", "offline"]);
  });

  it("detects declared attachment support", () => {
    const [expert] = normalizeExpertAgents({
      agents: [{ id: "files", name: "文件专家", routeReady: true, capabilities: ["files"] }],
    });

    expect(expertSupportsAttachments(expert)).toBe(true);
  });

  it("keeps the task id in the assistant marker text", () => {
    expect(expertTaskMessage("万得金融专家", "agt_12345678")).toBe(
      "已提交任务给 **万得金融专家**，完成后结果会自动写回。\n\n任务编号：`agt_12345678`",
    );
  });
});
