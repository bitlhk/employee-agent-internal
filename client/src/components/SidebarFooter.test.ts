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
    expect(html).not.toContain("user@example.com");
    expect(html).toContain('aria-label="打开账号菜单"');
    expect(html).toContain("v0.2.3+ea.6");
    expect(html).not.toContain("JiuwenSwarm v0.2.3+ea.6");
    expect(html).not.toContain("运行时 ·");
    expect(html).toContain('aria-label="访问 openJiuwen 开源社区"');
    expect(html).toContain('aria-label="访问 Employee Agent 代码仓"');
  });

  it("keeps the account and repository links reachable when the sidebar is collapsed", () => {
    const html = renderFooter(true);

    expect(html).not.toContain("user@example.com");
    expect(html).not.toContain("v0.2.3+ea.6");
    expect(html).toContain('aria-label="打开账号菜单"');
    expect(html).toContain('aria-label="访问 openJiuwen 开源社区"');
    expect(html).toContain('aria-label="访问 Employee Agent 代码仓"');
  });
});
