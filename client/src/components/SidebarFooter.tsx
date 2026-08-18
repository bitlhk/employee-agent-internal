import React, { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Home, LogOut, Moon, Palette, Sun } from "lucide-react";
import { applySettings, getSettings, subscribeSettings } from "@/lib/settings";
import type { ThemeMode } from "@/types/settings";

type SidebarFooterProps = {
  version: string;
  userName?: string;
  userEmail?: string;
  collapsed?: boolean;
  onReturnHome: () => void;
  onLogout: () => void;
};

function normalizeVersion(version: string) {
  const normalized = String(version || "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
  const versionNumber = normalized.match(/\bv?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?\b/i)?.[0];
  if (versionNumber) return versionNumber.startsWith("v") ? versionNumber : `v${versionNumber}`;
  return normalized || "unknown";
}

export function SidebarFooter({
  version,
  userName,
  userEmail,
  collapsed = false,
  onReturnHome,
  onLogout,
}: SidebarFooterProps) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    getSettings().themeMode
  );
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountPointerDismissRef = useRef(false);
  const cleanVersion = normalizeVersion(version);
  const accountName = String(userName || userEmail || "账号").trim();
  const accountEmail = String(userEmail || "").trim();
  const activeThemeMode =
    themeMode === "system"
      ? typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : themeMode;

  useEffect(
    () => subscribeSettings(settings => setThemeMode(settings.themeMode)),
    []
  );

  const selectThemeMode = (mode: "light" | "dark") => {
    setThemeMode(mode);
    applySettings({ themeMode: mode });
  };

  return (
    <div className={`sidebar-footer ${collapsed ? "is-collapsed" : ""}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={accountTriggerRef}
            type="button"
            className="sidebar-footer-account"
            aria-label="打开账号菜单"
            title={collapsed ? accountName : undefined}
          >
            <Avatar className="sidebar-footer-avatar">
              <AvatarFallback className="sidebar-footer-avatar-fallback">
                {accountName.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {!collapsed ? (
              <div className="sidebar-footer-identity">
                <strong title={accountName}>{accountName}</strong>
                <span className="sidebar-footer-runtime" title={cleanVersion}>{cleanVersion}</span>
              </div>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={collapsed ? "right" : "top"}
          align="start"
          sideOffset={8}
          className="workbench-account-menu min-w-60"
          onPointerDownOutside={() => {
            accountPointerDismissRef.current = true;
          }}
          onEscapeKeyDown={() => {
            accountPointerDismissRef.current = false;
          }}
          onCloseAutoFocus={(event) => {
            if (!accountPointerDismissRef.current) return;
            event.preventDefault();
            accountPointerDismissRef.current = false;
            accountTriggerRef.current?.blur();
          }}
        >
          <DropdownMenuLabel className="sidebar-footer-account-details">
            <strong>{accountName}</strong>
            {accountEmail ? <span>{accountEmail}</span> : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onReturnHome}>
            <Home />
            返回岗位列表
          </DropdownMenuItem>
          <div
            className="workbench-appearance-row"
            role="group"
            aria-label="外观"
          >
            <span className="workbench-appearance-label">
              <Palette />
              外观
            </span>
            <span className="workbench-theme-options">
              <button
                type="button"
                data-active={activeThemeMode === "light" ? "true" : "false"}
                aria-pressed={activeThemeMode === "light"}
                onClick={() => selectThemeMode("light")}
              >
                <Sun />
                浅色
              </button>
              <button
                type="button"
                data-active={activeThemeMode === "dark" ? "true" : "false"}
                aria-pressed={activeThemeMode === "dark"}
                onClick={() => selectThemeMode("dark")}
              >
                <Moon />
                深色
              </button>
            </span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onLogout}>
            <LogOut />
            退出
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <nav className="sidebar-footer-repositories" aria-label="开源代码仓">
        <a
          href="https://atomgit.com/openJiuwen"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="访问 openJiuwen 开源社区"
          title="openJiuwen 开源社区"
        >
          <img src="/images/jiuwen-logo.png" alt="" aria-hidden="true" />
        </a>
        <a
          href="https://atomgit.com/linggan_ai/employee-agent"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="访问 Employee Agent 代码仓"
          title="Employee Agent 代码仓"
        >
          <img src="/images/atomgit.png" alt="" aria-hidden="true" />
        </a>
      </nav>
    </div>
  );
}
