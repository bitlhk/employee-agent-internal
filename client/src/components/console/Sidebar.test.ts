import { describe, expect, it } from "vitest";
import { isPageKey, isSidebarNavItemActive } from "./Sidebar";

describe("workbench page keys", () => {
  it("accepts current pages and rejects stale session values", () => {
    expect(isPageKey("chat")).toBe(true);
    expect(isPageKey("agent")).toBe(true);
    expect(isPageKey("settings")).toBe(true);
    expect(isPageKey("agentLab")).toBe(false);
    expect(isPageKey("removed-page")).toBe(false);
  });
});

describe("sidebar selection", () => {
  it("keeps navigation and history selection mutually exclusive", () => {
    expect(isSidebarNavItemActive("chat", "chat", true)).toBe(true);
    expect(isSidebarNavItemActive("chat", "chat", false)).toBe(false);
    expect(isSidebarNavItemActive("skills", "chat", true)).toBe(false);
  });
});
