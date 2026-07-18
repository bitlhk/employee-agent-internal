import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarFooter } from "./SidebarFooter";

function renderFooter(collapsed = false) {
  return renderToStaticMarkup(
    React.createElement(SidebarFooter, {
      version: "JiuwenSwarm v0.2.3+ea.6",
      userName: "测试用户",
      userEmail: "user@example.com",
      collapsed,
      onReturnHome: vi.fn(),
      onLogout: vi.fn(),
    })
  );
}

describe("SidebarFooter", () => {
  it("uses the account identity as the account-menu trigger", () => {
    const html = renderFooter();

    expect(html).toContain("测试用户");
    expect(html).toContain("user@example.com");
    expect(html).toContain('aria-label="打开账号菜单"');
    expect(html).toContain('aria-label="查看运行时版本"');
  });

  it("keeps account and version menus reachable when the sidebar is collapsed", () => {
    const html = renderFooter(true);

    expect(html).not.toContain("user@example.com");
    expect(html).toContain('aria-label="打开账号菜单"');
    expect(html).toContain('aria-label="查看运行时版本"');
  });
});
