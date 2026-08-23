import { describe, expect, it } from "vitest";
import { applyXfyunIatResult, joinXfyunIatSegments } from "./voice";

describe("realtime IAT transcript assembly", () => {
  it("assembles incremental transcript segments in sequence", () => {
    const segments = new Map<number, string>();
    applyXfyunIatResult(segments, { sn: 1, ws: [{ cw: [{ w: "智能体" }] }] });
    applyXfyunIatResult(segments, { sn: 0, ws: [{ cw: [{ w: "岗位" }] }] });

    expect(joinXfyunIatSegments(segments)).toBe("岗位智能体");
  });

  it("replaces corrected dynamic-result segments", () => {
    const segments = new Map<number, string>([[0, "岗为"], [1, "智能体"]]);
    applyXfyunIatResult(segments, {
      sn: 2,
      pgs: "rpl",
      rg: [0, 1],
      ws: [{ cw: [{ w: "岗位智能体" }] }],
    });

    expect(joinXfyunIatSegments(segments)).toBe("岗位智能体");
  });
});
