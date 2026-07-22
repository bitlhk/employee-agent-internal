import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  FileText,
  Globe2,
  Layers,
  Package,
  Pencil,
  PhoneCall,
  Plug,
  Plus,
  Presentation,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
  Upload,
  UsersRound,
  Wrench,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer } from "@/components/console/PageContainer";
import { handleRovingTabKey } from "@/lib/a11y";
import { MarketplacePage } from "./MarketplacePage";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { inspectSkillPackage, uploadSkillPackage } from "@/lib/skill-package-upload";

type SourceKind = "builtin" | "role_default" | "marketplace" | "uploaded" | "generated" | "runtime_imported";
type RuntimeState =
  | "ready"
  | "disabled"
  | "syncing"
  | "sync_failed"
  | "source_missing"
  | "review_pending"
  | "reviewing"
  | "review_failed";
type ReviewState = "none" | "pending" | "reviewing" | "passed" | "failed";

type RegistrySkill = {
  id: string;
  adoptId: string;
  source: {
    kind: SourceKind;
    skillId: string;
    displayName: string;
    description?: string;
    sourcePath?: string;
    version?: string;
  };
  state: RuntimeState;
  enabled: boolean;
  review: {
    state: ReviewState;
    reason?: string;
    checkedAt?: string;
  };
  sync: {
    runtimePath?: string;
    lastSyncedAt?: string;
    reason?: string;
  };
  scan?: {
    warnings: string[];
    scannedAt: string;
  };
  capabilities?: string[];
  examples?: string[];
  createdAt: string;
  updatedAt: string;
};

type SkillIntroductionResponse = {
  skillId: string;
  introduction: string;
  source: "runtime" | "source" | "registry" | "fallback";
};

const SKILL_TAB_KEYS = ["mine", "market", "mcp", "agent"] as const;
const SKILL_NAV_TAB_KEYS = ["market", "agent", "mcp"] as const;
type SkillTab = (typeof SKILL_TAB_KEYS)[number];
type SourceFilter = "all" | SourceKind;
type StateFilter = "all" | "ready" | "attention" | "disabled";
const SKILL_TAB_CACHE_KEY = "employee-agent:skills:last-tab";
const MCP_TOOLS_CACHE_PREFIX = "employee-agent:mcp-tools:v4:";
const AGENT_TOOLS_CACHE_PREFIX = "employee-agent:agent-tools:v2:";

type McpServerStatus = "available" | "disabled" | "missing";
type McpLiveStatus = "live" | "fallback" | "unavailable" | "unsupported";
type McpToolSummary = {
  name: string;
  description: string;
  source?: "live" | "fallback";
};
type McpToolChild = {
  id: string;
  name: string;
  description: string;
  serverId: string;
  configured: boolean;
  enabled: boolean;
  status: McpServerStatus;
  existsOnDisk?: boolean;
  tools?: McpToolSummary[];
  toolSource?: "live" | "fallback";
  liveStatus?: McpLiveStatus;
  liveCheckedAt?: string | null;
  liveError?: string | null;
  enabledForAgent?: boolean;
  grantMode?: "default" | "optional";
};
type McpToolGroup = {
  id: string;
  name: string;
  category: string;
  description: string;
  status: McpServerStatus;
  availableCount: number;
  configuredCount: number;
  serverCount: number;
  activeCount?: number;
  children: McpToolChild[];
  recommendedSkills?: string[];
  liveStatus?: McpLiveStatus;
};
type McpToolsResponse = {
  items: McpToolGroup[];
  totals?: {
    groups: number;
    configuredServers: number;
    availableServers: number;
  };
  live?: {
    enabled: boolean;
    checkedAt?: string;
    ttlMs?: number;
  };
};

type McpConnectorFilter = "all" | "connected" | "available";
type McpConnectorSource = "preset" | "public" | "optional" | "personal";
type McpConnectorHealth = "ready" | "degraded" | "offline" | "idle";
type McpConnectorCard = {
  id: string;
  serverId: string;
  name: string;
  description: string;
  category: string;
  source: McpConnectorSource;
  sourceLabel: string;
  configured: boolean;
  connected: boolean;
  health: McpConnectorHealth;
  statusLabel: string;
  tools: McpToolSummary[];
  liveError?: string | null;
  recommendedSkills: string[];
};

type ExternalAgentSummary = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags?: string;
  providerType?: string;
  adapterProtocol?: string;
  executionMode?: string;
  interactionMode?: "single" | "session";
  source?: "platform" | "personal";
  routeReady: boolean;
  reason?: string;
  healthStatus?: string;
  capabilities?: string[];
  lastHealthCheck?: string | null;
};

