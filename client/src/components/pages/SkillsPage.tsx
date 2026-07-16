import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
  Package,
  Pencil,
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
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer } from "@/components/console/PageContainer";
import { handleRovingTabKey } from "@/lib/a11y";
import { MarketplacePage } from "./MarketplacePage";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

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

type SkillPackageInspectResponse = {
  skill: {
    skillId: string;
    displayName: string;
    description?: string;
    warnings?: string[];
  };
};

type SkillIntroductionResponse = {
  skillId: string;
  introduction: string;
  source: "runtime" | "source" | "registry" | "fallback";
};

const SKILL_TAB_KEYS = ["mine", "market", "mcp", "agent"] as const;
type SkillTab = (typeof SKILL_TAB_KEYS)[number];
type SourceFilter = "all" | SourceKind;
type StateFilter = "all" | "ready" | "attention" | "disabled";
const SKILL_TAB_CACHE_KEY = "employee-agent:skills:last-tab";
const MCP_TOOLS_CACHE_PREFIX = "employee-agent:mcp-tools:v3:";
const AGENT_TOOLS_CACHE_PREFIX = "employee-agent:agent-tools:v1:";

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

type ExternalAgentSummary = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags?: string;
  providerType?: string;
  adapterProtocol?: string;
  executionMode?: string;
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

