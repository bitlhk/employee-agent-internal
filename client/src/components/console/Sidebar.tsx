import {
  Bot,
  BookOpen,
  Brain,
  House,
  Library,
  Plug,
  Timer,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { SessionList, type SessionListConversation } from "./SessionList";

export type PageKey = "chat" | "skills" | "experts" | "connectors" | "agent" | "knowledge" | "workspace" | "schedule" | "collab" | "settings";

type NavItem = { key: PageKey; label: string; icon: any; adminOnly?: boolean };

export type SidebarConversation = SessionListConversation;

export const primaryItems: NavItem[] = [
  { key: "chat", label: "主页", icon: House },
  { key: "skills", label: "技能", icon: Library },
  { key: "experts", label: "专家", icon: Bot },
  { key: "connectors", label: "连接器", icon: Plug },
  { key: "collab", label: "协作", icon: Users },
  { key: "schedule", label: "定时任务", icon: Timer },
];

const secondaryItems: NavItem[] = [
  { key: "agent", label: "记忆", icon: Brain },
  { key: "knowledge", label: "知识", icon: BookOpen },
];

const PAGE_KEYS = new Set<PageKey>(["chat", "skills", "experts", "connectors", "agent", "knowledge", "workspace", "schedule", "collab", "settings"]);

export function isPageKey(value: unknown): value is PageKey {
  return PAGE_KEYS.has(String(value || "") as PageKey);
}

export function isSidebarNavItemActive(
  activePage: PageKey,
  itemKey: PageKey,
  navigationSelectionActive: boolean,
): boolean {
  return navigationSelectionActive && activePage === itemKey;
}

export function Sidebar({
  activePage,
  setActivePage,
  navigationSelectionActive = true,
  collapsed,
  coopBadge,
  sessions = [],
  currentConversationId,
  messageSearchProvider,
  onSwitchConversation,
  onDeleteConversation,
  onRenameConversation,
  onTogglePinConversation,
  onNewConversation,
  onOpenHome,
  sessionsLoading,
  footer,
}: {
  activePage: PageKey;
  setActivePage: (k: PageKey) => void;
  navigationSelectionActive?: boolean;
  collapsed?: boolean;
  coopBadge?: number;
  sessions?: SidebarConversation[];
  currentConversationId?: string;
  messageSearchProvider?: (conversationId: string, query: string) => string;
  onSwitchConversation?: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => void;
  onRenameConversation?: (conversationId: string, title: string) => void;
  onTogglePinConversation?: (conversationId: string, pinned: boolean) => void;
  onNewConversation?: () => void;
  onOpenHome?: () => void;
  sessionsLoading?: boolean;
  footer?: ReactNode;
}) {
  const renderItem = (it: NavItem) => {
          const Icon = it.icon;
          const active = isSidebarNavItemActive(activePage, it.key, navigationSelectionActive);
          return (
            <div key={it.key} className="flex flex-col">
              <button
                title={it.label}
                onClick={() => it.key === "chat" && onOpenHome ? onOpenHome() : setActivePage(it.key)}
                className={`w-full flex items-center text-left sidebar-item relative ${active ? "active" : ""}`}
              >
                <Icon size={18} strokeWidth={1.5} className="sidebar-item-icon" />
                {!collapsed && <span className="sidebar-item-label">{it.label}</span>}
                {it.key === "collab" && coopBadge !== undefined && coopBadge > 0 ? (
                  <span className="absolute right-2 top-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-semibold rounded-full bg-red-500 text-white" style={{ lineHeight: 1 }}>
                    {coopBadge > 99 ? "99+" : coopBadge}
                  </span>
                ) : null}
              </button>
            </div>
          );
  };

  return (
    <div className={`workbench-sidebar-content px-2 py-2 flex flex-col flex-1 min-h-0 ${collapsed ? "is-collapsed" : ""}`}>
      <div className="flex shrink-0 flex-col gap-0">
        {primaryItems.map((item) => renderItem(item))}
      </div>

      {!collapsed ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <SessionList
            sessions={sessions}
            currentConversationId={currentConversationId}
            messageSearchProvider={messageSearchProvider}
            onSwitchConversation={onSwitchConversation}
            onDeleteConversation={onDeleteConversation}
            onRenameConversation={onRenameConversation}
            onTogglePinConversation={onTogglePinConversation}
            onNewConversation={onNewConversation}
            variant="sidebar"
            searchable={sessions.length > 8}
            loading={sessionsLoading}
          />
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="shrink-0 pt-2" style={{ borderTop: "1px solid var(--oc-border-subtle)" }}>
        <div className="flex flex-col gap-0 pb-2">
          {secondaryItems.map((item) => renderItem(item))}
        </div>
        {footer ? <div className="min-w-0">{footer}</div> : null}
      </div>
    </div>
  );
}
