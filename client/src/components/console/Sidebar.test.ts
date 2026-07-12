import { describe, expect, it } from "vitest";
import { isPageKey } from "./Sidebar";

describe("workbench page keys", () => {
  it("accepts current pages and rejects stale session values", () => {
    expect(isPageKey("chat")).toBe(true);
    expect(isPageKey("agent")).toBe(true);
    expect(isPageKey("settings")).toBe(true);
    expect(isPageKey("agentLab")).toBe(false);
    expect(isPageKey("removed-page")).toBe(false);
  });
});
