import { describe, expect, it } from "vitest";
import { applyXfyunIatResult, joinXfyunIatSegments } from "./voice";

describe("Xfyun dynamic transcription assembly", () => {
  it("keeps only the highest-confidence word candidate", () => {
    const segments = new Map<number, string>();

    applyXfyunIatResult(segments, {
      sn: 0,
      ws: [
        { cw: [{ w: "上海" }, { w: "商海" }] },
        { cw: [{ w: "天气" }, { w: "天际" }] },
      ],
    });

    expect(joinXfyunIatSegments(segments)).toBe("上海天气");
  });

  it("replaces superseded partial segments instead of duplicating them", () => {
    const segments = new Map<number, string>();
    applyXfyunIatResult(segments, { sn: 0, ws: [{ cw: [{ w: "明天" }] }] });
    applyXfyunIatResult(segments, { sn: 1, ws: [{ cw: [{ w: "下午" }] }] });
    applyXfyunIatResult(segments, {
      sn: 2,
      pgs: "rpl",
      rg: [0, 1],
      ws: [{ cw: [{ w: "明天下午两点" }] }],
    });

    expect(joinXfyunIatSegments(segments)).toBe("明天下午两点");
  });
});
