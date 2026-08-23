import { describe, expect, it } from "vitest";
import { parseRtasrResult } from "./voice";

describe("parseRtasrResult", () => {
  it("extracts transcript and stable segment identity", () => {
    const result = parseRtasrResult(JSON.stringify({
      code: "0",
      action: "result",
      data: JSON.stringify({
        cn: { st: { bg: "120", rt: [{ ws: [{ cw: [{ w: "岗位" }] }, { cw: [{ w: "智能体" }] }] }] } },
      }),
    }));

    expect(result).toMatchObject({ code: "0", text: "岗位智能体", segmentId: "120" });
  });

  it("preserves upstream errors", () => {
    expect(parseRtasrResult(JSON.stringify({ code: "10110", desc: "invalid signa" })))
      .toMatchObject({ code: "10110", desc: "invalid signa", text: "" });
  });
});
