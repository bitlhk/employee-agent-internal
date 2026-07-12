import { describe, expect, it } from "vitest";
import { PlatformIdentityError, resolvePlatformAdoptId } from "./platform-tools-mcp";

describe("Platform MCP trusted identity", () => {
  it("uses the runtime identity when the model omits adoptId", () => {
    expect(resolvePlatformAdoptId("lgj-owner", {})).toBe("lgj-owner");
  });

  it("accepts a matching legacy argument for compatibility", () => {
    expect(resolvePlatformAdoptId("lgj-owner", { adoptId: "lgj-owner" })).toBe("lgj-owner");
    expect(resolvePlatformAdoptId("lgj-owner", { adopt_id: "lgj-owner" })).toBe("lgj-owner");
  });

  it("rejects cross-agent and argument-only identities", () => {
    expect(() => resolvePlatformAdoptId("lgj-owner", { adoptId: "lgj-other" }))
      .toThrow(PlatformIdentityError);
    expect(() => resolvePlatformAdoptId("", { adoptId: "lgj-other" }))
      .toThrow(/cannot establish identity/);
  });

  it("returns no identity when neither source provides one", () => {
    expect(resolvePlatformAdoptId("", {})).toBe("");
  });
});