type ExternalAgentTask = {
  id: string;
  adoptId: string;
  agentId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  input: string;
  resultMarkdown?: string | null;
  errorMessage?: string | null;
  adapterProtocol?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

type ExternalAgentsResponse = {
  agents: ExternalAgentSummary[];
};

type ExternalAgentTasksResponse = {
  tasks: ExternalAgentTask[];
};

const SOURCE_LABEL: Record<SourceKind, string> = {
  builtin: "平台内置",
  role_default: "岗位预置",
  marketplace: "广场安装",
  uploaded: "我的上传",
  generated: "对话生成",
  runtime_imported: "运行时导入",
};

const STATE_LABEL: Record<RuntimeState, string> = {
  ready: "可用",
  disabled: "已停用",
  syncing: "同步中",
  sync_failed: "同步失败",
  source_missing: "源文件缺失",
  review_pending: "待审核",
  reviewing: "审核中",
  review_failed: "审核未通过",
};

const BUILTIN_DISPLAY: Record<string, { name: string; description?: string }> = {
  "finance-news": {
    name: "金融新闻晨报",
    description: "汇总金融资讯、市场动态和关键事件，适合晨报与投研简报。",
  },
  pptx: {
    name: "PPT 生成",
    description: "根据材料生成演示文稿草稿，适合汇报、路演和研究展示。",
  },
  "research-report": {
    name: "研究报告",
    description: "生成研报结构、观点提纲和分析草稿，适合投研场景。",
  },
  "stock-query": {
    name: "行情查询",
    description: "查询股票行情与基础市场数据，适合快速获取标的概览。",
  },
};

function sourceIcon(kind: SourceKind) {
  if (kind === "builtin") return <ShieldCheck size={17} aria-hidden="true" />;
  if (kind === "role_default") return <BriefcaseBusiness size={17} aria-hidden="true" />;
  if (kind === "marketplace") return <Store size={17} aria-hidden="true" />;
  if (kind === "uploaded") return <Package size={17} aria-hidden="true" />;
  return <Sparkles size={17} aria-hidden="true" />;
}

function skillIcon(skill: RegistrySkill) {
  const id = skill.id.toLowerCase();
  if (id.includes("finance") || id.includes("stock") || id.includes("rate")) return <BarChart3 size={18} aria-hidden="true" />;
  if (id.includes("report") || id.includes("ppt") || id.includes("doc")) return <FileText size={18} aria-hidden="true" />;
  if (id.includes("compliance") || id.includes("credit") || id.includes("due-diligence")) return <BriefcaseBusiness size={18} aria-hidden="true" />;
  if (id.includes("creator") || id.includes("builder")) return <Wrench size={18} aria-hidden="true" />;
  return <Layers size={18} aria-hidden="true" />;
}

function stateTone(state: RuntimeState): "ok" | "warn" | "danger" | "neutral" {
  if (state === "ready") return "ok";
  if (state === "sync_failed" || state === "source_missing" || state === "review_failed") return "danger";
  if (state === "syncing" || state === "review_pending" || state === "reviewing") return "warn";
  return "neutral";
}

function pillToneClass(tone: "ok" | "warn" | "danger" | "neutral") {
  return `skills-chip--${tone}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `request failed: ${res.status}`);
  return data as T;
}


function reasonOf(skill: RegistrySkill): string {
  return skill.sync?.reason || skill.review?.reason || "";
}

function displayNameOf(skill: RegistrySkill): string {
  if (skill.source.kind === "builtin") return BUILTIN_DISPLAY[skill.id]?.name || skill.source.displayName || skill.id;
  return skill.source.displayName || skill.id;
}

function descriptionOf(skill: RegistrySkill): string {
  if (skill.source.kind === "builtin") return BUILTIN_DISPLAY[skill.id]?.description || skill.source.description || "暂无说明";
  return skill.source.description || "暂无说明";
}

function sourceCanRename(skill: RegistrySkill) {
  return skill.source.kind === "uploaded" || skill.source.kind === "generated" || skill.source.kind === "runtime_imported";
}

function sourceCanDestroy(skill: RegistrySkill) {
  return skill.source.kind === "uploaded" || skill.source.kind === "generated" || skill.source.kind === "runtime_imported";
}

function sourceCanToggle(skill: RegistrySkill) {
  return Boolean(skill.id);
}

function sourceCanUninstall(skill: RegistrySkill) {
  return skill.source.kind === "marketplace";
}

function sourceCanPublish(skill: RegistrySkill) {
  return skill.source.kind === "uploaded" || skill.source.kind === "generated" || skill.source.kind === "runtime_imported";
}

function SkillPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "ok" | "warn" | "danger" | "neutral" }) {
  return <span className={`skills-chip ${pillToneClass(tone)}`}>{children}</span>;
}

function cachedSkillTab(): SkillTab {
  if (typeof window === "undefined") return "mine";
  try {
    const value = window.localStorage.getItem(SKILL_TAB_CACHE_KEY);
    if (value === "mine" || value === "market" || value === "mcp" || value === "agent") return value;
  } catch {}
  return "mine";
}

function mcpToolsCacheKey(adoptId?: string) {
  return `${MCP_TOOLS_CACHE_PREFIX}${adoptId || "none"}`;
}

function agentToolsCacheKey(adoptId?: string) {
  return `${AGENT_TOOLS_CACHE_PREFIX}${adoptId || "none"}`;
}

function mcpConnectorIcon(connector: Pick<McpConnectorCard, "serverId" | "category" | "source">): ReactNode {
  const id = connector.serverId.toLowerCase();
  if (id.startsWith("wind_")) {
    return <img src="/images/connectors/wind-logo.png" alt="" aria-hidden="true" />;
  }
  if (connector.source === "personal" || id.includes("custom_mcp")) return <Plug aria-hidden="true" />;
  if (id.includes("qieman") || id.includes("stock") || id.includes("index")) return <BarChart3 aria-hidden="true" />;
  if (id.includes("bond")) return <Building2 aria-hidden="true" />;
  if (id.includes("credential")) return <CheckCircle2 aria-hidden="true" />;
  if (id.includes("telesales")) return <PhoneCall aria-hidden="true" />;
  if (id.includes("insurance")) return <ShieldCheck aria-hidden="true" />;
  if (id.includes("post_loan") || id.includes("risk")) return <AlertTriangle aria-hidden="true" />;
  if (id.includes("customer")) return <UsersRound aria-hidden="true" />;
  if (id.includes("product")) return <Layers aria-hidden="true" />;
  if (id.includes("platform_tools")) return <Wrench aria-hidden="true" />;
  if (/数据|知识/.test(connector.category)) return <Database aria-hidden="true" />;
  if (/公共|公开/.test(connector.category)) return <Globe2 aria-hidden="true" />;
  if (/审核|风控|安全/.test(connector.category)) return <ShieldCheck aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

function flattenMcpConnectors(items: McpToolGroup[]): McpConnectorCard[] {
  return items
    .flatMap((group) => (group.children || []).map((child) => {
      const source: McpConnectorSource = group.id === "custom-user-mcp"
        ? "personal"
        : /公共|公开/.test(group.category)
          ? "public"
          : child.grantMode === "default"
            ? "preset"
            : "optional";
      const connected = child.enabledForAgent !== false;
      const healthy = child.configured && child.status === "available" && child.liveStatus === "live";
      const unavailable = !child.configured || child.liveStatus === "unavailable" || child.status === "missing";
      const health: McpConnectorHealth = !connected
        ? "idle"
        : healthy
          ? "ready"
          : unavailable
            ? "offline"
            : "degraded";
      const useGroupIdentity = group.children.length === 1 && source !== "personal";

      return {
        id: `${group.id}:${child.serverId}`,
        serverId: child.serverId,
        name: useGroupIdentity ? group.name : child.name,
        description: source === "personal"
          ? `${child.name} 提供的自定义 MCP 工具连接。`
          : group.description || child.description,
        category: group.category,
        source,
        sourceLabel: source === "personal"
          ? "我的连接"
          : source === "preset"
            ? "岗位预置"
            : source === "public"
              ? "公开连接"
              : "岗位可选",
        configured: child.configured,
        connected,
        health,
        statusLabel: !connected
          ? child.configured ? "可连接" : "未配置"
          : health === "ready"
            ? "已连接"
            : health === "offline"
              ? "连接异常"
              : "已连接，待验证",
        tools: (child.tools || []).filter((tool) => !["tools_list_unavailable", "tool_list"].includes(tool.name)),
        liveError: child.liveError,
        recommendedSkills: group.recommendedSkills || [],
      };
    }))
    .sort((a, b) => (
      Number(b.connected) - Number(a.connected)
      || ({ preset: 0, public: 1, optional: 2, personal: 3 }[a.source] - { preset: 0, public: 1, optional: 2, personal: 3 }[b.source])
      || a.name.localeCompare(b.name, "zh-CN")
    ));
}

function McpToolsPage({
  adoptId,
  query,
  onTryMcp,
  onConnectionsChanged,
}: {
  adoptId?: string;
  query: string;
  onTryMcp?: () => void;
  onConnectionsChanged?: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<McpToolGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<McpConnectorFilter>("all");
  const [detailServerId, setDetailServerId] = useState<string | null>(null);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);

  const loadMcpTools = async (options?: { silent?: boolean; force?: boolean }) => {
    if (!adoptId) return;
    const silent = Boolean(options?.silent);
    if (!silent) setLoading(true);
    try {
      const force = options?.force ? "&force=1" : "";
      const data = await fetchJson<McpToolsResponse>(`/api/claw/mcp-tools/status?adoptId=${encodeURIComponent(adoptId)}${force}`);
      const nextItems = Array.isArray(data.items) ? data.items : [];
      setItems(nextItems);
      try {
        window.localStorage.setItem(mcpToolsCacheKey(adoptId), JSON.stringify({ items: nextItems, lastCheckedAt: data.live?.checkedAt || null }));
      } catch {}
    } catch (e: any) {
      if (!silent && items.length === 0) {
        toast.error(`MCP 工具加载失败${e?.message ? `: ${e.message}` : ""}`);
      }
      if (!silent && items.length === 0) setItems([]);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!adoptId) {
      setItems([]);
      return;
    }
    let hadCache = false;
    try {
      const cached = window.localStorage.getItem(mcpToolsCacheKey(adoptId));
      const parsed = cached ? JSON.parse(cached) : null;
      const cachedItems = Array.isArray(parsed) ? parsed : parsed?.items;
      if (Array.isArray(cachedItems) && cachedItems.length > 0) {
        hadCache = true;
        setItems(cachedItems);
        setLoading(false);
      }
    } catch {}
    void loadMcpTools({ silent: hadCache });
  }, [adoptId]);

  useEffect(() => {
    if (!adoptId) return;
    const refreshVisiblePage = () => {
      if (document.visibilityState === "visible") void loadMcpTools({ silent: true, force: true });
    };
    const timer = window.setInterval(refreshVisiblePage, 60_000);
    document.addEventListener("visibilitychange", refreshVisiblePage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
    };
  }, [adoptId]);

  const connectors = useMemo(() => flattenMcpConnectors(items), [items]);
  const selectedConnector = useMemo(
    () => connectors.find((connector) => connector.serverId === detailServerId) || null,
    [connectors, detailServerId],
  );
  const filteredConnectors = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return connectors.filter((connector) => {
      if (filter === "connected" && !connector.connected) return false;
      if (filter === "available" && connector.connected) return false;
      if (!normalizedQuery) return true;
      return `${connector.name} ${connector.description} ${connector.category} ${connector.tools.map((tool) => `${tool.name} ${tool.description}`).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [connectors, filter, query]);

  useEffect(() => {
    if (detailServerId && !selectedConnector) setDetailServerId(null);
  }, [detailServerId, selectedConnector]);

  const toggleConnection = async (connector: McpConnectorCard) => {
    if (!adoptId || pendingServerId || !connector.configured) return;
    const nextEnabled = !connector.connected;
    setPendingServerId(connector.serverId);
    try {
      const payload = await fetchJson<{ enabledServerIds?: string[] }>("/api/claw/mcp-tools/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId, serverId: connector.serverId, enabled: nextEnabled }),
      });
      const enabledServerIds = new Set(payload.enabledServerIds || []);
      setItems((current) => current.map((group) => {
        const children = group.children.map((child) => ({
          ...child,
          enabledForAgent: payload.enabledServerIds
            ? enabledServerIds.has(child.serverId)
            : child.serverId === connector.serverId ? nextEnabled : child.enabledForAgent,
        }));
        return { ...group, children, activeCount: children.filter((child) => child.enabledForAgent !== false).length };
      }));
      await onConnectionsChanged?.();
      toast.success(`${connector.name}已${nextEnabled ? "连接" : "解绑"}，下一轮对话生效`);
    } catch (error: any) {
      toast.error(error?.message || "连接切换失败");
    } finally {
      setPendingServerId(null);
    }
  };

  const filterItems: Array<{ id: McpConnectorFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: connectors.length },
    { id: "connected", label: "已连接", count: connectors.filter((item) => item.connected).length },
    { id: "available", label: "可连接", count: connectors.filter((item) => !item.connected).length },
  ];

  return (
    <div className="skills-market skills-mcp">
      <div className="skills-section-filterbar">
        <div className="skills-mcp-filters" role="tablist" aria-label="连接筛选">
          {filterItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className="skills-mcp-filter"
              data-active={filter === item.id ? "true" : "false"}
              onClick={() => setFilter(item.id)}
            >
              {item.label}<span>{item.count}</span>
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="settings-card skills-market-empty"><RefreshCw size={18} className="animate-spin" /><div>正在加载 MCP 工具...</div></div>}
      {!loading && connectors.length === 0 && <div className="settings-card skills-market-empty"><Wrench size={22} /><div>暂无可用连接</div></div>}
      {!loading && connectors.length > 0 && filteredConnectors.length === 0 && <div className="settings-card skills-market-empty"><Search size={22} /><div>没有匹配的连接</div></div>}

      {!loading && filteredConnectors.length > 0 && (
        <div className="skills-mcp-grid">
          {filteredConnectors.map((connector) => {
            const pending = pendingServerId === connector.serverId;
            return (
              <article key={connector.id} className="skills-mcp-card-v2 skills-catalog-card" data-connected={connector.connected ? "true" : "false"}>
                <button className="skills-catalog-card__surface" type="button" onClick={() => setDetailServerId(connector.serverId)}>
                  <span className="skills-catalog-card__head">
                  <span className="skills-catalog-card__icon skills-mcp-card-v2__icon" data-source={connector.source}>
                    {mcpConnectorIcon(connector)}
                  </span>
                  <span className="skills-catalog-card__title-wrap">
                    <span className="skills-catalog-card__title">{connector.name}</span>
                    <span className="skills-catalog-card__meta">{connector.sourceLabel}</span>
                  </span>
                  <span className="skills-mcp-card-v2__status" data-health={connector.health}>
                    <span aria-hidden="true" />{connector.statusLabel}
                  </span>
                  </span>
                  <span className="skills-catalog-card__desc">{connector.description}</span>
                  <span className="skills-catalog-card__footer">
                    <span className="skills-catalog-card__footnote">{connector.category}</span>
                    <span className="skills-catalog-card__link">
                      {pending ? <RotateCw className="animate-spin" /> : "查看"}<ChevronRight />
                    </span>
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(selectedConnector)} onOpenChange={(open) => { if (!open) setDetailServerId(null); }}>
        {selectedConnector ? (
          <DialogContent className="skills-mcp-detail" aria-describedby="skills-mcp-detail-description">
            <div className="skills-mcp-detail__header">
              <span className="skills-mcp-detail__icon" data-source={selectedConnector.source}>
                {mcpConnectorIcon(selectedConnector)}
              </span>
              <div className="skills-mcp-detail__intro">
                <DialogTitle>{selectedConnector.name}</DialogTitle>
                <div className="skills-mcp-detail__meta">
                  <span className="skills-mcp-detail__status" data-health={selectedConnector.health}>
                    <span aria-hidden="true" />{selectedConnector.statusLabel}
                  </span>
                  <span>{selectedConnector.sourceLabel}</span>
                  <span>{selectedConnector.category}</span>
                </div>
                <DialogDescription id="skills-mcp-detail-description">{selectedConnector.description}</DialogDescription>
              </div>
            </div>

            <div className="skills-mcp-detail__body stealth-scrollbar">
              <div className="skills-mcp-detail__section-head">
                <span>包含工具</span>
                <span>{selectedConnector.tools.length}</span>
              </div>
              {selectedConnector.liveError ? (
                <div className="skills-mcp-detail__warning">
                  <CircleAlert aria-hidden="true" />
                  <span>实时检查暂不可用：{selectedConnector.liveError}</span>
                </div>
              ) : null}
              {selectedConnector.tools.length > 0 ? (
                <div className="skills-mcp-detail__tools">
                  {selectedConnector.tools.map((tool) => (
                    <div key={`${selectedConnector.serverId}:${tool.name}`} className="skills-mcp-detail__tool">
                      <span className="skills-mcp-detail__tool-icon"><Check aria-hidden="true" /></span>
                      <span className="skills-mcp-detail__tool-content">
                        <span className="skills-mcp-detail__tool-name">{tool.description || tool.name}</span>
                        {tool.description ? <span className="skills-mcp-detail__tool-id">{tool.name}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="skills-mcp-detail__empty">
                  <Wrench aria-hidden="true" />
                  <span>工具清单尚未同步，连接正常后会自动读取服务声明。</span>
                </div>
              )}
              {selectedConnector.recommendedSkills.length > 0 ? (
                <div className="skills-mcp-detail__related">适配技能：{selectedConnector.recommendedSkills.join("、")}</div>
              ) : null}
            </div>

            <div className="skills-mcp-detail__footer">
              {selectedConnector.connected ? (
                <button
                  className="skills-mcp-detail__button skills-mcp-detail__button--unlink"
                  type="button"
                  disabled={Boolean(pendingServerId)}
                  onClick={() => void toggleConnection(selectedConnector)}
                >
                  {pendingServerId === selectedConnector.serverId ? <RotateCw className="animate-spin" /> : <PowerOff />}
                  解绑
                </button>
              ) : (
                <span className="skills-mcp-detail__connection-note">连接后，工具将在下一轮对话中生效</span>
              )}
              <div className="skills-mcp-detail__footer-actions">
                {!selectedConnector.connected ? (
                  <button
                    className="skills-mcp-detail__button skills-mcp-detail__button--primary"
                    type="button"
                    disabled={Boolean(pendingServerId) || !selectedConnector.configured}
                    onClick={() => void toggleConnection(selectedConnector)}
                  >
                    {pendingServerId === selectedConnector.serverId ? <RotateCw className="animate-spin" /> : <Plug />}
                    {selectedConnector.configured ? "连接" : "尚未配置"}
                  </button>
                ) : (
                  <button
                    className="skills-mcp-detail__button skills-mcp-detail__button--primary"
                    type="button"
                    onClick={() => {
                      setDetailServerId(null);
                      onTryMcp?.();
                    }}
                  >
                    去试试 <ArrowRight />
                  </button>
                )}
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function agentStatusLabel(agent: ExternalAgentSummary) {
  if (agent.routeReady) return "可调用";
  if (agent.reason) return "待配置";
  return "未接入";
}

function agentStatusHealth(agent: ExternalAgentSummary): McpConnectorHealth {
  if (agent.routeReady) return "ready";
  if (agent.providerType || agent.adapterProtocol) return "degraded";
  return "offline";
}

function agentDisplayIcon(agent: ExternalAgentSummary): ReactNode {
  const signature = `${agent.id} ${agent.name}`.toLocaleLowerCase();
  if (signature.includes("wind") || signature.includes("万得")) {
    return <img src="/images/connectors/wind-logo.png" alt="" aria-hidden="true" />;
  }
  if (/ppt|presentation|演示/.test(signature)) return <Presentation aria-hidden="true" />;
  if (/diagram|flow|chart|图表|流程|架构/.test(signature)) return <Workflow aria-hidden="true" />;
  if (/risk|风控|审核/.test(signature)) return <ShieldCheck aria-hidden="true" />;
  return <Bot aria-hidden="true" />;
}

const AGENT_TECH_CAPABILITIES = new Set(["agent", "async-agent", "a2a"]);

const AGENT_CAPABILITY_DISPLAY: Record<string, { name: string; description: string }> = {
  "business-review": {
    name: "业务风险评估",
    description: "识别业务异常线索和关键风险因素，生成评估结论。",
  },
  "long-running-task": {
    name: "持续跟踪评估",
    description: "面向持续跟踪场景评估关键因子和处置建议。",
  },
};

function agentDisplayDescription(agent: ExternalAgentSummary) {
  const signature = `${agent.id} ${agent.name}`.toLocaleLowerCase();
  if (signature.includes("wind") || signature.includes("万得")) {
    return "连接万得金融数据与专业分析能力，完成公司研究、事实核验和投资分析任务。";
  }
  if (/ppt|presentation|演示/.test(signature)) {
    return "将主题、材料和视觉要求整理为可编辑演示文稿，并完成排版、渲染与质量检查。";
  }
  if (/diagram|flow|chart|图表|流程|架构/.test(signature)) {
    return "把业务流程、系统关系或文字说明转换为清晰的流程图、架构图和可交付图稿。";
  }
  if (/risk|风控/.test(signature)) {
    return "对复杂业务材料开展专项风险分析，输出风险结论、依据和后续处置建议。";
  }
  const description = String(agent.description || "").trim();
  if (!description) return "外部智能体，适合需要异步处理的长任务或专项任务。";
  return description
    .replace(/^远端\s*JiuwenSwarm\s*/i, "")
    .replace(/专用\s*Agent/g, "智能体")
    .replace(/外部\s*Agent/g, "智能体");
}

function agentModeLabel(agent: ExternalAgentSummary) {
  if (String(agent.executionMode || "").toLowerCase() === "async") return "异步";
  return "同步";
}

function agentCapabilityTools(agent: ExternalAgentSummary): McpToolSummary[] {
  const capabilities = (agent.capabilities || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => !AGENT_TECH_CAPABILITIES.has(item.toLowerCase()));

  if (capabilities.length === 0) {
    return [{
      name: agent.name || "Agent 任务",
      description: "可在主对话中发起任务，完成后结果回写到原对话。",
    }];
  }

  return capabilities.map((capability) => {
    const display = AGENT_CAPABILITY_DISPLAY[capability];
    return {
      name: display?.name || capability,
      description: display?.description || "可在主对话中发起任务，完成后结果回写到原对话。",
    };
  });
}

function taskStatusLabel(status: ExternalAgentTask["status"]) {
  if (status === "succeeded") return "完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "running") return "执行中";
  return "排队中";
}

type ExpertFilter = "all" | "ready";

function AgentToolsPage({
  adoptId,
  query,
  onTryExpert,
}: {
  adoptId?: string;
  query: string;
  onTryExpert?: (expertId: string) => void;
}) {
  const [agents, setAgents] = useState<ExternalAgentSummary[]>([]);
  const [tasks, setTasks] = useState<ExternalAgentTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<ExpertFilter>("all");
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);

  const loadAgents = async (options?: { silent?: boolean }) => {
    if (!adoptId) return;
    const silent = Boolean(options?.silent);
    if (!silent) setLoading(true);
    try {
      const [agentData, taskData] = await Promise.all([
        fetchJson<ExternalAgentsResponse>(`/api/claw/agents/available?adoptId=${encodeURIComponent(adoptId)}`),
        fetchJson<ExternalAgentTasksResponse>(`/api/claw/agent-tasks?adoptId=${encodeURIComponent(adoptId)}&limit=20`),
      ]);
      const nextAgents = Array.isArray(agentData.agents) ? agentData.agents : [];
      const nextTasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
      setAgents(nextAgents);
      setTasks(nextTasks);
      const checkedAt = new Date().toISOString();
      try {
        window.localStorage.setItem(agentToolsCacheKey(adoptId), JSON.stringify({ agents: nextAgents, tasks: nextTasks, lastCheckedAt: checkedAt }));
      } catch {}
    } catch (e: any) {
      if (!silent && agents.length === 0) {
        toast.error(`Agent 加载失败${e?.message ? `: ${e.message}` : ""}`);
      }
      if (!silent && agents.length === 0) {
        setAgents([]);
        setTasks([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!adoptId) {
      setAgents([]);
      setTasks([]);
      return;
    }
    let hadCache = false;
    try {
      const cached = window.localStorage.getItem(agentToolsCacheKey(adoptId));
      const parsed = cached ? JSON.parse(cached) : null;
      if (Array.isArray(parsed?.agents)) {
        hadCache = parsed.agents.length > 0;
        setAgents(parsed.agents);
        setTasks(Array.isArray(parsed?.tasks) ? parsed.tasks : []);
      }
    } catch {}
    void loadAgents({ silent: hadCache });
  }, [adoptId]);

  useEffect(() => {
    if (!adoptId) return;
    const refreshVisiblePage = () => {
      if (document.visibilityState === "visible") void loadAgents({ silent: true });
    };
    const timer = window.setInterval(refreshVisiblePage, 30_000);
    document.addEventListener("visibilitychange", refreshVisiblePage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
    };
  }, [adoptId]);

  const recentTaskByAgent = useMemo(() => {
    const map = new Map<string, ExternalAgentTask[]>();
    for (const task of tasks) {
      const bucket = map.get(task.agentId) || [];
      bucket.push(task);
      map.set(task.agentId, bucket);
    }
    return map;
  }, [tasks]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === detailAgentId) || null,
    [agents, detailAgentId],
  );
  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return agents.filter((agent) => {
      if (filter === "ready" && !agent.routeReady) return false;
      if (!normalizedQuery) return true;
      return `${agent.name} ${agentDisplayDescription(agent)} ${(agent.capabilities || []).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [agents, filter, query]);
  const filterItems: Array<{ id: ExpertFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: agents.length },
    { id: "ready", label: "可调用", count: agents.filter((agent) => agent.routeReady).length },
  ];

  return (
    <div className="skills-market skills-agent">
      <div className="skills-section-filterbar">
        <div className="skills-mcp-filters" role="tablist" aria-label="专家筛选">
          {filterItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className="skills-mcp-filter"
              data-active={filter === item.id ? "true" : "false"}
              onClick={() => setFilter(item.id)}
            >
              {item.label}<span>{item.count}</span>
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="settings-card skills-market-empty"><RefreshCw size={18} className="animate-spin" /><div>正在加载专家...</div></div>}
      {!loading && agents.length === 0 && <div className="settings-card skills-market-empty"><Bot size={22} /><div>暂无可用专家</div></div>}
      {!loading && agents.length > 0 && filteredAgents.length === 0 && <div className="settings-card skills-market-empty"><Search size={22} /><div>没有匹配的专家</div></div>}

      {!loading && filteredAgents.length > 0 && (
        <div className="skills-mcp-grid">
          {filteredAgents.map((agent) => (
            <article key={agent.id} className="skills-mcp-card-v2 skills-catalog-card skills-expert-card" data-connected={agent.routeReady ? "true" : "false"}>
              <button className="skills-catalog-card__surface" type="button" onClick={() => setDetailAgentId(agent.id)}>
                <span className="skills-catalog-card__head">
                <span className="skills-catalog-card__icon skills-mcp-card-v2__icon" data-source={agent.source === "personal" ? "personal" : "preset"}>
                  {agentDisplayIcon(agent)}
                </span>
                <span className="skills-catalog-card__title-wrap">
                  <span className="skills-catalog-card__title">{agent.name}</span>
                  <span className="skills-catalog-card__meta">{agent.source === "personal" ? "我的专家" : "公共专家"}</span>
                </span>
                <span className="skills-mcp-card-v2__status" data-health={agentStatusHealth(agent)}>
                  <span aria-hidden="true" />{agentStatusLabel(agent)}
                </span>
                </span>
                <span className="skills-catalog-card__desc">{agentDisplayDescription(agent)}</span>
                <span className="skills-catalog-card__footer">
                  <span className="skills-catalog-card__footnote">
                    {agentModeLabel(agent)}协作{agent.interactionMode === "session" ? " · 连续对话" : ""}
                  </span>
                  <span className="skills-catalog-card__link">查看 <ChevronRight /></span>
                </span>
              </button>
            </article>
          ))}
        </div>
      )}

      <Dialog open={Boolean(selectedAgent)} onOpenChange={(open) => { if (!open) setDetailAgentId(null); }}>
        {selectedAgent ? (
          <DialogContent className="skills-mcp-detail skills-expert-detail" aria-describedby="skills-expert-detail-description">
            <div className="skills-mcp-detail__header">
              <span className="skills-mcp-detail__icon" data-source={selectedAgent.source === "personal" ? "personal" : "preset"}>
                {agentDisplayIcon(selectedAgent)}
              </span>
              <div className="skills-mcp-detail__intro">
                <DialogTitle>{selectedAgent.name}</DialogTitle>
                <div className="skills-mcp-detail__meta">
                  <span className="skills-mcp-detail__status" data-health={agentStatusHealth(selectedAgent)}>
                    <span aria-hidden="true" />{agentStatusLabel(selectedAgent)}
                  </span>
                  <span>{selectedAgent.source === "personal" ? "我的专家" : "公共专家"}</span>
                  <span>{agentModeLabel(selectedAgent)}协作</span>
                </div>
                <DialogDescription id="skills-expert-detail-description">{agentDisplayDescription(selectedAgent)}</DialogDescription>
              </div>
            </div>

            <div className="skills-mcp-detail__body stealth-scrollbar">
              {selectedAgent.reason && !selectedAgent.routeReady ? (
                <div className="skills-mcp-detail__warning">
                  <CircleAlert aria-hidden="true" />
                  <span>{selectedAgent.reason}</span>
                </div>
              ) : null}
              <div className="skills-mcp-detail__section-head">
                <span>专业能力</span>
                <span>{agentCapabilityTools(selectedAgent).length}</span>
              </div>
              <div className="skills-mcp-detail__tools">
                {agentCapabilityTools(selectedAgent).map((tool) => (
                  <div key={`${selectedAgent.id}:${tool.name}`} className="skills-mcp-detail__tool">
                    <span className="skills-mcp-detail__tool-icon"><Check aria-hidden="true" /></span>
                    <span className="skills-mcp-detail__tool-content">
                      <span className="skills-mcp-detail__tool-name">{tool.name}</span>
                      <span className="skills-mcp-detail__tool-id skills-expert-detail__capability">{tool.description}</span>
                    </span>
                  </div>
                ))}
              </div>

              <div className="skills-mcp-detail__section-head skills-expert-detail__tasks-head">
                <span>最近任务</span>
                <span>{(recentTaskByAgent.get(selectedAgent.id) || []).length}</span>
              </div>
              {(recentTaskByAgent.get(selectedAgent.id) || []).length > 0 ? (
                <div className="skills-expert-detail__tasks">
                  {(recentTaskByAgent.get(selectedAgent.id) || []).slice(0, 4).map((task) => (
                    <div key={task.id} className="skills-expert-detail__task">
                      <span className="skills-expert-detail__task-main">
                        <span>{task.input.slice(0, 66)}{task.input.length > 66 ? "…" : ""}</span>
                        <small>{task.createdAt ? new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false }) : task.id}</small>
                      </span>
                      <span className="skills-expert-detail__task-status" data-status={task.status}>{taskStatusLabel(task.status)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="skills-expert-detail__tasks-empty">还没有调用记录</div>
              )}
            </div>

            <div className="skills-mcp-detail__footer">
              <span className="skills-mcp-detail__connection-note">任务完成后会自动写回主对话</span>
              <div className="skills-mcp-detail__footer-actions">
                <button
                  className="skills-mcp-detail__button skills-mcp-detail__button--primary"
                  type="button"
                  disabled={!selectedAgent.routeReady}
                  onClick={() => {
                    const expertId = selectedAgent.id;
                    setDetailAgentId(null);
                    onTryExpert?.(expertId);
                  }}
                >
                  {selectedAgent.routeReady ? "召唤专家" : "暂不可用"} <ArrowRight />
                </button>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function SkillsToolbar({
  source,
  setSource,
  state,
  setState,
}: {
  source: SourceFilter;
  setSource: (v: SourceFilter) => void;
  state: StateFilter;
  setState: (v: StateFilter) => void;
}) {
  const sourceFilters: { key: SourceFilter; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "builtin", label: "平台内置" },
    { key: "role_default", label: "岗位预置" },
    { key: "marketplace", label: "广场安装" },
    { key: "uploaded", label: "我的上传" },
    { key: "generated", label: "对话生成" },
    { key: "runtime_imported", label: "运行时导入" },
  ];
  const stateFilters: { key: StateFilter; label: string }[] = [
    { key: "all", label: "全部状态" },
    { key: "ready", label: "可用" },
    { key: "attention", label: "需处理" },
    { key: "disabled", label: "已停用" },
  ];

  return (
    <div className="skills-toolbar skills-my-filters">
      <div className="skills-mcp-filters" role="tablist" aria-label="技能来源筛选">
        {sourceFilters.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={source === item.key} className="skills-mcp-filter" data-active={source === item.key ? "true" : "false"} onClick={() => setSource(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="skills-mcp-filters" role="tablist" aria-label="技能状态筛选">
        {stateFilters.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={state === item.key} className="skills-mcp-filter" data-active={state === item.key ? "true" : "false"} onClick={() => setState(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  onOpen,
  onToggle,
  busy,
}: {
  skill: RegistrySkill;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  busy: boolean;
}) {
  const canToggle = sourceCanToggle(skill);
  return (
    <div
      className="skills-my-card skills-catalog-card settings-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="skills-catalog-card__head">
        <span className="skills-catalog-card__icon" aria-hidden="true">{skillIcon(skill)}</span>
        <span className="skills-catalog-card__title-wrap">
          <span className="skills-catalog-card__title">{displayNameOf(skill)}</span>
        </span>
        <span className="skills-catalog-card__status">
          <button
            className={`skills-switch ${skill.enabled ? "is-on" : "is-off"}`}
            type="button"
            disabled={busy || !canToggle}
            onClick={(event) => {
              event.stopPropagation();
              if (canToggle) onToggle(!skill.enabled);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            aria-label={canToggle ? (skill.enabled ? "停用技能" : "启用技能") : "技能当前不可切换"}
            title={canToggle ? (skill.enabled ? "停用技能" : "启用技能") : "技能当前不可切换"}
          >
            <span className={`skills-switch-dot ${skill.enabled ? "on" : ""}`} />
          </button>
        </span>
      </div>
      <div className="skills-catalog-card__desc">{descriptionOf(skill)}</div>
    </div>
  );
}

function SkillDetailModal({
  skill,
  onClose,
  onReconcile,
  onToggle,
  onUninstall,
  onDestroy,
  onRename,
  onPublish,
  busy,
}: {
  skill: RegistrySkill | null;
  onClose: () => void;
  onReconcile: (skill: RegistrySkill) => void;
  onToggle: (skill: RegistrySkill, enabled: boolean) => void;
  onUninstall: (skill: RegistrySkill) => void;
  onDestroy: (skill: RegistrySkill) => void;
  onRename: (skill: RegistrySkill) => void;
  onPublish: (skill: RegistrySkill) => void;
  busy: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [intro, setIntro] = useState<SkillIntroductionResponse | null>(null);
  const [introLoading, setIntroLoading] = useState(false);
  useEffect(() => setAdvancedOpen(false), [skill?.id]);
  useEffect(() => {
    if (!skill) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, skill]);
  useEffect(() => {
    setIntro(null);
    if (!skill) return;
    let cancelled = false;
    setIntroLoading(true);
    fetchJson<SkillIntroductionResponse>(
      `/api/claw/skills/introduction?adoptId=${encodeURIComponent(skill.adoptId)}&skillId=${encodeURIComponent(skill.id)}`,
    )
      .then((data) => {
        if (!cancelled) setIntro(data);
      })
      .catch(() => {
        if (!cancelled) {
          setIntro({ skillId: skill.id, introduction: descriptionOf(skill), source: "fallback" });
        }
      })
      .finally(() => {
        if (!cancelled) setIntroLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill?.adoptId, skill?.id]);
  if (!skill) return null;
  const tone = stateTone(skill.state);
  const canToggle = sourceCanToggle(skill);

  return (
    <div className="skills-detail-modal" role="dialog" aria-modal="true" aria-label={`${displayNameOf(skill)} 详情`} onClick={onClose}>
      <div className="skills-detail-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="skills-detail-modal__head">
          <div>
            <div className="skills-detail-modal__title">
              {displayNameOf(skill)}
            </div>
            <div className="skills-muted-text text-xs">
              {SOURCE_LABEL[skill.source.kind]} · {skill.id}
            </div>
          </div>
          <button className="skills-btn" onClick={onClose}>关闭</button>
        </div>
        <div className="skills-detail-modal__body">
          <div className="settings-card space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <SkillPill>{sourceIcon(skill.source.kind)} {SOURCE_LABEL[skill.source.kind]}</SkillPill>
              <SkillPill tone={tone}>{STATE_LABEL[skill.state]}</SkillPill>
              {skill.review.state !== "none" && <SkillPill tone={skill.review.state === "failed" ? "danger" : "warn"}>审核：{skill.review.state}</SkillPill>}
            </div>

            <div className="skills-body-text text-xs">
              {descriptionOf(skill)}
            </div>

            <div className="skills-intro-card">
              <div className="settings-label">技能介绍</div>
              <div className="skills-intro-text">
                {introLoading ? "正在加载技能介绍..." : intro?.introduction || descriptionOf(skill)}
              </div>
            </div>

            {reasonOf(skill) && (
              <div className="settings-card skills-danger-card">
                <div className="skills-danger-message flex items-start gap-2 text-xs">
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{reasonOf(skill)}</span>
                </div>
              </div>
            )}

            <div className="settings-row">
              <span className="settings-label">启用状态</span>
              <button
                className={`skills-switch ${skill.enabled ? "is-on" : "is-off"}`}
                disabled={busy || !canToggle}
                onClick={() => canToggle && onToggle(skill, !skill.enabled)}
                title={canToggle ? undefined : "技能当前不可切换"}
              >
                <span className={`skills-switch-dot ${skill.enabled ? "on" : ""}`} />
              </button>
            </div>

            <div className="settings-row">
              <span className="settings-label">最近同步</span>
              <span className="skills-muted-text text-xs">{skill.sync.lastSyncedAt || "未记录"}</span>
            </div>

            <div className="space-y-2">
              <div className="settings-label">操作</div>
              <div className="flex items-center gap-2 flex-wrap">
                <button className="skills-btn" disabled={busy} onClick={() => onReconcile(skill)}><RotateCw size={13} /> 重新同步</button>
                {canToggle && (
                  <button className="skills-btn" disabled={busy} onClick={() => onToggle(skill, !skill.enabled)}>
                    {skill.enabled ? <PowerOff size={13} /> : <Power size={13} />}
                    {skill.enabled ? "停用" : "启用"}
                  </button>
                )}
                {sourceCanRename(skill) && <button className="skills-btn" disabled={busy} onClick={() => onRename(skill)}><Pencil size={13} /> 重命名</button>}
                {sourceCanPublish(skill) && <button className="skills-btn" disabled={busy} onClick={() => onPublish(skill)}><Store size={13} /> 提交到中队专区</button>}
                {sourceCanUninstall(skill) && <button className="skills-btn" disabled={busy} onClick={() => onUninstall(skill)}><Trash2 size={13} /> 卸载</button>}
                {sourceCanDestroy(skill) && <button className="skills-btn" disabled={busy} onClick={() => onDestroy(skill)}><Trash2 size={13} /> 删除</button>}
              </div>
            </div>

            <div className="space-y-2">
              <button className="skills-group-toggle" onClick={() => setAdvancedOpen(!advancedOpen)}>
                {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>高级信息</span>
              </button>
              {advancedOpen && (
                <div className="skills-advanced-info text-xs space-y-1">
                  <div>sourcePath: {skill.source.sourcePath || "无"}</div>
                  <div>runtimePath: {skill.sync.runtimePath || "无"}</div>
                  <div>version: {skill.source.version || "未记录"}</div>
                  <div>scan: {skill.scan?.scannedAt || "未扫描"}</div>
                  {skill.scan?.warnings?.length ? (
                    <div className="skills-warning-list space-y-1">
                      <div>静态扫描提示：</div>
                      {skill.scan.warnings.map((warning, idx) => (
                        <div key={`${warning}-${idx}`}>- {warning}</div>
                      ))}
                    </div>
                  ) : (
                    <div>静态扫描提示：无</div>
                  )}
                  <div>updatedAt: {skill.updatedAt}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkillsPage({ adoptId, onChanged, onAddMcp, onManageMcp, onTryMcp, onMcpChanged, onAddExpert, onManageExpert, onTryExpert }: {
  skills?: { shared: any[]; system: any[]; private: any[] } | null | undefined;
  canEdit?: boolean;
  pending?: boolean;
  onToggle?: (skillId: string, enable: boolean, source: "shared" | "system") => void;
  adoptId?: string;
  onChanged?: () => void | Promise<void>;
  onAddMcp?: () => void;
  onManageMcp?: () => void;
  onTryMcp?: () => void;
  onMcpChanged?: () => void | Promise<void>;
  onAddExpert?: () => void;
  onManageExpert?: () => void;
  onTryExpert?: (expertId: string) => void;
}) {
  const { confirm, dialog } = useConfirmDialog();
  const [skillTab, setSkillTab] = useState<SkillTab>(() => cachedSkillTab());
  const [lastSkillView, setLastSkillView] = useState<"mine" | "market">(() => cachedSkillTab() === "market" ? "market" : "mine");
  const [items, setItems] = useState<RegistrySkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RegistrySkill | null>(null);
  const [q, setQ] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [mcpQuery, setMcpQuery] = useState("");
  const [expertQuery, setExpertQuery] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    if (!adoptId) return;
    setLoading(true);
    try {
      const data = await fetchJson<{ items: RegistrySkill[] }>(`/api/claw/skills/registry?adoptId=${encodeURIComponent(adoptId)}`);
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e: any) {
      toast.error(`技能加载失败${e?.message ? `: ${e.message}` : ""}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(SKILL_TAB_CACHE_KEY, skillTab);
    } catch {}
    if (skillTab === "mine" || skillTab === "market") setLastSkillView(skillTab);
    if (skillTab === "mine") void load();
  }, [adoptId, skillTab]);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim().toLowerCase()), 180);
    return () => clearTimeout(t);
  }, [q]);

  const filtered = useMemo(() => {
    return items.filter((skill) => {
      if (sourceFilter !== "all" && skill.source.kind !== sourceFilter) return false;
      if (stateFilter === "ready" && skill.state !== "ready") return false;
      if (stateFilter === "disabled" && skill.state !== "disabled") return false;
      if (stateFilter === "attention" && !["sync_failed", "source_missing", "review_pending", "reviewing", "review_failed"].includes(skill.state)) return false;
      if (!qDebounced) return true;
      return `${skill.id} ${displayNameOf(skill)} ${descriptionOf(skill)} ${SOURCE_LABEL[skill.source.kind]}`.toLowerCase().includes(qDebounced);
    });
  }, [items, qDebounced, sourceFilter, stateFilter]);

  const reloadDetail = (nextItems: RegistrySkill[]) => {
    if (!detail) return;
    const nextDetail = nextItems.find((x) => x.id === detail.id && x.adoptId === detail.adoptId) || null;
    setDetail(nextDetail);
  };

  const mutate = async (skill: RegistrySkill, label: string, fn: () => Promise<void>) => {
    setBusyId(skill.id);
    try {
      await fn();
      const data = await fetchJson<{ items: RegistrySkill[] }>(`/api/claw/skills/registry?adoptId=${encodeURIComponent(skill.adoptId)}`);
      const next = Array.isArray(data.items) ? data.items : [];
      setItems(next);
      reloadDetail(next);
      await onChanged?.();
      toast.success(label);
    } catch (e: any) {
      toast.error(`${label}失败${e?.message ? `: ${e.message}` : ""}`);
    } finally {
      setBusyId(null);
    }
  };

  const onReconcile = (skill: RegistrySkill) => mutate(skill, "已重新同步", async () => {
    await fetchJson("/api/claw/skills/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId: skill.adoptId, skillId: skill.id }),
    });
  });

  const onToggleSkill = (skill: RegistrySkill, enabled: boolean) => mutate(skill, enabled ? "已启用" : "已停用", async () => {
    await fetchJson("/api/claw/skills/set-enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId: skill.adoptId, skillId: skill.id, enabled }),
    });
  });

  const onUninstall = async (skill: RegistrySkill) => {
    const ok = await confirm({
      title: "卸载技能？",
      description: `确认卸载 ${displayNameOf(skill)}？广场源不会删除，可重新安装。`,
      confirmText: "卸载",
      variant: "danger",
    });
    if (!ok) return;
    void mutate(skill, "已卸载", async () => {
      await fetchJson("/api/claw/skills/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: skill.adoptId, skillId: skill.id }),
      });
    });
  };

  const onDestroy = async (skill: RegistrySkill) => {
    const ok = await confirm({
      title: "删除技能？",
      description: `确认删除 ${displayNameOf(skill)}？这会删除源文件和运行时副本。`,
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    void mutate(skill, "已删除", async () => {
      await fetchJson("/api/claw/skills/destroy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: skill.adoptId, skillId: skill.id }),
      });
    });
  };

  const onRename = (skill: RegistrySkill) => {
    const displayName = prompt("新的技能名称", displayNameOf(skill))?.trim();
    if (!displayName || displayName === skill.source.displayName) return;
    void mutate(skill, "已重命名", async () => {
      await fetchJson("/api/claw/skills/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: skill.adoptId, skillId: skill.id, displayName }),
      });
    });
  };

  const onPublish = (skill: RegistrySkill) => {
    const version = prompt("发布版本号", skill.source.version || "1.0.0")?.trim() || "1.0.0";
    if (!version) return;
    void mutate(skill, "已提交审核", async () => {
      await fetchJson("/api/claw/skill-market/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: skill.adoptId, skillId: skill.id, version }),
      });
    });
  };

  const onUploadFile = async (file: File) => {
    if (!adoptId) {
      toast.error("请先进入具体岗位智能体实例后再上传技能");
      return;
    }
    if (!/\.(zip|skill)$/i.test(file.name)) {
      toast.error("请上传 .zip 或 .skill 技能包");
      return;
    }
    setUploading(true);
    try {
      const inspect = await inspectSkillPackage(file, adoptId);
      const defaultName = inspect.skill.displayName || inspect.skill.skillId || file.name.replace(/\.(zip|skill)$/i, "");
      const displayName = prompt("技能名称", defaultName)?.trim();
      if (!displayName) return;
      if (displayName.length < 2) {
        toast.error("技能名称至少 2 个字");
        return;
      }
      const description = prompt("技能说明", inspect.skill.description || "")?.trim() || inspect.skill.description || "";
      await uploadSkillPackage({
        adoptId,
        file,
        displayName,
        description,
      });
      if (inspect.skill.warnings?.length) {
        toast.warning(`技能已上传，静态扫描提示 ${inspect.skill.warnings.length} 项，请在详情中确认。`);
      } else {
        toast.success("技能已上传并同步到运行环境");
      }
      setSourceFilter("uploaded");
      setSkillTab("mine");
      await load();
      await onChanged?.();
    } catch (e: any) {
      toast.error(e?.message || "上传失败");
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const activeSearch = skillTab === "mine"
    ? q
    : skillTab === "market"
      ? marketQuery
      : skillTab === "mcp"
        ? mcpQuery
        : expertQuery;
  const updateActiveSearch = (value: string) => {
    if (skillTab === "mine") setQ(value);
    else if (skillTab === "market") setMarketQuery(value);
    else if (skillTab === "mcp") setMcpQuery(value);
    else setExpertQuery(value);
  };
  const activeSearchPlaceholder = skillTab === "mcp"
    ? "搜索工具…"
    : skillTab === "agent"
      ? "搜索专家…"
      : "搜索技能…";

  return (
    <PageContainer title="插件中心">
      {dialog}
      <div className="skills-page">
        <div className="skills-console-toolbar">
        <div className="page-tabs" role="tablist" aria-label="插件分区" onKeyDown={(e) => handleRovingTabKey(e, SKILL_NAV_TAB_KEYS, skillTab === "mine" ? "market" : skillTab, setSkillTab)}>
          <button id="skills-tab-market" className="page-tab" data-active={skillTab === "market" || skillTab === "mine" ? "true" : "false"} role="tab" aria-selected={skillTab === "market" || skillTab === "mine"} aria-controls={skillTab === "mine" ? "skills-panel-mine" : "skills-panel-market"} tabIndex={skillTab === "market" || skillTab === "mine" ? 0 : -1} onClick={() => setSkillTab(lastSkillView)}>
            <Store className="page-tab__icon" aria-hidden="true" />
            技能
          </button>
          <button id="skills-tab-agent" className="page-tab" data-active={skillTab === "agent" ? "true" : "false"} role="tab" aria-selected={skillTab === "agent"} aria-controls="skills-panel-agent" tabIndex={skillTab === "agent" ? 0 : -1} onClick={() => setSkillTab("agent")}>
            <Bot className="page-tab__icon" aria-hidden="true" />
            专家
          </button>
          <button id="skills-tab-mcp" className="page-tab" data-active={skillTab === "mcp" ? "true" : "false"} role="tab" aria-selected={skillTab === "mcp"} aria-controls="skills-panel-mcp" tabIndex={skillTab === "mcp" ? 0 : -1} onClick={() => setSkillTab("mcp")}>
            <Plug className="page-tab__icon" aria-hidden="true" />
            连接器
          </button>
        </div>
        <div className="skills-console-toolbar__actions">
          <label className="skills-search skills-console-search">
            <Search size={14} aria-hidden="true" />
            <input value={activeSearch} onChange={(event) => updateActiveSearch(event.target.value)} placeholder={activeSearchPlaceholder} />
          </label>
          {skillTab === "market" || skillTab === "mine" ? (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".zip,.skill"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onUploadFile(file);
                }}
              />
              <button className="skills-console-action" type="button" disabled={uploading} onClick={() => uploadInputRef.current?.click()}>
                {uploading ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                {uploading ? "添加中" : "添加技能"}
              </button>
            </>
          ) : skillTab === "mcp" ? (
            <>
              {onManageMcp ? <button className="skills-console-action" type="button" onClick={onManageMcp}><Plug aria-hidden="true" /> 我的连接</button> : null}
              {onAddMcp ? <button className="skills-console-action" type="button" onClick={onAddMcp}><Plus aria-hidden="true" /> 添加连接</button> : null}
            </>
          ) : (
            <>
              {onManageExpert ? <button className="skills-console-action" type="button" onClick={onManageExpert}><Bot aria-hidden="true" /> 我的专家</button> : null}
              {onAddExpert ? <button className="skills-console-action" type="button" onClick={onAddExpert}><Plus aria-hidden="true" /> 添加专家</button> : null}
            </>
          )}
        </div>
        </div>

        {(skillTab === "market" || skillTab === "mine") && (
          <div className="skills-secondary-tabs" role="tablist" aria-label="技能子页面">
            <button
              type="button"
              role="tab"
              aria-selected={skillTab === "market"}
              data-active={skillTab === "market" ? "true" : "false"}
              onClick={() => setSkillTab("market")}
            >
              技能市场
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={skillTab === "mine"}
              data-active={skillTab === "mine" ? "true" : "false"}
              onClick={() => setSkillTab("mine")}
            >
              我的技能
            </button>
          </div>
        )}

        {skillTab === "market" && (
          <div id="skills-panel-market" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-market" tabIndex={0}>
            <MarketplacePage adoptId={adoptId} onChanged={onChanged} query={marketQuery} />
          </div>
        )}

        {skillTab === "mcp" && (
          <div id="skills-panel-mcp" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-mcp" tabIndex={0}>
            <McpToolsPage
              adoptId={adoptId}
              query={mcpQuery}
              onTryMcp={onTryMcp}
              onConnectionsChanged={onMcpChanged}
            />
          </div>
        )}

        {skillTab === "agent" && (
          <div id="skills-panel-agent" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-agent" tabIndex={0}>
            <AgentToolsPage adoptId={adoptId} query={expertQuery} onTryExpert={onTryExpert} />
          </div>
        )}

        {skillTab === "mine" && (
          <div id="skills-panel-mine" className="skills-panel stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-mine" tabIndex={0}>
            <SkillsToolbar source={sourceFilter} setSource={setSourceFilter} state={stateFilter} setState={setStateFilter} />

            <div className="skills-market-grid skills-mine-grid">
              {loading && <div className="settings-card skills-muted-card text-sm">正在加载技能...</div>}
              {!loading && filtered.length === 0 && <div className="settings-card skills-muted-card text-sm">暂无匹配技能</div>}
              {!loading && filtered.map((skill) => (
                <SkillRow
                  key={`${skill.adoptId}:${skill.id}`}
                  skill={skill}
                  busy={busyId === skill.id}
                  onOpen={() => setDetail(skill)}
                  onToggle={(enabled) => onToggleSkill(skill, enabled)}
                />
              ))}
            </div>

            <SkillDetailModal
              skill={detail}
              busy={!!busyId}
              onClose={() => setDetail(null)}
              onReconcile={onReconcile}
              onToggle={onToggleSkill}
              onUninstall={onUninstall}
              onDestroy={onDestroy}
              onRename={onRename}
              onPublish={onPublish}
            />
          </div>
        )}
      </div>
    </PageContainer>
  );
}
