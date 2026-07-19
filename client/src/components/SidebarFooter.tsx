import React, { useEffect, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CircleHelp, Home, LogOut, Moon, Palette, Sun } from "lucide-react";
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
  return (
    String(version || "")
      .replace(/\s*\(.*\)\s*$/, "")
      .trim() || "unknown"
  );
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
              </div>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={collapsed ? "right" : "top"}
          align="start"
          sideOffset={8}
          className="workbench-account-menu min-w-60"
        >
          <DropdownMenuLabel className="sidebar-footer-account-details">
            <strong>{accountName}</strong>
            {accountEmail ? <span>{accountEmail}</span> : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onReturnHome}>
            <Home />
            首页
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sidebar-footer-help"
            aria-label="查看运行时版本"
            title="关于"
          >
            <CircleHelp size={17} strokeWidth={1.8} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={collapsed ? "right" : "top"}
          align={collapsed ? "start" : "end"}
          sideOffset={8}
          className="workbench-account-menu min-w-48"
        >
          <DropdownMenuLabel className="sidebar-footer-version">
            <span>运行时版本</span>
            <strong>{cleanVersion}</strong>
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
