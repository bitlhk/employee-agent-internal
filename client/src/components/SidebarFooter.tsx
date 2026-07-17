import React from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CircleHelp, Home, LogOut, Settings } from "lucide-react";

type SidebarFooterProps = {
  version: string;
  userName?: string;
  userEmail?: string;
  collapsed?: boolean;
  onReturnHome: () => void;
  onOpenAppearance: () => void;
  onLogout: () => void;
};

function normalizeVersion(version: string) {
  return String(version || "").replace(/\s*\(.*\)\s*$/, "").trim() || "unknown";
}

export function SidebarFooter({
  version,
  userName,
  userEmail,
  collapsed = false,
  onReturnHome,
  onOpenAppearance,
  onLogout,
}: SidebarFooterProps) {
  const cleanVersion = normalizeVersion(version);
  const accountName = String(userName || userEmail || "账号").trim();
  const accountEmail = String(userEmail || "").trim();
  const showEmail = Boolean(accountEmail && accountEmail !== accountName);

  return (
    <div className={`sidebar-footer ${collapsed ? "is-collapsed" : ""}`}>
      {!collapsed ? (
        <div className="sidebar-footer-account">
          <Avatar className="sidebar-footer-avatar">
            <AvatarFallback className="sidebar-footer-avatar-fallback">
              {accountName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="sidebar-footer-identity">
            <strong title={accountName}>{accountName}</strong>
            {showEmail ? <span title={accountEmail}>{accountEmail}</span> : null}
          </div>
        </div>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sidebar-footer-help"
            aria-label="打开帮助与账号菜单"
            title="帮助与账号"
          >
            <CircleHelp size={17} strokeWidth={1.8} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={collapsed ? "right" : "top"}
          align={collapsed ? "start" : "end"}
          sideOffset={8}
          className="workbench-account-menu min-w-52"
        >
          <DropdownMenuLabel className="sidebar-footer-version">
            <span>运行时版本</span>
            <strong>{cleanVersion}</strong>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onReturnHome}>
            <Home />
            返回首页
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenAppearance}>
            <Settings />
            外观设置
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onLogout}>
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
