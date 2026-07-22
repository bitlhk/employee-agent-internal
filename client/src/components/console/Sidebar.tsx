import {
  MessageCircle,
  Plug,
  Radio,
  Timer,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { SessionList, type SessionListConversation } from "./SessionList";

export type PageKey = "chat" | "skills" | "channels" | "weixin" | "agent" | "workspace" | "schedule" | "collab" | "settings";

type NavItem = { key: PageKey; label: string; icon: any; adminOnly?: boolean };

export type SidebarConversation = SessionListConversation;

const primaryItems: NavItem[] = [
  { key: "chat", label: "聊天", icon: MessageCircle },
  { key: "skills", label: "插件", icon: Plug },
  { key: "collab", label: "协作", icon: Users },
  { key: "channels", label: "频道", icon: Radio },
  { key: "schedule", label: "定时任务", icon: Timer },
];

const PAGE_KEYS = new Set<PageKey>(["chat", "skills", "channels", "weixin", "agent", "workspace", "schedule", "collab", "settings"]);

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
  sessionSwitchingId,
  messageSearchProvider,
  onSwitchConversation,
  onDeleteConversation,
  onRenameConversation,
  onTogglePinConversation,
  onNewConversation,
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
  sessionSwitchingId?: string | null;
  messageSearchProvider?: (conversationId: string, query: string) => string;
  onSwitchConversation?: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => void;
  onRenameConversation?: (conversationId: string, title: string) => void;
  onTogglePinConversation?: (conversationId: string, pinned: boolean) => void;
  onNewConversation?: () => void;
  sessionsLoading?: boolean;
  footer?: ReactNode;
}) {
  const renderItem = (it: NavItem) => {
          const Icon = it.icon;
          const active = isSidebarNavItemActive(activePage, it.key, navigationSelectionActive);
          return (
            <div key={it.key} className="flex flex-col">
              <button title={it.label} onClick={() => setActivePage(it.key)} className={`w-full flex items-center text-left sidebar-item relative ${active ? "active" : ""}`}>
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
    <div className="px-2 py-2 flex flex-col flex-1 min-h-0">
      <div className="flex shrink-0 flex-col gap-0">
        {primaryItems.map((item) => renderItem(item))}
      </div>

      {!collapsed ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <SessionList
            sessions={sessions}
            currentConversationId={currentConversationId}
            sessionSwitchingId={sessionSwitchingId}
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
        {footer ? <div className="min-w-0">{footer}</div> : null}
      </div>
    </div>
  );
}
