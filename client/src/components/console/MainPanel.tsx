import { SkillsPage } from "@/components/pages/SkillsPage";
import { ChannelsPage } from "@/components/pages/ChannelsPage";
import { GrowthPage } from "@/components/pages/GrowthPage";
import { WorkspacePage } from "@/components/pages/WorkspacePage";
import { SchedulePageV2 } from "@/components/pages/SchedulePageV2";
import { SettingsPage } from "@/components/pages/SettingsPage";
import { CollabPage } from "@/components/pages/CollabPage";
import { PanelErrorBoundary } from "@/components/console/PanelErrorBoundary";
import type { PageKey } from "@/components/console/Sidebar";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type PanelPageKey = Exclude<PageKey, "chat">;

const PANEL_PAGE_ORDER: PanelPageKey[] = [
  "skills",
  "channels",
  "weixin",
  "agent",
  "workspace",
  "schedule",
  "collab",
  "settings",
];

function MainPanelShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 h-full overflow-hidden flex flex-col">
      {children}
    </div>
  );
}

export function MainPanel({
  activePage,
  skills,
  adoptId,
}: {
  activePage: PanelPageKey;
  adoptId?: string;
  skills?: {
    data?: { shared: any[]; system: any[]; private: any[] } | null;
    canEdit?: boolean;
    pending?: boolean;
    onToggle?: (skillId: string, enable: boolean, source: "shared" | "system") => void;
    onChanged?: () => void | Promise<void>;
  };
}) {
  const safeSkills = {
    data: skills?.data ?? { shared: [], system: [], private: [] },
    canEdit: !!skills?.canEdit,
    pending: !!skills?.pending,
    onToggle: skills?.onToggle ?? (() => {}),
    onChanged: skills?.onChanged,
    adoptId: adoptId || "",
  };
  const [visitedPages, setVisitedPages] = useState<Set<PanelPageKey>>(() => new Set([activePage]));

  useEffect(() => {
    setVisitedPages(new Set([activePage]));
  }, [adoptId]);

  useEffect(() => {
    setVisitedPages((previous) => {
      if (previous.has(activePage)) return previous;
      const next = new Set(previous);
      next.add(activePage);
      return next;
    });
  }, [activePage]);

  const renderPage = (page: PanelPageKey): ReactNode => {
    if (page === "channels" || page === "weixin") return <ChannelsPage adoptId={adoptId || ""} />;
    if (page === "skills") {
      return <SkillsPage skills={safeSkills.data} canEdit={safeSkills.canEdit} pending={safeSkills.pending} onToggle={safeSkills.onToggle} adoptId={safeSkills.adoptId} onChanged={safeSkills.onChanged} />;
    }
    if (page === "agent") return <GrowthPage adoptId={adoptId || ""} />;
    if (page === "workspace") return <WorkspacePage adoptId={adoptId || ""} />;
    if (page === "schedule") return <SchedulePageV2 adoptId={adoptId || ""} />;
    if (page === "collab") return <CollabPage adoptId={adoptId || ""} active={activePage === "collab"} />;
    return <SettingsPage />;
  };

  return (
    <MainPanelShell>
      {PANEL_PAGE_ORDER.map((page) => {
        if (!visitedPages.has(page)) return null;
        const active = activePage === page;
        return (
          <div
            key={`${page}:${adoptId || ""}`}
            className="min-h-0 h-full flex-1 flex-col overflow-hidden"
            style={{ display: active ? "flex" : "none" }}
            aria-hidden={active ? undefined : true}
          >
            <PanelErrorBoundary
              resetKey={`${page}:${adoptId || ""}`}
              title="当前功能页暂时不可用"
              description="该功能页渲染时出现异常，侧栏和其他功能仍可继续使用。"
            >
              {renderPage(page)}
            </PanelErrorBoundary>
          </div>
        );
      })}
    </MainPanelShell>
  );
}
