import { describe, expect, it } from "vitest";
import {
  OPENCLAW_RUNTIME_RETIRED,
  isActiveJiuwenAdoptId,
  resolveActiveAgentRuntime,
  retiredRuntimeMessage,
} from "./runtime-policy";

describe("active runtime policy", () => {
  it("keeps JiuwenSwarm adoptions active", () => {
    expect(resolveActiveAgentRuntime("lgj-example")).toBe("jiuwenclaw");
    expect(isActiveJiuwenAdoptId("lgj-example")).toBe(true);
  });

  it("archives former OpenClaw and legacy adoptions", () => {
    expect(resolveActiveAgentRuntime("lgc-example")).toBe("legacy_archived");
    expect(resolveActiveAgentRuntime("lgh-example")).toBe("legacy_archived");
    expect(isActiveJiuwenAdoptId("lgc-example")).toBe(false);
  });

  it("fails closed for unknown identifiers", () => {
    expect(resolveActiveAgentRuntime("custom-example")).toBe("unsupported");
    expect(resolveActiveAgentRuntime("")).toBe("unsupported");
  });

  it("declares the retired runtime policy explicitly", () => {
    expect(OPENCLAW_RUNTIME_RETIRED).toBe(true);
    expect(retiredRuntimeMessage()).toContain("retired");
  });
});
