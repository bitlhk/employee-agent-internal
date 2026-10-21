import { describe, expect, it } from "vitest";
import { isPageKey, isSidebarNavItemActive, primaryItems, sidebarPrimaryItems } from "./Sidebar";

describe("workbench page keys", () => {
  it("accepts current pages and rejects stale session values", () => {
    expect(isPageKey("chat")).toBe(true);
    expect(isPageKey("experts")).toBe(true);
    expect(isPageKey("connectors")).toBe(true);
    expect(isPageKey("agent")).toBe(true);
    expect(isPageKey("settings")).toBe(true);
    expect(isPageKey("channels")).toBe(false);
    expect(isPageKey("weixin")).toBe(false);
    expect(isPageKey("agentLab")).toBe(false);
    expect(isPageKey("removed-page")).toBe(false);
  });
});

describe("sidebar selection", () => {
  it("adds a calendar utility only when enabled and preserves all historical navigation", () => {
    expect(sidebarPrimaryItems()).toEqual(primaryItems);
    const enabled = sidebarPrimaryItems(true);
    expect(enabled.slice(0, primaryItems.length)).toEqual(primaryItems);
    expect(enabled.at(-1)).toMatchObject({ key: "calendar", label: "我的日历" });
    expect(isPageKey("calendar")).toBe(true);
  });
  it("keeps navigation and history selection mutually exclusive", () => {
    expect(isSidebarNavItemActive("chat", "chat", true)).toBe(true);
    expect(isSidebarNavItemActive("chat", "chat", false)).toBe(false);
    expect(isSidebarNavItemActive("skills", "chat", true)).toBe(false);
  });

  it("presents the chat workspace as the role home entry", () => {
    const home = primaryItems.find(item => item.key === "chat");

    expect(home?.label).toBe("主页");
    expect(primaryItems.some(item => item.label === "聊天")).toBe(false);
  });
});