async function fetchSkillPackageBinary<T>(url: string, file: File, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params);
  return fetchJson<T>(`${url}?${qs.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
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

function mcpStatusTone(status: McpServerStatus): "ok" | "warn" | "neutral" {
  if (status === "available") return "ok";
  if (status === "disabled") return "warn";
  return "neutral";
}

function mcpStatusLabel(status: McpServerStatus) {
  if (status === "available") return "可用";
  if (status === "disabled") return "暂不可用";
  return "未接入";
}

function mcpLiveStatusLabel(status?: McpLiveStatus) {
  if (status === "live") return "实时";
  if (status === "unavailable") return "连接失败";
  if (status === "unsupported") return "未探测";
  return "配置";
}

function mcpLiveStatusTone(status?: McpLiveStatus): "ok" | "warn" | "neutral" {
  if (status === "live") return "ok";
  if (status === "unavailable") return "warn";
  return "neutral";
}

function mcpScopeOf(item: McpToolGroup): "public" | "internal" | "platform" {
  if (item.category === "公共金融数据") return "public";
  if (item.category === "内部业务 MCP") return "internal";
  return "platform";
}

function mcpScopeLabel(scope: "public" | "internal" | "platform") {
  if (scope === "public") return "public";
  if (scope === "internal") return "internal";
  return "platform";
}

function McpToolsPage({ adoptId }: { adoptId?: string }) {
  const [items, setItems] = useState<McpToolGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(new Set());
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

  const loadMcpTools = async (options?: { silent?: boolean; force?: boolean }) => {
    if (!adoptId) return;
    const silent = Boolean(options?.silent);
    if (!silent) setLoading(true);
    try {
      const force = options?.force ? "&force=1" : "";
      const data = await fetchJson<McpToolsResponse>(`/api/claw/mcp-tools/status?adoptId=${encodeURIComponent(adoptId)}${force}`);
      const nextItems = Array.isArray(data.items) ? data.items : [];
      setItems(nextItems);
      setLastCheckedAt(data.live?.checkedAt || new Date().toISOString());
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
        setLastCheckedAt(parsed?.lastCheckedAt || null);
        setLoading(false);
      }
    } catch {}
    void loadMcpTools({ silent: hadCache });
  }, [adoptId]);

  useEffect(() => {
    setOpenGroupIds((current) => {
      const validIds = new Set(items.map((item) => item.id));
      return new Set([...current].filter((id) => validIds.has(id)));
    });
  }, [items]);

  const toggleGroup = (groupId: string) => {
    setOpenGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const availableGroups = items.filter((item) => item.status === "available").length;
  const configuredServers = items.reduce((sum, item) => sum + item.configuredCount, 0);
  const availableServers = items.reduce((sum, item) => sum + item.availableCount, 0);

  return (
    <div className="skills-market skills-mcp">
      <div className="skills-header">
        <div className="skills-summary skills-muted-text text-xs">
          共 {items.length} 类能力 · {availableGroups} 类可用 · {availableServers}/{configuredServers} 个服务已启用
          {lastCheckedAt ? ` · ${new Date(lastCheckedAt).toLocaleTimeString("zh-CN", { hour12: false })} 刷新` : ""}
        </div>
        <button className="skills-btn" onClick={() => void loadMcpTools({ force: true })} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {loading && <div className="settings-card skills-market-empty"><RefreshCw size={18} className="animate-spin" /><div>正在加载 MCP 工具...</div></div>}
      {!loading && items.length === 0 && <div className="settings-card skills-market-empty"><Wrench size={22} /><div>暂无 MCP 工具配置</div></div>}

      {!loading && items.length > 0 && (
        <div className="skills-mcp-groups">
            {items.map((item) => {
              const groupOpen = openGroupIds.has(item.id);
              const scope = mcpScopeOf(item);
              const flatChild = item.children?.length === 1 ? item.children[0] : null;
              const flatTools = flatChild?.tools && flatChild.tools.length > 0
                ? flatChild.tools
                : [{ name: "tool_list", description: "该 MCP 已接入，工具明细以管理员配置为准。" }];
              return (
                <section key={item.id} className="settings-card skills-mcp-group" data-open={groupOpen ? "true" : "false"}>
                  <button
                    className="skills-mcp-group__head"
                    type="button"
                    aria-expanded={groupOpen}
                    onClick={() => toggleGroup(item.id)}
                  >
                    <span className="skills-mcp-group__chevron">
                      {groupOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                    <span className="skills-mcp-group__title-wrap">
                      <span className="skills-mcp-group__title">
                        <Wrench size={16} />
                        <span>{item.name}</span>
                      </span>
                      <span className="skills-mcp-group__desc">{item.description}</span>
                    </span>
                    <span className="skills-mcp-group__status">
                      <span className={`skills-chip skills-mcp-scope skills-mcp-scope--${scope}`}>{mcpScopeLabel(scope)}</span>
                      <span className={`skills-chip ${pillToneClass(mcpLiveStatusTone(item.liveStatus))}`}>
                        {mcpLiveStatusLabel(item.liveStatus)}
                      </span>
                      <span className={`skills-chip ${pillToneClass(mcpStatusTone(item.status))}`}>
                        {mcpStatusLabel(item.status)} {item.availableCount}/{item.serverCount}
                      </span>
                    </span>
                  </button>

                  <div className="skills-mcp-group__body" aria-hidden={!groupOpen}>
                    {flatChild ? (
                      <div className="skills-mcp-flat">
                        <div className="skills-mcp-flat__head">
                          <span className="skills-mcp-child__main">
                            <span className="skills-mcp-child__name">{flatChild.name}</span>
                            <span className="skills-mcp-child__desc">{flatChild.description}</span>
                          </span>
                          <span className="skills-mcp-flat__meta">
                            <span className="skills-mcp-child__server">{flatChild.serverId}</span>
                            <span className={`skills-chip ${pillToneClass(mcpLiveStatusTone(flatChild.liveStatus))}`}>{mcpLiveStatusLabel(flatChild.liveStatus)}</span>
                            <span className={`skills-chip ${pillToneClass(mcpStatusTone(flatChild.status))}`}>{mcpStatusLabel(flatChild.status)}</span>
                          </span>
                        </div>
                        {flatChild.liveError && (
                          <div className="skills-muted-text text-xs">实时探测失败，当前展示配置回退：{flatChild.liveError}</div>
                        )}
                        <div className="skills-mcp-tools">
                          {flatTools.map((tool) => (
                            <div key={`${flatChild.id}:${tool.name}`} className="skills-mcp-tool">
                              <div className="skills-mcp-tool__label">工具名</div>
                              <div className="skills-mcp-tool__name">{tool.name}</div>
                              <div className="skills-mcp-tool__desc">{tool.description}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="skills-mcp-children">
                        {(item.children || []).map((child) => {
                          const childTone = mcpStatusTone(child.status);
                          const tools = child.tools && child.tools.length > 0
                            ? child.tools
                            : [{ name: "tool_list", description: "该 MCP 已接入，工具明细以管理员配置为准。" }];
                          return (
                            <div key={child.id} className="skills-mcp-child" data-open="true">
                              <div className="skills-mcp-child__row">
                                <span className="skills-mcp-child__main">
                                  <span className="skills-mcp-child__name">{child.name}</span>
                                  <span className="skills-mcp-child__desc">{child.description}</span>
                                </span>
                                <span className="skills-mcp-child__meta">
                                  <span className="skills-mcp-child__server">{child.serverId}</span>
                                  <span className={`skills-chip ${pillToneClass(mcpLiveStatusTone(child.liveStatus))}`}>{mcpLiveStatusLabel(child.liveStatus)}</span>
                                  <span className={`skills-chip ${pillToneClass(childTone)}`}>{mcpStatusLabel(child.status)}</span>
                                </span>
                              </div>

                              <div className="skills-mcp-child__panel" aria-hidden="false">
                                {child.liveError && (
                                  <div className="skills-muted-text text-xs">实时探测失败，当前展示配置回退：{child.liveError}</div>
                                )}
                                <div className="skills-mcp-tools">
                                  {tools.map((tool) => (
                                    <div key={`${child.id}:${tool.name}`} className="skills-mcp-tool">
                                      <div className="skills-mcp-tool__label">工具名</div>
                                      <div className="skills-mcp-tool__name">{tool.name}</div>
                                      <div className="skills-mcp-tool__desc">{tool.description}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {item.recommendedSkills && item.recommendedSkills.length > 0 && (
                      <div className="skills-mcp-related">
                        关联技能：{item.recommendedSkills.join("、")}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}

function agentStatusTone(agent: ExternalAgentSummary): "ok" | "warn" | "neutral" {
  if (agent.routeReady) return "ok";
  if (agent.providerType || agent.adapterProtocol) return "warn";
  return "neutral";
}

function agentStatusLabel(agent: ExternalAgentSummary) {
  if (agent.routeReady) return "可调用";
  if (agent.reason) return "待配置";
  return "未接入";
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

function taskStatusTone(status: ExternalAgentTask["status"]): "ok" | "warn" | "danger" | "neutral" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "running" || status === "pending") return "warn";
  return "neutral";
}

function taskStatusLabel(status: ExternalAgentTask["status"]) {
  if (status === "succeeded") return "完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "running") return "执行中";
  return "排队中";
}

function AgentToolsPage({ adoptId }: { adoptId?: string }) {
  const [agents, setAgents] = useState<ExternalAgentSummary[]>([]);
  const [tasks, setTasks] = useState<ExternalAgentTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

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
      setLastCheckedAt(checkedAt);
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
        setLastCheckedAt(parsed?.lastCheckedAt || null);
      }
    } catch {}
    void loadAgents({ silent: hadCache });
  }, [adoptId]);

  useEffect(() => {
    setOpenIds((current) => {
      const validIds = new Set(agents.map((agent) => agent.id));
      return new Set([...current].filter((id) => validIds.has(id)));
    });
  }, [agents]);

  const toggle = (agentId: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const readyCount = agents.filter((agent) => agent.routeReady).length;
  const recentTaskByAgent = useMemo(() => {
    const map = new Map<string, ExternalAgentTask[]>();
    for (const task of tasks) {
      const bucket = map.get(task.agentId) || [];
      bucket.push(task);
      map.set(task.agentId, bucket);
    }
    return map;
  }, [tasks]);

  return (
    <div className="skills-market skills-agent">
      <div className="skills-header">
        <div className="skills-summary skills-muted-text text-xs">
          共 {agents.length} 个 Agent · {readyCount} 个可调用
          {lastCheckedAt ? ` · ${new Date(lastCheckedAt).toLocaleTimeString("zh-CN", { hour12: false })} 刷新` : ""}
        </div>
        <button className="skills-btn" onClick={() => void loadAgents()} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {loading && <div className="settings-card skills-market-empty"><RefreshCw size={18} className="animate-spin" /><div>正在加载 Agent...</div></div>}
      {!loading && agents.length === 0 && <div className="settings-card skills-market-empty"><Bot size={22} /><div>暂无可用 Agent</div></div>}

      {!loading && agents.length > 0 && (
        <div className="skills-mcp-groups">
          {agents.map((agent) => {
            const open = openIds.has(agent.id);
            const agentTasks = recentTaskByAgent.get(agent.id) || [];
            const agentTools = agentCapabilityTools(agent);
            return (
              <section key={agent.id} className="settings-card skills-mcp-group" data-open={open ? "true" : "false"}>
                <button
                  className="skills-mcp-group__head"
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(agent.id)}
                >
                  <span className="skills-mcp-group__chevron">
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                  <span className="skills-mcp-group__title-wrap">
                    <span className="skills-mcp-group__title">
                      <Bot size={16} />
                      <span>{agent.name}</span>
                    </span>
                    <span className="skills-mcp-group__desc">{agentDisplayDescription(agent)}</span>
                  </span>
                  <span className="skills-mcp-group__status">
                    <span className="skills-chip skills-mcp-scope skills-mcp-scope--platform">Agent</span>
                    <span className="skills-chip skills-mcp-scope skills-mcp-scope--internal">{agentModeLabel(agent)}</span>
                    <span className={`skills-chip ${pillToneClass(agentStatusTone(agent))}`}>
                      {agent.routeReady ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                      {agentStatusLabel(agent)}
                    </span>
                  </span>
                </button>

                <div className="skills-mcp-group__body" aria-hidden={!open}>
                  <div className="skills-mcp-flat">
                    <div className="skills-mcp-flat__head">
                      <span className="skills-mcp-child__main">
                        <span className="skills-mcp-child__name">调用方式</span>
                        <span className="skills-mcp-child__desc">
                          在主对话中发起任务，完成后结果会回写到原对话的任务卡片。
                        </span>
                      </span>
                      <span className="skills-mcp-flat__meta">
                        <span className={`skills-chip ${pillToneClass(agentStatusTone(agent))}`}>{agent.routeReady ? "路由就绪" : agent.reason || "待配置"}</span>
                      </span>
                    </div>

                    <div className="skills-mcp-tools">
                      {agentTools.slice(0, 8).map((tool) => (
                        <div key={`${agent.id}:${tool.name}`} className="skills-mcp-tool">
                          <div className="skills-mcp-tool__label">能力</div>
                          <div className="skills-mcp-tool__name">{tool.name}</div>
                          <div className="skills-mcp-tool__desc">{tool.description}</div>
                        </div>
                      ))}
                    </div>

                    <div className="skills-mcp-related">
                      最近任务：
                      {agentTasks.length === 0 ? " 暂无" : ""}
                    </div>
                    {agentTasks.length > 0 && (
                      <div className="skills-mcp-tools">
                        {agentTasks.slice(0, 4).map((task) => (
                          <div key={task.id} className="skills-mcp-tool">
                            <div className="skills-mcp-tool__label">{task.createdAt ? new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false }) : task.id}</div>
                            <div className="skills-mcp-tool__name">{task.input.slice(0, 48)}{task.input.length > 48 ? "..." : ""}</div>
                            <div className="skills-mcp-tool__desc">
                              <span className={`skills-chip ${pillToneClass(taskStatusTone(task.status))}`}>{taskStatusLabel(task.status)}</span>
                              {task.errorMessage ? ` ${task.errorMessage}` : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkillsToolbar({
  q,
  setQ,
  source,
  setSource,
  state,
  setState,
}: {
  q: string;
  setQ: (v: string) => void;
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
    <div className="skills-toolbar">
      <div className="skills-search">
        <Search size={14} className="skills-search-icon" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索技能名称、说明或来源" />
      </div>
      <div className="skills-tabs" aria-label="技能来源筛选">
        {sourceFilters.map((item) => (
          <button key={item.key} className={`skills-tab ${source === item.key ? "active" : ""}`} onClick={() => setSource(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="skills-tabs" aria-label="技能状态筛选">
        {stateFilters.map((item) => (
          <button key={item.key} className={`skills-tab ${state === item.key ? "active" : ""}`} onClick={() => setState(item.key)}>
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
  const tone = stateTone(skill.state);
  const canToggle = sourceCanToggle(skill);
  return (
    <div className="skills-row">
      <div className="skills-row-main" onClick={onOpen}>
        <div className="skills-icon">{skillIcon(skill)}</div>
        <div className="min-w-0">
          <div className="skills-name">{displayNameOf(skill)}</div>
          <div className="skills-desc">{descriptionOf(skill)}</div>
          <div className="skills-badges">
            <SkillPill>{sourceIcon(skill.source.kind)} {SOURCE_LABEL[skill.source.kind]}</SkillPill>
            <SkillPill tone={tone}>{STATE_LABEL[skill.state]}</SkillPill>
            {skill.review.state !== "none" && <SkillPill tone={skill.review.state === "failed" ? "danger" : "warn"}>审核：{skill.review.state}</SkillPill>}
          </div>
          {["sync_failed", "source_missing", "review_failed"].includes(skill.state) && (
            <div className="skills-danger-text text-xs mt-1">
              {reasonOf(skill) || "需要处理后才能使用"}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          className={`skills-switch ${skill.enabled ? "is-on" : "is-off"}`}
          disabled={busy || !canToggle}
          onClick={() => canToggle && onToggle(!skill.enabled)}
          aria-label={canToggle ? (skill.enabled ? "停用技能" : "启用技能") : "技能当前不可切换"}
          title={canToggle ? undefined : "技能当前不可切换"}
        >
          <span className={`skills-switch-dot ${skill.enabled ? "on" : ""}`} />
        </button>
        <button className="skills-btn" onClick={onOpen}>详情</button>
      </div>
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

export function SkillsPage({ adoptId, onChanged }: {
  skills?: { shared: any[]; system: any[]; private: any[] } | null | undefined;
  canEdit?: boolean;
  pending?: boolean;
  onToggle?: (skillId: string, enable: boolean, source: "shared" | "system") => void;
  adoptId?: string;
  onChanged?: () => void | Promise<void>;
}) {
  const { confirm, dialog } = useConfirmDialog();
  const [skillTab, setSkillTab] = useState<SkillTab>(() => cachedSkillTab());
  const [items, setItems] = useState<RegistrySkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RegistrySkill | null>(null);
  const [q, setQ] = useState("");
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

  const counts = useMemo(() => {
    return {
      total: items.length,
      attention: items.filter((x) => ["sync_failed", "source_missing", "review_pending", "reviewing", "review_failed"].includes(x.state)).length,
      ready: items.filter((x) => x.state === "ready").length,
    };
  }, [items]);

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
      const inspect = await fetchSkillPackageBinary<SkillPackageInspectResponse>("/api/claw/skill-package/inspect", file, {
        adoptId,
        filename: file.name,
      });
      const defaultName = inspect.skill.displayName || inspect.skill.skillId || file.name.replace(/\.(zip|skill)$/i, "");
      const displayName = prompt("技能名称", defaultName)?.trim();
      if (!displayName) return;
      if (displayName.length < 2) {
        toast.error("技能名称至少 2 个字");
        return;
      }
      const description = prompt("技能说明", inspect.skill.description || "")?.trim() || inspect.skill.description || "";
      await fetchSkillPackageBinary("/api/claw/skill-package/upload", file, {
        adoptId,
        filename: file.name,
        displayName,
        description,
      });
      if (inspect.skill.warnings?.length) {
        toast.warning(`技能已上传，静态扫描提示 ${inspect.skill.warnings.length} 项，请在详情中确认。`);
      } else {
        toast.success("技能已上传并同步到运行环境");
      }
      setSourceFilter("uploaded");
      await load();
      await onChanged?.();
    } catch (e: any) {
      toast.error(e?.message || "上传失败");
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  return (
    <PageContainer title="技能">
      {dialog}
      <div className="skills-page">
        <div className="page-tabs" role="tablist" aria-label="技能分区" onKeyDown={(e) => handleRovingTabKey(e, SKILL_TAB_KEYS, skillTab, setSkillTab)}>
          <button id="skills-tab-mine" className="page-tab" data-active={skillTab === "mine" ? "true" : "false"} role="tab" aria-selected={skillTab === "mine"} aria-controls="skills-panel-mine" tabIndex={skillTab === "mine" ? 0 : -1} onClick={() => setSkillTab("mine")}>
            <Package className="page-tab__icon" aria-hidden="true" />
            我的技能
          </button>
          <button id="skills-tab-market" className="page-tab" data-active={skillTab === "market" ? "true" : "false"} role="tab" aria-selected={skillTab === "market"} aria-controls="skills-panel-market" tabIndex={skillTab === "market" ? 0 : -1} onClick={() => setSkillTab("market")}>
            <Store className="page-tab__icon" aria-hidden="true" />
            技能广场
          </button>
          <button id="skills-tab-mcp" className="page-tab" data-active={skillTab === "mcp" ? "true" : "false"} role="tab" aria-selected={skillTab === "mcp"} aria-controls="skills-panel-mcp" tabIndex={skillTab === "mcp" ? 0 : -1} onClick={() => setSkillTab("mcp")}>
            <Wrench className="page-tab__icon" aria-hidden="true" />
            MCP工具
          </button>
          <button id="skills-tab-agent" className="page-tab" data-active={skillTab === "agent" ? "true" : "false"} role="tab" aria-selected={skillTab === "agent"} aria-controls="skills-panel-agent" tabIndex={skillTab === "agent" ? 0 : -1} onClick={() => setSkillTab("agent")}>
            <Bot className="page-tab__icon" aria-hidden="true" />
            Agent
          </button>
        </div>

        {skillTab === "market" && (
          <div id="skills-panel-market" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-market" tabIndex={0}>
            <MarketplacePage adoptId={adoptId} onChanged={onChanged} />
          </div>
        )}

        {skillTab === "mcp" && (
          <div id="skills-panel-mcp" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-mcp" tabIndex={0}>
            <McpToolsPage adoptId={adoptId} />
          </div>
        )}

        {skillTab === "agent" && (
          <div id="skills-panel-agent" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-agent" tabIndex={0}>
            <AgentToolsPage adoptId={adoptId} />
          </div>
        )}

        {skillTab === "mine" && (
          <div id="skills-panel-mine" className="skills-panel stealth-scrollbar" role="tabpanel" aria-labelledby="skills-tab-mine" tabIndex={0}>
            <div className="skills-header">
              <div className="skills-summary skills-muted-text text-xs">
                共 {counts.total} 个技能 · {counts.ready} 个可用 · {counts.attention} 个需处理
              </div>
              <div className="flex items-center gap-2">
                <button className="skills-btn" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> 刷新</button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".zip,.skill"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void onUploadFile(file);
                  }}
                />
                <button className="skills-btn" disabled={uploading} onClick={() => uploadInputRef.current?.click()}>
                  <Upload size={13} /> {uploading ? "上传中..." : "上传技能"}
                </button>
              </div>
            </div>
            <SkillsToolbar q={q} setQ={setQ} source={sourceFilter} setSource={setSourceFilter} state={stateFilter} setState={setStateFilter} />

            <div className="skills-list">
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
