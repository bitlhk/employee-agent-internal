import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarFooter } from "./SidebarFooter";

function renderFooter(collapsed = false) {
  return renderToStaticMarkup(
    React.createElement(SidebarFooter, {
      version: "JiuwenSwarm v0.2.3+ea.5",
      userName: "测试用户",
      userEmail: "user@example.com",
      collapsed,
      onReturnHome: vi.fn(),
      onOpenAppearance: vi.fn(),
      onLogout: vi.fn(),
    }),
  );
}

describe("SidebarFooter", () => {
  it("shows account identity beside the help menu when expanded", () => {
    const html = renderFooter();

    expect(html).toContain("测试用户");
    expect(html).toContain("user@example.com");
    expect(html).toContain('aria-label="打开帮助与账号菜单"');
  });

  it("keeps the help menu reachable when the sidebar is collapsed", () => {
    const html = renderFooter(true);

    expect(html).not.toContain("user@example.com");
    expect(html).toContain('aria-label="打开帮助与账号菜单"');
  });
});
