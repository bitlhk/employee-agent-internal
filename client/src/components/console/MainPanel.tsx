import { SkillsPage } from "@/components/pages/SkillsPage";
import { GrowthPage } from "@/components/pages/GrowthPage";
import { WorkspacePage } from "@/components/pages/WorkspacePage";
import { SchedulePageV2 } from "@/components/pages/SchedulePageV2";
import { SettingsPage } from "@/components/pages/SettingsPage";
import { CollabPage } from "@/components/pages/CollabPage";
import { PanelErrorBoundary } from "@/components/console/PanelErrorBoundary";
import type { PageKey } from "@/components/console/Sidebar";
import type { ReactNode } from "react";
import type { CustomMcpTemplate } from "@/components/CustomMcpDialog";
import { useEffect, useState } from "react";

type PanelPageKey = Exclude<PageKey, "chat">;
type CapabilityPageKey = "skills" | "experts" | "connectors";

const PANEL_PAGE_ORDER: PanelPageKey[] = [
  "skills",
  "agent",
  "workspace",
  "schedule",
  "collab",
  "settings",
];

function normalizedPanelPage(page: PanelPageKey): PanelPageKey {
  return page === "experts" || page === "connectors" ? "skills" : page;
}

function capabilitySection(page: PanelPageKey): CapabilityPageKey {
  if (page === "experts" || page === "connectors") return page;
  return "skills";
}

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
  onAddMcp,
  onManageMcp,
  onTryMcp,
  onMcpChanged,
  onAddExpert,
  onManageExpert,
  onTryExpert,
}: {
  activePage: PanelPageKey;
  adoptId?: string;
  onAddMcp?: (template?: CustomMcpTemplate) => void;
  onManageMcp?: () => void;
  onTryMcp?: () => void;
  onMcpChanged?: () => void | Promise<void>;
  onAddExpert?: () => void;
  onManageExpert?: () => void;
  onTryExpert?: (expertId: string) => void;
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
  const panelPage = normalizedPanelPage(activePage);
  const [visitedPages, setVisitedPages] = useState<Set<PanelPageKey>>(() => new Set([panelPage]));

  useEffect(() => {
    setVisitedPages(new Set([panelPage]));
  }, [adoptId]);

  useEffect(() => {
    setVisitedPages((previous) => {
      if (previous.has(panelPage)) return previous;
      const next = new Set(previous);
      next.add(panelPage);
      return next;
    });
  }, [panelPage]);

  const renderPage = (page: PanelPageKey): ReactNode => {
    if (page === "skills") {
      return <SkillsPage section={capabilitySection(activePage)} skills={safeSkills.data} canEdit={safeSkills.canEdit} pending={safeSkills.pending} onToggle={safeSkills.onToggle} adoptId={safeSkills.adoptId} onChanged={safeSkills.onChanged} onAddMcp={onAddMcp} onManageMcp={onManageMcp} onTryMcp={onTryMcp} onMcpChanged={onMcpChanged} onAddExpert={onAddExpert} onManageExpert={onManageExpert} onTryExpert={onTryExpert} />;
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
        const active = panelPage === page;
        return (
          <div
            key={`${page}:${adoptId || ""}`}
            className="min-h-0 h-full flex-1 flex-col overflow-hidden"
            style={{ display: active ? "flex" : "none" }}
            aria-hidden={active ? undefined : true}
          >
            <PanelErrorBoundary
              resetKey={`${page}:${activePage}:${adoptId || ""}`}
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
