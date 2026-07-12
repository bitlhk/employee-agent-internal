import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { trpc } from "@/lib/trpc";
import { PageContainer } from "@/components/console/PageContainer";
import {
  ArrowLeft,
  Bot,
  CheckSquare2,
  Copy,
  ExternalLink,
  EyeOff,
  MoreHorizontal,
  RefreshCw,
  Send,
  Square,
  Trash2,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { sessionStatusMeta } from "@/lib/coopStatus";
import { CoopNewForm } from "@/pages/CoopNew";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type PageMode = "list" | "create";
type FilterKey = "all" | "action" | "created" | "participating" | "completed";

type CoopSessionRow = {
  id: string;
  title?: string | null;
  status: string;
  creator_user_id?: number;
  creator_name?: string | null;
  total_members?: number;
  completed_members?: number;
  pending_members?: number;
  i_am_member?: boolean | number;
  i_am_creator?: boolean | number;
  my_request_status?: string | null;
  created_at?: string | Date | null;
  published_at?: string | Date | null;
  sourceUpdatedAt?: number;
  sortUpdatedAt?: number;
};

type CoopSessionViewRow = {
  id?: string;
  coopSessionId?: string;
  title?: string;
  preview?: string;
  updatedAt?: number;
  sourceUpdatedAt?: number;
  sortUpdatedAt?: number;
};

type CoopSessionViewPayload = {
  sessions?: CoopSessionViewRow[];
  rawSessions?: CoopSessionRow[];
};

type CoopCandidate = {
  userId: number;
  userName: string | null;
  userEmail: string | null;
  groupId: number | null;
  groupName: string | null;
  orgName: string | null;
  departmentName: string | null;
  teamName: string | null;
  adoptId: string | null;
  agentRoleTemplate?: string | null;
  adoptionStatus: string | null;
};

function coopDisplayName(candidate: CoopCandidate) {
  return String(candidate.userName || candidate.userEmail || `成员 ${candidate.userId}`).trim();
}

const COOP_AGENT_ROLE_NAMES: Record<string, string> = {
  "investment-researcher": "投顾分析",
  "wealth-manager": "财富经理",
  "credential-compliance": "审核专员",
  "insurance-advisor": "保险顾问",
  "general-assistant": "通用助手",
};

function coopAgentRoleName(candidate: CoopCandidate) {
  const role = String(candidate.agentRoleTemplate || "").trim();
  return COOP_AGENT_ROLE_NAMES[role] || role || "通用助手";
}

function coopOrgUnitLabel(candidate: CoopCandidate) {
  return candidate.teamName || candidate.departmentName || candidate.groupName || candidate.orgName || "组织";
}

function isJiuwenCoopCandidate(candidate: CoopCandidate) {
  const adoptId = String(candidate.adoptId || "");
  return adoptId.startsWith("lgj-") && (!candidate.adoptionStatus || candidate.adoptionStatus === "active");
}

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function countOf(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function createdAtValue(session: CoopSessionRow) {
  const viewTime = Number(session.sortUpdatedAt || session.sourceUpdatedAt || 0);
  const time = viewTime || (session.created_at ? new Date(session.created_at).getTime() : 0);
  return Number.isFinite(time) ? time : 0;
}

function formatDate(value?: string | Date | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getSessionFlags(session: CoopSessionRow) {
  const total = countOf(session.total_members);
  const completed = countOf(session.completed_members);
  const pending = countOf(session.pending_members);
  const isCreator = truthy(session.i_am_creator);
  const isMember = truthy(session.i_am_member);
  const needMyAction = isMember && session.my_request_status === "pending";
  const readyToConsolidate =
    isCreator &&
    session.status === "running" &&
    completed > 0 &&
    completed >= Math.max(0, total - pending);

  return { total, completed, pending, isCreator, isMember, needMyAction, readyToConsolidate };
}

function roleLabel(session: CoopSessionRow) {
  const flags = getSessionFlags(session);
  if (flags.isCreator && flags.isMember) return "发起人 / 成员";
  if (flags.isCreator) return "发起人";
  if (flags.isMember) return "成员";
  return "旁观";
}

function progressLabel(session: CoopSessionRow) {
  const { total, completed, pending } = getSessionFlags(session);
  if (total <= 0) return "未分配";
  if (pending > 0) return `${completed}/${total} 已提交 · ${pending} 待响应`;
  return `${completed}/${total} 已提交`;
}

function nextActionLabel(session: CoopSessionRow) {
  const flags = getSessionFlags(session);
  if (flags.needMyAction) return "待你接收或调整子任务";
  if (flags.readyToConsolidate) return "成员已完成，等待你汇总发布";
  if (session.status === "inviting") return flags.pending > 0 ? `等待 ${flags.pending} 位成员接收` : "等待成员接收";
  if (session.status === "running") {
    if (flags.total > 0 && flags.completed < flags.total) return "等待成员提交结果";
    return "等待结果确认";
  }
  if (session.status === "consolidating") return "正在生成汇总草稿";
  if (session.status === "published") return "已发布给全部成员";
  if (session.status === "closed" || session.status === "dissolved") return "协作已结束";
  return "进入查看详情";
}

function sortSessions(list: CoopSessionRow[]) {
  return [...list].sort((a, b) => {
    const fa = getSessionFlags(a);
    const fb = getSessionFlags(b);
    const score = (flags: ReturnType<typeof getSessionFlags>, session: CoopSessionRow) => {
      if (flags.needMyAction) return 4;
      if (flags.readyToConsolidate) return 3;
      if (session.status === "running" || session.status === "inviting") return 2;
      if (session.status === "consolidating") return 1;
      return 0;
    };
    const delta = score(fb, b) - score(fa, a);
    if (delta !== 0) return delta;
    return createdAtValue(b) - createdAtValue(a);
  });
}

export function CollabPage({ adoptId: _adoptId, active }: { adoptId: string; active: boolean }) {
  const [, setLocationCoop] = useLocation();
  const [mode, setMode] = useState<PageMode>("list");
  const coopSessionPath = (sessionId: string) =>
    _adoptId ? `/coop/${sessionId}?fromAdoptId=${encodeURIComponent(_adoptId)}` : `/coop/${sessionId}`;

  if (mode === "create") {
    return (
      <PageContainer title="协作工作台" icon={<Users size={18} />}>
        <div className="coop-workbench">
          <div className="coop-workbench__create-head">
            <Button variant="ghost" size="sm" onClick={() => setMode("list")} className="lingxia-soft-action coop-back-button">
              <ArrowLeft className="w-4 h-4 mr-1" /> 返回协作工作台
            </Button>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">发起多人协作</div>
              <div className="text-xs text-muted-foreground">选择成员、拆分子任务，并在成员提交后统一汇总。</div>
            </div>
          </div>
          <CoopNewForm
            onDone={(sid) => setLocationCoop(coopSessionPath(sid))}
            onCancel={() => setMode("list")}
          />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title="协作工作台" icon={<Users size={18} />}>
      <div className="coop-workbench">
        <CoopWorkbenchDashboard
          adoptId={_adoptId}
          active={active}
          onCreate={() => setMode("create")}
        />
      </div>
    </PageContainer>
  );
}

function CoopWorkbenchDashboard({ adoptId, active, onCreate }: { adoptId?: string; active: boolean; onCreate?: () => void }) {
  const [, setLocationCoop] = useLocation();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const wlQ = trpc.coop.isWhitelisted.useQuery();
  const { data, isLoading } = trpc.coop.mentionCandidates.useQuery(
    { limit: 80 },
    { enabled: Boolean(wlQ.data?.whitelisted) }
  );
  const { data: myClawData } = trpc.claw.me.useQuery(undefined, { retry: false });
  const creatorAdoptId = (myClawData as any)?.adoption?.adoptId || (myClawData as any)?.adoptId || "lgc-creator";
  const sourceAdoptId = adoptId || creatorAdoptId;
  const coopSessionPath = (sessionId: string) =>
    sourceAdoptId ? `/coop/${sessionId}?fromAdoptId=${encodeURIComponent(sourceAdoptId)}` : `/coop/${sessionId}`;
  const createMut = trpc.coop.create.useMutation({
    onSuccess: (r) => {
      setSelectedIds([]);
      toast.success("协作已创建");
      setLocationCoop(coopSessionPath(r.sessionId));
    },
    onError: (error) => toast.error(error.message || "协作创建失败"),
  });
  const agents = useMemo(() => {
    return ((data as CoopCandidate[]) || [])
      .filter(isJiuwenCoopCandidate);
  }, [data]);

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((userId) => agents.some((agent) => agent.userId === userId)));
  }, [agents]);

  const selectedAgents = useMemo(() => {
    const selected = new Set(selectedIds);
    return agents.filter((agent) => selected.has(agent.userId));
  }, [agents, selectedIds]);

  const startWithSelected = () => {
    if (selectedAgents.length === 0) {
      toast.warning("请先选择至少一个协作智能体");
      return;
    }
    createMut.mutate({
      title: "未命名协作",
      originMessage: "",
      creatorAdoptId,
      members: selectedAgents.map((agent) => ({
        userId: agent.userId,
        targetAdoptId: agent.adoptId || `mock:${agent.userId}`,
        subtask: "等待协作群内消息",
      })),
    });
  };

  return (
    <div className="coop-dashboard-layout">
      <div className="coop-dashboard-main">
        <CoopSessionsWorkbench adoptId={sourceAdoptId} active={active} />
      </div>
      <div className="coop-dashboard-side">
        <div className="coop-side-tab" aria-label="可协作智能体数量">
          可协作智能体
          <span>{agents.length}</span>
        </div>
        <CoopAgentsPanel
          agents={agents}
          isLoading={isLoading}
          whitelisted={Boolean(wlQ.data?.whitelisted)}
          whitelistLoading={wlQ.isLoading}
          whitelistMessage={wlQ.data?.message}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          onCreate={startWithSelected}
          creating={createMut.isPending}
        />
      </div>
    </div>
  );
}

function CoopAgentsPanel({
  agents,
  isLoading,
  whitelisted,
  whitelistLoading,
  whitelistMessage,
  selectedIds,
  setSelectedIds,
  onCreate,
  creating,
}: {
  agents: CoopCandidate[];
  isLoading: boolean;
  whitelisted: boolean;
  whitelistLoading: boolean;
  whitelistMessage?: string | null;
  selectedIds: number[];
  setSelectedIds: Dispatch<SetStateAction<number[]>>;
  onCreate?: () => void;
  creating?: boolean;
}) {
  const selectedAgents = useMemo(() => {
    const selected = new Set(selectedIds);
    return agents.filter((agent) => selected.has(agent.userId));
  }, [agents, selectedIds]);

  const toggleAgent = (agent: CoopCandidate) => {
    setSelectedIds((prev) =>
      prev.includes(agent.userId)
        ? prev.filter((userId) => userId !== agent.userId)
        : [...prev, agent.userId]
    );
  };

  return (
    <aside className="coop-agents-panel" aria-label="可协作智能体">
      <div className="coop-agent-list-wrap">
        {!whitelisted && !whitelistLoading ? (
          <div className="coop-agents-panel__empty">{whitelistMessage || "当前用户未开通组织协作。"}</div>
        ) : isLoading ? (
          <div className="coop-agents-panel__empty">正在读取智能体...</div>
        ) : agents.length === 0 ? (
          <div className="coop-agents-panel__empty">暂无可协作智能体。</div>
        ) : (
          <div className="coop-agent-list">
            {agents.map((agent) => {
              const name = coopDisplayName(agent);
              const role = coopAgentRoleName(agent);
              const orgUnit = coopOrgUnitLabel(agent);
              const selected = selectedIds.includes(agent.userId);
              return (
                <button
                  type="button"
                  className="coop-agent-card coop-agent-card--selectable"
                  data-selected={selected ? "true" : "false"}
                  key={`${agent.userId}:${agent.adoptId}`}
                  onClick={() => toggleAgent(agent)}
                  aria-pressed={selected}
                >
                  <span className="coop-agent-card__check" aria-hidden="true">
                    {selected ? <CheckSquare2 size={16} /> : <Square size={16} />}
                  </span>
                  <div className="coop-agent-card__icon">
                    <Bot size={16} />
                  </div>
                  <div className="coop-agent-card__body">
                    <div className="coop-agent-card__name">{name}</div>
                    <div className="coop-agent-card__role">{orgUnit} - {role}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="coop-selected-agents" data-empty={selectedAgents.length === 0 ? "true" : "false"}>
        <div className="coop-selected-agents__head">
          <span>已选智能体</span>
          {selectedAgents.length > 0 ? (
            <button type="button" onClick={() => setSelectedIds([])}>清空</button>
          ) : null}
        </div>
        {selectedAgents.length > 0 ? (
          <div className="coop-selected-agents__chips">
            {selectedAgents.map((agent) => (
              <span key={agent.userId}>{coopDisplayName(agent)}</span>
            ))}
          </div>
        ) : (
          <p>可多选后发起协作。</p>
        )}
      </div>

      <button type="button" className="page-primary-action coop-create-action" onClick={() => onCreate?.()} disabled={creating}>
        {creating ? <RefreshCw size={15} className="animate-spin" /> : <Send size={15} />}
        {creating ? "创建中..." : selectedAgents.length > 0 ? `发起协作 (${selectedAgents.length})` : "发起协作"}
      </button>
    </aside>
  );
}

function CoopSessionsWorkbench({ adoptId, active }: { adoptId?: string; active: boolean }) {
  const [, setLoc] = useLocation();
  const coopSessionPath = (sessionId: string) =>
    adoptId ? `/coop/${sessionId}?fromAdoptId=${encodeURIComponent(adoptId)}` : `/coop/${sessionId}`;
  const { confirm, dialog } = useConfirmDialog();
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [sessionsPayload, setSessionsPayload] = useState<CoopSessionViewPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [loadError, setLoadError] = useState("");
  const loadSessions = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setIsFetching(true);
    try {
      const response = await fetch("/api/ea/session-view/coop?limit=80", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => null);
      setSessionsPayload(payload || { sessions: [], rawSessions: [] });
      setLoadError("");
    } catch (error) {
      console.warn("[coop] session-view load failed", error);
      setLoadError("协作列表加载失败，请稍后刷新重试。");
      setSessionsPayload((current) => current || { sessions: [], rawSessions: [] });
    } finally {
      setIsLoading(false);
      setIsFetching(false);
    }
  }, []);
  const refetch = useCallback(() => {
    void loadSessions(true);
  }, [loadSessions]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const run = async (silent = false) => {
      if (cancelled) return;
      await loadSessions(silent);
    };
    void run(false);
    const timer = window.setInterval(() => void run(true), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, loadSessions]);

  const list = useMemo(() => {
    const viewById = new Map<string, CoopSessionViewRow>();
    for (const view of Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : []) {
      const id = String(view?.coopSessionId || String(view?.id || "").replace(/^coop:/, "") || "").trim();
      if (id) viewById.set(id, view);
    }
    return ((sessionsPayload?.rawSessions as CoopSessionRow[]) || []).map((session) => {
      const id = String(session.id || "");
      const view = viewById.get(id);
      return {
        ...session,
        id,
        sourceUpdatedAt: Number(view?.sourceUpdatedAt || view?.updatedAt || 0) || session.sourceUpdatedAt,
        sortUpdatedAt: Number(view?.sortUpdatedAt || view?.sourceUpdatedAt || view?.updatedAt || 0) || session.sortUpdatedAt,
      };
    }).filter((session) => session.id);
  }, [sessionsPayload]);
  const sorted = useMemo(() => sortSessions(list), [list]);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  useEffect(() => {
    if (!openMenuId) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target?.closest?.("[data-coop-menu]") || target?.closest?.("[data-coop-menu-trigger]")) return;
      setOpenMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuId]);

  const softDeleteMut = trpc.coop.softDelete.useMutation({
    onSuccess: () => { toast.success("协作已删除"); setOpenMenuId(null); refetch(); },
    onError: (error) => toast.error(error.message || "删除失败"),
  });
  const toggleHideMut = trpc.coop.toggleHide.useMutation({
    onSuccess: () => { toast.success("已从你的列表隐藏"); setOpenMenuId(null); refetch(); },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  const stats = useMemo(() => {
    return sorted.reduce(
      (acc, session) => {
        const flags = getSessionFlags(session);
        if (flags.needMyAction) acc.action += 1;
        if (flags.readyToConsolidate) acc.ready += 1;
        if (session.status === "running" || session.status === "inviting" || session.status === "consolidating") acc.active += 1;
        if (session.status === "published" || session.status === "closed") acc.done += 1;
        return acc;
      },
      { action: 0, ready: 0, active: 0, done: 0 }
    );
  }, [sorted]);

  const filters: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "all", label: "全部", count: sorted.length },
    { key: "action", label: "待我处理", count: stats.action },
    { key: "created", label: "我发起的", count: sorted.filter((session) => getSessionFlags(session).isCreator).length },
    { key: "participating", label: "我参与的", count: sorted.filter((session) => getSessionFlags(session).isMember && !getSessionFlags(session).isCreator).length },
    { key: "completed", label: "已结束", count: stats.done },
  ];

  const filtered = sorted.filter((session) => {
    const flags = getSessionFlags(session);
    if (activeFilter === "action") return flags.needMyAction;
    if (activeFilter === "created") return flags.isCreator;
    if (activeFilter === "participating") return flags.isMember && !flags.isCreator;
    if (activeFilter === "completed") return session.status === "published" || session.status === "closed";
    return true;
  });

  const handleDelete = async (session: CoopSessionRow) => {
    const ok = await confirm({
      title: "删除协作？",
      description: `确认删除协作「${session.title || session.id}」？\n\n所有成员的视图都会消失（软删除，30 天内可联系管理员恢复）。`,
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    softDeleteMut.mutate({ sessionId: session.id });
  };
  const handleHide = async (session: CoopSessionRow) => {
    const ok = await confirm({
      title: "隐藏协作？",
      description: `从你的列表隐藏「${session.title || session.id}」？\n\n仅影响你的视图，发起人和其他成员不受影响。`,
      confirmText: "隐藏",
    });
    if (!ok) return;
    toggleHideMut.mutate({ sessionId: session.id, hide: true });
  };
  const handleCopyId = async (session: CoopSessionRow) => {
    try {
      await navigator.clipboard.writeText(session.id);
      toast.success("协作 ID 已复制");
    } catch {
      toast.error("复制失败");
    } finally {
      setOpenMenuId(null);
    }
  };

  if (isLoading) {
    return (
      <>
        {dialog}
        <div className="coop-workbench__loading">加载协作任务...</div>
      </>
    );
  }

  if (sorted.length === 0) {
    return (
      <>
        {dialog}
        <div className="coop-workbench__list-head">
          <div className="coop-filter-tabs" role="tablist" aria-label="协作任务筛选">
            {filters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className="coop-filter-tab"
                data-active={activeFilter === filter.key}
                onClick={() => setActiveFilter(filter.key)}
              >
                {filter.label}
                <span>{filter.count}</span>
              </button>
            ))}
          </div>
          <div className="coop-workbench__actions">
            <Button variant="outline" size="sm" className="coop-refresh-button ea-data-btn ea-data-btn--ghost" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
        </div>
        {loadError ? (
          <div className="coop-load-error">{loadError}</div>
        ) : null}
        <div className="coop-empty-state ea-data-empty">
          <div className="coop-empty-state__icon"><UsersRound size={24} /></div>
          <div className="coop-empty-state__title">还没有协作任务</div>
          <div className="coop-empty-state__desc">你可以发起一个多人协作，让成员分别处理子任务后统一汇总。</div>
        </div>
      </>
    );
  }

  return (
    <>
      {dialog}
      <div className="coop-workbench__list-head">
        <div className="coop-filter-tabs" role="tablist" aria-label="协作任务筛选">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className="coop-filter-tab"
              data-active={activeFilter === filter.key}
              onClick={() => setActiveFilter(filter.key)}
            >
              {filter.label}
              <span>{filter.count}</span>
            </button>
          ))}
        </div>
        <div className="coop-workbench__actions">
          <Button variant="outline" size="sm" className="coop-refresh-button ea-data-btn ea-data-btn--ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className="coop-load-error">{loadError}</div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="coop-empty-state coop-empty-state--compact ea-data-empty">
          <div className="coop-empty-state__title">当前筛选下没有任务</div>
          <div className="coop-empty-state__desc">切换到“全部”可以查看所有协作任务。</div>
        </div>
      ) : (
        <div className="coop-task-table ea-data-card" role="table" aria-label="协作任务列表">
          <div className="coop-task-table__head ea-data-header" role="row">
            <div>任务</div>
            <div>状态</div>
            <div>下一步</div>
            <div>角色</div>
            <div>进度</div>
            <div>创建时间</div>
            <div></div>
          </div>
          <div className="coop-task-table__body">
            {filtered.map((session) => {
              const meta = sessionStatusMeta(session.status);
              const flags = getSessionFlags(session);
              const progress = flags.total > 0 ? Math.min(100, Math.round((flags.completed / flags.total) * 100)) : 0;
              return (
                <div
                  key={session.id}
                  className="coop-task-row ea-data-row ea-data-row--clickable"
                  data-action={flags.needMyAction || flags.readyToConsolidate ? "true" : "false"}
                  onClick={() => setLoc(coopSessionPath(session.id))}
                  role="row"
                >
                  <div className="coop-task-row__title-cell">
                    <div className="coop-task-row__title-line">
                      {(flags.needMyAction || flags.readyToConsolidate) ? <span className="coop-task-row__dot" /> : null}
                      <span className="coop-task-row__title">{session.title || "未命名协作"}</span>
                    </div>
                    <div className="coop-task-row__meta">
                      发起人：{session.creator_name || `#${session.creator_user_id || "—"}`}
                    </div>
                  </div>
                  <div>
                    <span className={`badge ${meta.badgeClass}`}>{meta.label}</span>
                  </div>
                  <div className="coop-task-row__next">{nextActionLabel(session)}</div>
                  <div className="coop-task-row__role">
                    <UserRound size={13} />
                    {roleLabel(session)}
                  </div>
                  <div className="coop-task-row__progress">
                    <div className="coop-task-row__progress-label">{progressLabel(session)}</div>
                    <div className="coop-progress-bar" aria-hidden="true">
                      <span style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  <div className="coop-task-row__date">{formatDate(session.created_at)}</div>
                  <div className="coop-task-row__actions ea-data-actions" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      data-coop-menu-trigger
                      className="coop-task-row__more ea-data-icon-btn"
                      aria-label="更多操作"
                      aria-expanded={openMenuId === session.id}
                      onClick={() => setOpenMenuId(openMenuId === session.id ? null : session.id)}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {openMenuId === session.id ? (
                      <div className="coop-row-menu" data-coop-menu role="menu" aria-label="协作任务操作">
                        <button type="button" className="coop-row-menu__item" onClick={() => { setOpenMenuId(null); setLoc(coopSessionPath(session.id)); }}>
                          <ExternalLink size={14} />
                          打开协作
                        </button>
                        <button type="button" className="coop-row-menu__item" onClick={() => handleCopyId(session)}>
                          <Copy size={14} />
                          复制协作 ID
                        </button>
                        <div className="coop-row-menu__divider" />
                        {flags.isCreator ? (
                          <button type="button" className="coop-row-menu__item coop-row-menu__item--danger" onClick={() => handleDelete(session)} disabled={softDeleteMut.isPending}>
                            <Trash2 size={14} />
                            删除协作
                          </button>
                        ) : (
                          <button type="button" className="coop-row-menu__item" onClick={() => handleHide(session)} disabled={toggleHideMut.isPending}>
                            <EyeOff size={14} />
                            从我的列表隐藏
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
