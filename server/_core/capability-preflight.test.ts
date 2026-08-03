import { describe, expect, it } from "vitest";
import { summarizeCapabilityPreflight } from "../../shared/capability-preflight";

describe("capability preflight", () => {
  it("blocks only explicit unavailable capabilities", () => {
    const result = summarizeCapabilityPreflight([
      { kind: "model", id: "m1", name: "Model", readiness: "ready" },
      { kind: "connector", id: "c1", name: "Connector", readiness: "unchecked" },
      { kind: "skill", id: "s1", name: "Skill", readiness: "blocked", reason: "未启用" },
    ]);
    expect(result.ready).toBe(false);
    expect(result.blocked.map((item) => item.id)).toEqual(["s1"]);
    expect(result.unchecked.map((item) => item.id)).toEqual(["c1"]);
  });
});
