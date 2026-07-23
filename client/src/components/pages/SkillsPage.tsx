import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileText,
  HardDrive,
  Layers,
  LibraryBig,
  Package,
  Palette,
  Pencil,
  Plug,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
  Upload,
  UsersRound,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import type { CustomMcpTemplate } from "@/components/CustomMcpDialog";
import { ExpertAvatar } from "@/components/ExpertAvatar";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { PageContainer } from "@/components/console/PageContainer";
import { useChannelBinding } from "@/hooks/useChannelBinding";
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
type SkillTab = (typeof SKILL_TAB_KEYS)[number];
type SkillsPageSection = "skills" | "experts" | "connectors";
type CatalogView = "market" | "mine";
type SourceFilter = "all" | SourceKind;
type StateFilter = "all" | "ready" | "attention" | "disabled";
const SKILL_TAB_CACHE_KEY = "employee-agent:skills:last-tab";
const MCP_TOOLS_CACHE_PREFIX = "employee-agent:mcp-tools:v4:";
const AGENT_TOOLS_CACHE_PREFIX = "employee-agent:agent-tools:v5:";

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
  catalogId?: string | null;
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
  catalogId?: string | null;
};

type FeishuConnectorCapability = {
  configured: boolean;
  bound: boolean;
  routeReady: boolean;
  bindMode?: "code" | "personal_oauth" | string;
  targetLabel?: string;
  boundAt?: string;
  reason?: string | null;
  capabilities?: {
    inbound?: boolean;
    outbound?: boolean;
    dm?: boolean;
    scheduleDelivery?: boolean;
    coopNotify?: boolean;
  };
};

type ChannelCapabilitiesResponse = {
  channels?: {
    feishu?: FeishuConnectorCapability;
  };
};

const FEISHU_CONNECTOR_ID = "platform:feishu";
const FEISHU_CONNECTOR_TOOLS: McpToolSummary[] = [
  { name: "feishu_conversation", description: "在飞书私聊中与当前岗位智能体双向对话" },
  { name: "feishu_delivery", description: "将任务结果和主动消息投递到已绑定的飞书账号" },
  { name: "feishu_schedule", description: "接收定时任务的执行结果与提醒" },
  { name: "feishu_collaboration", description: "接收协作邀请、进度变化和完成通知" },
];

type ConnectorCatalogTemplate = {
  id: string;
  name: string;
  description: string;
  capabilities: [string, string, string];
  category: ConnectorCatalogCategory;
  availability: "direct" | "oauth" | "partner" | "preview";
  requirement: string;
  docsUrl?: string;
  binding?: CustomMcpTemplate;
  oauthCatalogId?: string;
};

type ConnectorCatalogCardEntry =
  | { kind: "template"; key: string; connected: boolean; position: number; template: ConnectorCatalogTemplate }
  | { kind: "connector"; key: string; connected: boolean; position: number; connector: McpConnectorCard }
  | { kind: "feishu"; key: string; connected: boolean; position: number };

type ConnectorCatalogCategory = "business-data" | "knowledge-creation" | "development-collaboration" | "consumer-services";

const CONNECTOR_CATALOG_CATEGORIES: Array<{ id: ConnectorCatalogCategory; label: string }> = [
  { id: "business-data", label: "业务数据" },
  { id: "knowledge-creation", label: "知识创作" },
  { id: "development-collaboration", label: "研发协作" },
  { id: "consumer-services", label: "生活服务" },
];

const CONNECTOR_CATALOG_TEMPLATES: ConnectorCatalogTemplate[] = [
  {
    id: "yingmi",
    name: "盈米 · 且慢",
    description: "连接基金与家庭财富数据，支持资产分析、基金研究和组合诊断。",
    capabilities: ["基金数据", "家庭财务", "组合分析"],
    category: "business-data",
    availability: "direct",
    requirement: "使用者填写自己的盈米 API Key。",
    docsUrl: "https://yingmi.feishu.cn/docx/PRPRds5SBo2MITxHJL2cMPminEf",
    binding: { id: "yingmi", displayName: "盈米 · 且慢", endpointUrl: "https://stargate.yingmi.com/mcp/v2", authType: "api_key", authHeaderName: "X-API-Key" },
  },
  {
    id: "github",
    name: "GitHub",
    description: "查询代码仓、Issue 和 Pull Request，让研发协作信息进入岗位对话。",
    capabilities: ["代码仓库", "Issue", "Pull Request"],
    category: "development-collaboration",
    availability: "direct",
    requirement: "使用者填写自己的 GitHub Personal Access Token。",
    binding: { id: "github", displayName: "GitHub", endpointUrl: "https://api.githubcopilot.com/mcp/", authType: "bearer" },
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    description: "检索微软官方技术文档、代码示例和产品说明，无需单独账号授权。",
    capabilities: ["技术文档", "代码示例", "产品说明"],
    category: "knowledge-creation",
    availability: "direct",
    requirement: "无需凭据，可直接测试并绑定。",
    binding: { id: "microsoft-learn", displayName: "Microsoft Learn", endpointUrl: "https://learn.microsoft.com/api/mcp", authType: "none" },
  },
  {
    id: "jinshuju",
    name: "金数据",
    description: "用自然语言管理表单、查询提交数据并连接运营工作流。",
    capabilities: ["表单管理", "数据查询", "流程触发"],
    category: "business-data",
    availability: "oauth",
    requirement: "点击授权后登录金数据；凭据由平台加密保存，并仅供当前岗位智能体使用。",
    oauthCatalogId: "jinshuju",
  },
  {
    id: "hengshengjuyuan",
    name: "恒生聚源",
    description: "连接专业金融数据与研究资讯，支持行情、公司资料和公告研报检索。",
    capabilities: ["行情数据", "公司资料", "公告研报"],
    category: "business-data",
    availability: "direct",
    requirement: "使用者向恒生聚源申请自己的 JY_API_KEY；平台会加密保存，不会写入连接地址。",
    docsUrl: "https://vcn7e7nesi3s.feishu.cn/docx/MeCmd4q0Yo7nmkx9D8IcMYbknob",
    binding: {
      id: "hengshengjuyuan",
      displayName: "恒生聚源",
      endpointUrl: "https://api.gildata.com/mcp-servers/aidata-assistant-srv-tool",
      authType: "query_api_key",
      authHeaderName: "token",
    },
  },
  {
    id: "tianyancha",
    name: "天眼查",
    description: "连接企业工商、司法风险、知识产权与经营信息，辅助尽调和客户核验。",
    capabilities: ["企业工商", "司法风险", "知识产权"],
    category: "business-data",
    availability: "direct",
    requirement: "使用者在天眼 AI 智能体数据平台注册并获取自己的 API Key。",
    docsUrl: "https://ai.tianyancha.com/guide",
    binding: {
      id: "tianyancha",
      displayName: "天眼查",
      endpointUrl: "https://mcp.tianyancha.com/v1",
      authType: "bearer",
    },
  },
  {
    id: "canva",
    name: "Canva 可画",
    description: "生成、编辑和导出设计，连接品牌素材、模板与协作评论。",
    capabilities: ["设计生成", "素材管理", "多格式导出"],
    category: "knowledge-creation",
    availability: "oauth",
    requirement: "点击授权后登录 Canva；每位用户只会访问自己有权限的设计、素材和品牌内容。",
    oauthCatalogId: "canva",
  },
  {
    id: "notion",
    name: "Notion",
    description: "搜索和维护知识页面、项目资料、任务与团队工作记录。",
    capabilities: ["知识检索", "页面编辑", "任务管理"],
    category: "knowledge-creation",
    availability: "oauth",
    requirement: "点击授权后登录 Notion，并选择允许当前岗位智能体访问的工作区内容。",
    oauthCatalogId: "notion",
  },
  {
    id: "atlassian",
    name: "Jira · Confluence",
    description: "连接研发事项与企业知识，查询并更新 Jira、Confluence 内容。",
    capabilities: ["事项管理", "知识检索", "协作更新"],
    category: "development-collaboration",
    availability: "oauth",
    requirement: "点击授权后登录 Atlassian，并选择允许访问的 Jira、Confluence 站点。",
    oauthCatalogId: "atlassian",
  },
  {
    id: "slack",
    name: "Slack",
    description: "搜索频道和文件、发送消息，并让团队协作上下文进入智能体。",
    capabilities: ["消息检索", "频道协作", "内容发送"],
    category: "development-collaboration",
    availability: "oauth",
    requirement: "需要企业注册并审批 Slack App，然后由用户授权。",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "查找和读取云端文件，为资料整理、问答和内容创作提供上下文。",
    capabilities: ["文件检索", "内容读取", "云端资料"],
    category: "knowledge-creation",
    availability: "preview",
    requirement: "Google Drive MCP 当前处于开发者预览阶段。",
  },
  {
    id: "tongzhou",
    name: "同舟金融研究",
    description: "面向金融研究流程提供资料检索、证据整理和研究交付能力。",
    capabilities: ["金融研究", "证据整理", "报告交付"],
    category: "business-data",
    availability: "partner",
    requirement: "需要服务商提供通用 MCP Gateway 与授权方案。",
  },
  {
    id: "yunzhangfang",
    name: "云账房 AI 开票",
    description: "连接企业开票场景，辅助抬头校验、开票申请和结果查询。",
    capabilities: ["抬头校验", "开票申请", "结果查询"],
    category: "business-data",
    availability: "oauth",
    requirement: "点击授权后使用云账房手机号和短信验证码登录；开票等写操作仍需用户确认。",
    oauthCatalogId: "yunzhangfang",
  },
  {
    id: "mcdonalds",
    name: "麦当劳",
    description: "查询餐品营养、门店与优惠信息，并连接会员积分、领券和点餐服务。",
    capabilities: ["餐品门店", "优惠积分", "点餐配送"],
    category: "consumer-services",
    availability: "direct",
    requirement: "使用者登录麦当劳 MCP 平台申请自己的 MCP Token；涉及地址、兑换和下单时请核对关键信息。",
    docsUrl: "https://open.mcd.cn/mcp/doc",
    binding: {
      id: "mcdonalds",
      displayName: "麦当劳",
      endpointUrl: "https://mcp.mcd.cn",
      authType: "bearer",
    },
  },
];

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
  usageCount?: number;
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

function formatConnectionExpiry(value: string): string {
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) && numeric > 0 ? numeric : value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
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

function initialSkillTab(section: SkillsPageSection): SkillTab {
  if (section === "experts") return "agent";
  if (section === "connectors") return "mcp";
  const cached = cachedSkillTab();
  return cached === "market" ? "market" : "mine";
}

function mcpToolsCacheKey(adoptId?: string) {
  return `${MCP_TOOLS_CACHE_PREFIX}${adoptId || "none"}`;
}

function agentToolsCacheKey(adoptId?: string) {
  return `${AGENT_TOOLS_CACHE_PREFIX}${adoptId || "none"}`;
}

function connectorTemplateIcon(templateId: string): ReactNode {
  const squareLogo = {
    yingmi: "/images/connectors/yingmi-logo.png",
    github: "/images/connectors/github-logo.png",
    jinshuju: "/images/connectors/jinshuju-logo.png",
    hengshengjuyuan: "/images/connectors/hengshengjuyuan-logo.png",
    mcdonalds: "/images/connectors/mcdonalds-logo.png",
  }[templateId];
  if (squareLogo) {
    return <img className="skills-provider-icon--square" src={squareLogo} alt="" aria-hidden="true" />;
  }
  if (templateId === "yunzhangfang") {
    return <img src="/images/connectors/yunzhangfang-logo.png" alt="" aria-hidden="true" />;
  }
  if (templateId === "tianyancha") {
    return <img className="skills-provider-icon--wide" src="/images/connectors/tianyancha-logo.svg" alt="" aria-hidden="true" />;
  }
  if (templateId === "microsoft-learn") return <BookOpen aria-hidden="true" />;
  if (templateId === "canva") return <Palette aria-hidden="true" />;
  if (templateId === "notion") return <Layers aria-hidden="true" />;
  if (templateId === "atlassian") return <BriefcaseBusiness aria-hidden="true" />;
  if (templateId === "slack") return <UsersRound aria-hidden="true" />;
  if (templateId === "google-drive") return <HardDrive aria-hidden="true" />;
  if (templateId === "tongzhou") return <LibraryBig aria-hidden="true" />;
  return <Plug aria-hidden="true" />;
}

function connectorTemplateStatus(template: ConnectorCatalogTemplate, connected = false) {
  if (connected) return { label: "已连接", health: "ready" as const };
  if (template.availability === "direct") return { label: "可绑定", health: "ready" as const };
  if (template.availability === "oauth") return { label: "需授权", health: "degraded" as const };
  if (template.availability === "preview") return { label: "预览中", health: "degraded" as const };
  return { label: "合作接入", health: "offline" as const };
}

function connectorCapabilityLabels(connector: McpConnectorCard): string[] {
  const id = connector.serverId.toLocaleLowerCase();
  if (id.includes("wealth_assistant_customer") || id.includes("wealth_customer")) {
    return ["客户列表", "客户画像", "持仓资产"];
  }
  if (id.includes("wealth_assistant_product") || id.includes("wealth_product")) {
    return ["产品检索", "产品详情", "市场资讯"];
  }
  if (id.includes("wind_financial_docs")) {
    return ["公司公告", "财经新闻", "资料检索"];
  }
  if (id.includes("wind_stock_data")) {
    return ["A股行情", "公司财务", "风险指标"];
  }
  if (id.includes("wind_global_stock_data")) {
    return ["港股行情", "美股行情", "公司基本面"];
  }
  if (id.includes("wind_fund_data")) {
    return ["基金行情", "基金持仓", "基金业绩"];
  }
  if (id.includes("wind_index_data")) {
    return ["指数行情", "行业板块", "估值指标"];
  }
  if (id.includes("wind_bond_data")) {
    return ["债券档案", "行情估值", "主体财务"];
  }
  if (id.includes("wind_economic_data")) {
    return ["宏观指标", "行业指标", "经济序列"];
  }
  if (id.includes("wind_analytics_data")) {
    return ["综合取数", "跨域查询", "自然语言检索"];
  }
  const toolNames = connector.tools.map((tool) => String(tool.name || "").trim()).filter(Boolean);
  return Array.from(new Set([...toolNames, connector.category, "业务连接", "对话可用"])).slice(0, 3);
}

function connectorCatalogCategory(connector: McpConnectorCard): ConnectorCatalogCategory {
  const searchable = `${connector.serverId} ${connector.name} ${connector.category} ${connector.description}`.toLocaleLowerCase();
  if (/mcd|麦当劳|餐品|门店|点餐|优惠券|会员积分|生活服务/.test(searchable)) {
    return "consumer-services";
  }
  if (/wind|wealth|customer|product|stock|index|bond|fund|risk|insurance|finance|金融|财富|客户|产品|行情|债券|基金|风控|保险|数据/.test(searchable)) {
    return "business-data";
  }
  if (/knowledge|document|docs|file|search|notion|drive|learn|知识|文档|文件|检索|创作/.test(searchable)) {
    return "knowledge-creation";
  }
  return "development-collaboration";
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
        catalogId: child.catalogId || null,
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
  view,
  onAddMcp,
  onTryMcp,
  onConnectionsChanged,
}: {
  adoptId?: string;
  query: string;
  view: CatalogView;
  onAddMcp?: (template?: CustomMcpTemplate) => void;
  onTryMcp?: () => void;
  onConnectionsChanged?: () => void | Promise<void>;
}) {
  const feishuBinding = useChannelBinding("feishu", adoptId);
  const [items, setItems] = useState<McpToolGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<ConnectorCatalogCategory>("business-data");
  const [detailServerId, setDetailServerId] = useState<string | null>(null);
  const [detailTemplateId, setDetailTemplateId] = useState<string | null>(null);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);
  const [feishuCapability, setFeishuCapability] = useState<FeishuConnectorCapability | null>(null);
  const [feishuStatusLoading, setFeishuStatusLoading] = useState(false);
  const [feishuStatusError, setFeishuStatusError] = useState(false);
  const [feishuAction, setFeishuAction] = useState<"connect" | "unbind" | null>(null);
  const [feishuQrDataUrl, setFeishuQrDataUrl] = useState("");
  const [feishuBindCode, setFeishuBindCode] = useState("");
  const [feishuBindInstruction, setFeishuBindInstruction] = useState("");
  const [feishuBindExpiresAt, setFeishuBindExpiresAt] = useState("");
  const [oauthAction, setOauthAction] = useState<string | null>(null);
  const oauthPopupWatcherRef = useRef<number | null>(null);

  const loadFeishuCapability = async (silent = false) => {
    if (!adoptId) {
      setFeishuCapability(null);
      setFeishuStatusError(false);
      return;
    }
    if (!silent) setFeishuStatusLoading(true);
    try {
      const data = await fetchJson<ChannelCapabilitiesResponse>(
        `/api/claw/channels/capabilities?adoptId=${encodeURIComponent(adoptId)}`,
      );
      const capability = data.channels?.feishu || null;
      setFeishuCapability(capability);
      setFeishuStatusError(false);
      if (capability?.bound) {
        setFeishuBindCode("");
        setFeishuBindInstruction("");
        setFeishuBindExpiresAt("");
      }
    } catch {
      setFeishuCapability(null);
      setFeishuStatusError(true);
    } finally {
      if (!silent) setFeishuStatusLoading(false);
    }
  };

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
      setFeishuCapability(null);
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
    void loadFeishuCapability();
  }, [adoptId]);

  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "employee-agent:mcp-oauth") return;
      if (oauthPopupWatcherRef.current !== null) window.clearInterval(oauthPopupWatcherRef.current);
      oauthPopupWatcherRef.current = null;
      setOauthAction(null);
      if (event.data.status === "success") {
        toast.success(String(event.data.message || "连接器授权成功"));
        void loadMcpTools({ force: true });
        void onConnectionsChanged?.();
      } else {
        toast.error(String(event.data.message || "连接器授权失败"));
      }
    };
    window.addEventListener("message", handleOAuthMessage);
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      if (oauthPopupWatcherRef.current !== null) window.clearInterval(oauthPopupWatcherRef.current);
      oauthPopupWatcherRef.current = null;
    };
  }, [adoptId]);

  useEffect(() => {
    if (!adoptId || !feishuBindCode || feishuCapability?.bound) return;
    const timer = window.setInterval(() => void loadFeishuCapability(true), 2500);
    return () => window.clearInterval(timer);
  }, [adoptId, feishuBindCode, feishuCapability?.bound]);

  useEffect(() => {
    if (feishuBinding.status === "bound") void loadFeishuCapability(true);
  }, [feishuBinding.status]);

  useEffect(() => {
    if (!feishuBinding.qrCode) {
      setFeishuQrDataUrl("");
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(feishuBinding.qrCode, { width: 184, margin: 1 })
      .then((dataUrl) => { if (!cancelled) setFeishuQrDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setFeishuQrDataUrl(""); });
    return () => { cancelled = true; };
  }, [feishuBinding.qrCode]);

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
  const templateConnectionById = useMemo(() => {
    const matches = new Map<string, McpConnectorCard>();
    for (const template of CONNECTOR_CATALOG_TEMPLATES) {
      const catalogId = template.oauthCatalogId || template.binding?.catalogId || template.binding?.id || template.id;
      const connection = connectors.find((connector) => (
        connector.catalogId === catalogId
        || (template.binding && connector.name === template.binding.displayName)
      ));
      if (connection) matches.set(template.id, connection);
    }
    return matches;
  }, [connectors]);
  const scopedConnectors = useMemo(
    () => connectors.filter((connector) => view === "mine" ? connector.source === "personal" : connector.source !== "personal"),
    [connectors, view],
  );
  const feishuConnected = Boolean(feishuCapability?.routeReady) || feishuBinding.status === "bound";
  const feishuSharedAppConfigured = feishuCapability?.bindMode === "code" && Boolean(feishuCapability.configured);
  const feishuConnecting = feishuBinding.status === "loading" || feishuBinding.status === "scanning";
  const feishuHealth: McpConnectorHealth = feishuConnected
    ? "ready"
    : feishuStatusError
      ? "offline"
      : feishuStatusLoading || feishuConnecting
        ? "degraded"
        : "idle";
  const feishuStatusLabel = feishuConnected
    ? "已连接"
    : feishuBinding.status === "scanning"
      ? "等待确认"
      : feishuStatusLoading || feishuBinding.status === "loading"
      ? "检查中"
      : feishuStatusError
        ? "状态异常"
        : "未连接";
  const feishuSelected = detailServerId === FEISHU_CONNECTOR_ID;
  const selectedConnector = useMemo(
    () => connectors.find((connector) => connector.serverId === detailServerId) || null,
    [connectors, detailServerId],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const feishuMatchesQuery = !normalizedQuery || [
    "飞书",
    "消息 协作 私聊 对话 定时任务 通知 投递",
    ...FEISHU_CONNECTOR_TOOLS.map((tool) => `${tool.name} ${tool.description}`),
  ].join(" ").toLocaleLowerCase().includes(normalizedQuery);
  const showFeishuConnector = view === "market"
    && selectedCategory === "development-collaboration"
    && feishuMatchesQuery;
  const filteredConnectors = useMemo(() => {
    return scopedConnectors.filter((connector) => {
      if (connectorCatalogCategory(connector) !== selectedCategory) return false;
      if (!normalizedQuery) return true;
      return `${connector.name} ${connector.description} ${connector.category} ${connector.tools.map((tool) => `${tool.name} ${tool.description}`).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [scopedConnectors, selectedCategory, normalizedQuery]);
  const filteredTemplates = useMemo(() => {
    if (view !== "market") return [];
    return CONNECTOR_CATALOG_TEMPLATES.filter((template) => {
      if (template.category !== selectedCategory) return false;
      if (!normalizedQuery) return true;
      return `${template.name} ${template.description} ${template.capabilities.join(" ")}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [normalizedQuery, selectedCategory, view]);
  const connectorCatalogGroups = useMemo(() => {
    const cards: ConnectorCatalogCardEntry[] = [
      ...filteredTemplates.map((template, index) => ({
        kind: "template" as const,
        key: `catalog:${template.id}`,
        connected: Boolean(
          templateConnectionById.get(template.id)?.connected
          && templateConnectionById.get(template.id)?.health === "ready",
        ),
        position: index,
        template,
      })),
      ...(showFeishuConnector ? [{
        kind: "feishu" as const,
        key: FEISHU_CONNECTOR_ID,
        connected: feishuConnected && feishuHealth === "ready",
        position: filteredTemplates.length,
      }] : []),
      ...filteredConnectors.map((connector, index) => ({
        kind: "connector" as const,
        key: connector.id,
        connected: connector.connected && connector.health === "ready",
        position: filteredTemplates.length + 1 + index,
        connector,
      })),
    ].sort((a, b) => Number(b.connected) - Number(a.connected) || a.position - b.position);
    const group = {
      id: selectedCategory,
      label: "",
      cards,
    };
    return group.cards.length > 0 ? [group] : [];
  }, [feishuConnected, feishuHealth, filteredConnectors, filteredTemplates, selectedCategory, showFeishuConnector, templateConnectionById]);
  const selectedTemplate = useMemo(
    () => CONNECTOR_CATALOG_TEMPLATES.find((template) => template.id === detailTemplateId) || null,
    [detailTemplateId],
  );
  const selectedTemplateConnection = selectedTemplate
    ? templateConnectionById.get(selectedTemplate.id) || null
    : null;
  const selectedTemplateConnected = Boolean(selectedTemplateConnection?.connected);

  useEffect(() => {
    if (detailServerId && !selectedConnector && !feishuSelected) setDetailServerId(null);
  }, [detailServerId, selectedConnector, feishuSelected]);

  useEffect(() => {
    setDetailServerId(null);
    setDetailTemplateId(null);
  }, [view]);

  const beginFeishuConnection = async () => {
    if (!adoptId || feishuAction) return;
    setFeishuAction("connect");
    try {
      if (!feishuSharedAppConfigured) {
        await feishuBinding.startBind();
        return;
      }
      const result = await fetchJson<{ code?: string; instruction?: string; expiresAt?: string }>(
        "/api/claw/feishu/bidirectional/begin",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId }),
        },
      );
      setFeishuBindCode(String(result.code || ""));
      setFeishuBindInstruction(String(result.instruction || ""));
      setFeishuBindExpiresAt(String(result.expiresAt || ""));
      await loadFeishuCapability(true);
    } catch (error: any) {
      toast.error(error?.message || "获取飞书绑定码失败");
    } finally {
      setFeishuAction(null);
    }
  };

  const beginOAuthConnection = async (template: ConnectorCatalogTemplate) => {
    if (!adoptId || !template.oauthCatalogId || oauthAction) return;
    const popup = window.open("about:blank", "employee-agent-mcp-oauth", "popup=yes,width=720,height=760");
    if (!popup) {
      toast.error("浏览器阻止了授权窗口，请允许弹窗后重试");
      return;
    }
    popup.document.title = "正在准备授权";
    setOauthAction(template.id);
    if (oauthPopupWatcherRef.current !== null) window.clearInterval(oauthPopupWatcherRef.current);
    oauthPopupWatcherRef.current = window.setInterval(() => {
      if (!popup.closed) return;
      if (oauthPopupWatcherRef.current !== null) window.clearInterval(oauthPopupWatcherRef.current);
      oauthPopupWatcherRef.current = null;
      setOauthAction(null);
    }, 500);
    try {
      const result = await fetchJson<{ authorizationUrl: string }>("/api/claw/custom-mcp/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId, catalogId: template.oauthCatalogId }),
      });
      popup.location.replace(result.authorizationUrl);
    } catch (error: any) {
      popup.close();
      if (oauthPopupWatcherRef.current !== null) window.clearInterval(oauthPopupWatcherRef.current);
      oauthPopupWatcherRef.current = null;
      setOauthAction(null);
      toast.error(error?.message || "发起连接器授权失败");
    }
  };

  const testFeishuConnection = async () => {
    if (!adoptId || feishuAction || !feishuConnected) return;
    await feishuBinding.test();
  };

  const unbindFeishuConnection = async () => {
    if (!adoptId || feishuAction || !feishuConnected) return;
    setFeishuAction("unbind");
    try {
      await feishuBinding.unbind();
      setFeishuBindCode("");
      setFeishuBindInstruction("");
      setFeishuBindExpiresAt("");
      await loadFeishuCapability(true);
    } catch (error: any) {
      toast.error(error?.message || "飞书解绑失败");
    } finally {
      setFeishuAction(null);
    }
  };

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

  const categoryItems = CONNECTOR_CATALOG_CATEGORIES.map((category) => ({
    ...category,
    count: scopedConnectors.filter((connector) => connectorCatalogCategory(connector) === category.id).length
      + (view === "market" ? CONNECTOR_CATALOG_TEMPLATES.filter((template) => template.category === category.id).length : 0)
      + Number(view === "market" && category.id === "development-collaboration"),
  }));

  return (
    <div className="skills-market skills-mcp">
      <div className="skills-section-filterbar">
        <div className="skills-mcp-filters" role="tablist" aria-label="连接器分类">
          {categoryItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selectedCategory === item.id}
              className="skills-mcp-filter"
              data-active={selectedCategory === item.id ? "true" : "false"}
              onClick={() => setSelectedCategory(item.id)}
            >
              {item.label}<span>{item.count}</span>
            </button>
          ))}
        </div>
      </div>

      {loading && filteredTemplates.length === 0 && !showFeishuConnector && scopedConnectors.length === 0 && <div className="settings-card skills-market-empty"><RefreshCw size={18} className="animate-spin" /><div>正在加载连接...</div></div>}
      {!loading && filteredTemplates.length === 0 && !showFeishuConnector && filteredConnectors.length === 0 && <div className="settings-card skills-market-empty"><Search size={22} /><div>{view === "mine" && scopedConnectors.length === 0 ? "还没有个人连接" : "没有匹配的连接"}</div></div>}

      {connectorCatalogGroups.length > 0 && (
        <div className="skills-connector-sections">
          {connectorCatalogGroups.map((group) => {
            const count = group.cards.length;
            return (
              <section key={group.id} className="skills-connector-section" aria-labelledby={group.label ? `connector-category-${group.id}` : undefined}>
                {group.label ? (
                  <div className="skills-connector-section__head">
                    <h3 id={`connector-category-${group.id}`}>{group.label}</h3>
                    <span>{count} 个连接器</span>
                  </div>
                ) : null}
                <div className="skills-mcp-grid">
                  {group.cards.map((entry) => {
                    if (entry.kind === "template") {
                      const { template, connected } = entry;
                      return (
                      <article key={entry.key} className="skills-mcp-card-v2 skills-catalog-card skills-action-card" data-connected={connected ? "true" : "false"}>
                        <button className="skills-catalog-card__surface" type="button" onClick={() => setDetailTemplateId(template.id)}>
                          <span className="skills-catalog-card__head">
                            <span className="skills-catalog-card__icon skills-mcp-card-v2__icon" data-source={template.availability === "direct" ? "public" : "optional"}>
                              {connectorTemplateIcon(template.id)}
                            </span>
                            <span className="skills-catalog-card__title-wrap">
                              <span className="skills-catalog-card__title">{template.name}</span>
                              <span className="skills-catalog-card__meta">预置连接器</span>
                            </span>
                            {connected ? (
                              <span className="skills-mcp-card-v2__status" data-health="ready">
                                <span aria-hidden="true" />已连接
                              </span>
                            ) : null}
                          </span>
                          <span className="skills-catalog-card__desc">{template.description}</span>
                          <span className="skills-catalog-card__capabilities" aria-label="连接能力">
                            {template.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
                          </span>
                        </button>
                      </article>
                      );
                    }
                    if (entry.kind === "feishu") return (
                    <article key={entry.key} className="skills-mcp-card-v2 skills-catalog-card skills-action-card" data-connected={feishuConnected ? "true" : "false"}>
                      <button className="skills-catalog-card__surface" type="button" onClick={() => setDetailServerId(FEISHU_CONNECTOR_ID)}>
                        <span className="skills-catalog-card__head">
                          <span className="skills-catalog-card__icon skills-mcp-card-v2__icon" data-source="preset">
                            <img className="skills-provider-icon--square" src="/images/connectors/feishu-logo.png" alt="" aria-hidden="true" />
                          </span>
                          <span className="skills-catalog-card__title-wrap">
                            <span className="skills-catalog-card__title">飞书</span>
                            <span className="skills-catalog-card__meta">平台连接</span>
                          </span>
                          {feishuConnected && feishuHealth === "ready" ? (
                            <span className="skills-mcp-card-v2__status" data-health="ready">
                              <span aria-hidden="true" />已连接
                            </span>
                          ) : null}
                        </span>
                        <span className="skills-catalog-card__desc">在飞书中使用岗位智能体，接收任务结果、定时通知和协作提醒。</span>
                        <span className="skills-catalog-card__capabilities" aria-label="连接能力">
                          {["双向对话", "结果投递", "定时通知"].map((capability) => <span key={capability}>{capability}</span>)}
                        </span>
                      </button>
                    </article>
                    );
                    const { connector } = entry;
                    return (
                    <article key={entry.key} className="skills-mcp-card-v2 skills-catalog-card skills-action-card" data-connected={entry.connected ? "true" : "false"}>
                      <button className="skills-catalog-card__surface" type="button" onClick={() => setDetailServerId(connector.serverId)}>
                        <span className="skills-catalog-card__head">
                          <span className="skills-catalog-card__icon skills-mcp-card-v2__icon" data-source={connector.source}>
                            <ConnectorIcon {...connector} />
                          </span>
                          <span className="skills-catalog-card__title-wrap">
                            <span className="skills-catalog-card__title">{connector.name}</span>
                            <span className="skills-catalog-card__meta">{connector.sourceLabel}</span>
                          </span>
                          {connector.connected && connector.health === "ready" ? (
                            <span className="skills-mcp-card-v2__status" data-health="ready">
                              <span aria-hidden="true" />已连接
                            </span>
                          ) : null}
                        </span>
                        <span className="skills-catalog-card__desc">{connector.description}</span>
                        <span className="skills-catalog-card__capabilities" aria-label="工具能力">
                          {connectorCapabilityLabels(connector).map((capability) => <span key={capability}>{capability}</span>)}
                        </span>
                      </button>
                    </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(selectedTemplate)} onOpenChange={(open) => { if (!open) setDetailTemplateId(null); }}>
        {selectedTemplate ? (
          <DialogContent className="skills-mcp-detail skills-connector-template-detail" aria-describedby="connector-template-description">
            <div className="skills-mcp-detail__header">
              <span className="skills-mcp-detail__icon" data-source={selectedTemplate.availability === "direct" ? "public" : "optional"}>
                {connectorTemplateIcon(selectedTemplate.id)}
              </span>
              <div className="skills-mcp-detail__intro">
                <DialogTitle>{selectedTemplate.name}</DialogTitle>
                <div className="skills-mcp-detail__meta">
                  <span className="skills-mcp-detail__status" data-health={connectorTemplateStatus(selectedTemplate, selectedTemplateConnected).health}>
                    <span aria-hidden="true" />{connectorTemplateStatus(selectedTemplate, selectedTemplateConnected).label}
                  </span>
                  <span>用户自行授权</span>
                </div>
                <DialogDescription id="connector-template-description">{selectedTemplate.description}</DialogDescription>
              </div>
            </div>
            <div className="skills-mcp-detail__body stealth-scrollbar">
              <div className="skills-mcp-detail__section-head"><span>主要能力</span><span>3</span></div>
              <div className="skills-mcp-detail__tools">
                {selectedTemplate.capabilities.map((capability) => (
                  <div key={capability} className="skills-mcp-detail__tool">
                    <span className="skills-mcp-detail__tool-icon"><Check aria-hidden="true" /></span>
                    <span className="skills-mcp-detail__tool-content"><span className="skills-mcp-detail__tool-name">{capability}</span></span>
                  </div>
                ))}
              </div>
              <div className="skills-mcp-detail__warning" data-tone={selectedTemplate.availability === "direct" ? "info" : "warning"}>
                <CircleAlert aria-hidden="true" />
                <span>{selectedTemplate.requirement}</span>
              </div>
            </div>
            <div className="skills-mcp-detail__footer">
              <span className="skills-mcp-detail__connection-note">平台不提供或共享用户凭据</span>
              <div className="skills-mcp-detail__footer-actions">
                {selectedTemplate.docsUrl ? (
                  <a
                    className="skills-mcp-detail__button"
                    href={selectedTemplate.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    使用说明 <ExternalLink />
                  </a>
                ) : null}
                <button
                  className="skills-mcp-detail__button skills-mcp-detail__button--primary"
                  type="button"
                  disabled={Boolean(oauthAction) || (!selectedTemplateConnected && ((!selectedTemplate.binding && !selectedTemplate.oauthCatalogId) || (Boolean(selectedTemplate.binding) && !onAddMcp)))}
                  onClick={() => {
                    if (selectedTemplateConnected) {
                      setDetailTemplateId(null);
                      onTryMcp?.();
                      return;
                    }
                    if (selectedTemplate.oauthCatalogId) {
                      void beginOAuthConnection(selectedTemplate);
                      return;
                    }
                    if (selectedTemplate.binding) {
                      const template = selectedTemplate.binding;
                      setDetailTemplateId(null);
                      onAddMcp?.(template);
                    }
                  }}
                >
                  {oauthAction === selectedTemplate.id
                    ? "正在授权"
                    : selectedTemplateConnected
                      ? "去试试"
                      : selectedTemplate.oauthCatalogId
                      ? selectedTemplateConnection ? "重新授权" : "授权连接"
                      : selectedTemplate.binding ? "绑定连接" : "等待开放"}
                  <ArrowRight />
                </button>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(selectedConnector || feishuSelected)} onOpenChange={(open) => { if (!open) setDetailServerId(null); }}>
        {selectedConnector ? (
          <DialogContent className="skills-mcp-detail" aria-describedby="skills-mcp-detail-description">
            <div className="skills-mcp-detail__header">
              <span className="skills-mcp-detail__icon" data-source={selectedConnector.source}>
                <ConnectorIcon {...selectedConnector} />
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
        ) : feishuSelected ? (
          <DialogContent className="skills-mcp-detail" aria-describedby="skills-feishu-detail-description">
            <div className="skills-mcp-detail__header">
              <span className="skills-mcp-detail__icon" data-source="preset">
                <img className="skills-provider-icon--square" src="/images/connectors/feishu-logo.png" alt="" aria-hidden="true" />
              </span>
              <div className="skills-mcp-detail__intro">
                <DialogTitle>飞书</DialogTitle>
                <div className="skills-mcp-detail__meta">
                  <span className="skills-mcp-detail__status" data-health={feishuHealth}>
                    <span aria-hidden="true" />{feishuStatusLabel}
                  </span>
                  <span>平台连接</span>
                  <span>消息与协作</span>
                </div>
                <DialogDescription id="skills-feishu-detail-description">
                  绑定当前岗位智能体后，可以在飞书中直接对话，并接收任务结果、定时通知和协作提醒。
                </DialogDescription>
              </div>
            </div>

            <div className="skills-mcp-detail__body stealth-scrollbar">
              {feishuConnected && feishuCapability?.targetLabel ? (
                <div className="skills-feishu-route">
                  <span>当前路由</span>
                  <strong>{feishuCapability.targetLabel} → 当前岗位智能体</strong>
                </div>
              ) : null}
              {feishuBindCode && !feishuConnected ? (
                <div className="skills-feishu-bind">
                  <span>飞书绑定码</span>
                  <strong>{feishuBindCode}</strong>
                  <p>{feishuBindInstruction || `请在飞书 Bot 私聊发送：绑定 ${feishuBindCode}`}</p>
                  {formatConnectionExpiry(feishuBindExpiresAt) ? (
                    <small>有效期至 {formatConnectionExpiry(feishuBindExpiresAt)}</small>
                  ) : null}
                </div>
              ) : null}
              {feishuBinding.qrCode && !feishuConnected ? (
                <div className="skills-feishu-oauth">
                  {feishuQrDataUrl ? <img src={feishuQrDataUrl} alt="飞书授权二维码" /> : null}
                  <div>
                    <strong>使用飞书扫码授权</strong>
                    <p>完成授权后，连接状态会自动更新。</p>
                    {feishuBinding.userCode ? <span>验证码：{feishuBinding.userCode}</span> : null}
                    <a href={feishuBinding.qrCode} target="_blank" rel="noreferrer">在浏览器中打开授权页</a>
                  </div>
                </div>
              ) : null}
              {feishuStatusError ? (
                <div className="skills-mcp-detail__warning">
                  <CircleAlert aria-hidden="true" />
                  <span>暂时无法读取飞书连接状态，请稍后重试。</span>
                </div>
              ) : null}
              <div className="skills-mcp-detail__section-head">
                <span>连接能力</span>
                <span>{FEISHU_CONNECTOR_TOOLS.length}</span>
              </div>
              <div className="skills-mcp-detail__tools">
                {FEISHU_CONNECTOR_TOOLS.map((tool) => (
                  <div key={tool.name} className="skills-mcp-detail__tool">
                    <span className="skills-mcp-detail__tool-icon"><Check aria-hidden="true" /></span>
                    <span className="skills-mcp-detail__tool-content">
                      <span className="skills-mcp-detail__tool-name">{tool.description}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="skills-mcp-detail__footer">
              {feishuConnected ? (
                <button
                  className="skills-mcp-detail__button skills-mcp-detail__button--unlink"
                  type="button"
                  disabled={Boolean(feishuAction)}
                  onClick={() => void unbindFeishuConnection()}
                >
                  {feishuAction === "unbind" ? <RotateCw className="animate-spin" /> : <PowerOff />}
                  解绑
                </button>
              ) : (
                <span className="skills-mcp-detail__connection-note">
                  {feishuBindCode || feishuBinding.qrCode ? "完成飞书授权后，状态会自动更新" : "连接后即可在飞书中使用岗位智能体"}
                </span>
              )}
              <div className="skills-mcp-detail__footer-actions">
                {feishuConnected ? (
                  <button
                  className="skills-mcp-detail__button skills-mcp-detail__button--primary"
                  type="button"
                  disabled={Boolean(feishuAction) || feishuBinding.testing}
                  onClick={() => void testFeishuConnection()}
                >
                    {feishuBinding.testing ? <RotateCw className="animate-spin" /> : <Send />}
                    发送测试消息
                  </button>
                ) : (
                  <button
                    className="skills-mcp-detail__button skills-mcp-detail__button--primary"
                    type="button"
                    disabled={Boolean(feishuAction) || feishuConnecting}
                    onClick={() => void beginFeishuConnection()}
                  >
                    {feishuAction === "connect" ? <RotateCw className="animate-spin" /> : <Plug />}
                    {feishuBinding.status === "scanning" ? "等待授权" : "连接飞书"}
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

function expertCapabilityLabels(agent: ExternalAgentSummary): string[] {
  const signature = `${agent.id} ${agent.name}`.toLocaleLowerCase();
  if (signature.includes("wind") || signature.includes("万得") || signature.includes("alice")) {
    return ["金融数据", "公司研究", "事实核验"];
  }
  if (/ppt|presentation|演示|cyber/.test(signature)) {
    return ["内容策划", "视觉排版", "PPT 交付"];
  }
  if (/diagram|flow|chart|图表|流程|架构|archify/.test(signature)) {
    return ["流程梳理", "架构绘制", "图稿交付"];
  }
  if (/risk|风控|审核/.test(signature)) {
    return ["风险识别", "材料分析", "处置建议"];
  }
  const labels = agentCapabilityTools(agent).map((item) => item.name);
  return Array.from(new Set([...labels, "专业分析", "任务交付", "结果回写"])).slice(0, 3);
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
  view,
  onTryExpert,
}: {
  adoptId?: string;
  query: string;
  view: CatalogView;
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
  const scopedAgents = useMemo(
    () => agents.filter((agent) => view === "mine" ? agent.source === "personal" : agent.source !== "personal"),
    [agents, view],
  );
  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return scopedAgents.filter((agent) => {
      if (filter === "ready" && !agent.routeReady) return false;
      if (!normalizedQuery) return true;
      return `${agent.name} ${agentDisplayDescription(agent)} ${(agent.capabilities || []).join(" ")}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [scopedAgents, filter, query]);
  const filterItems: Array<{ id: ExpertFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: scopedAgents.length },
    { id: "ready", label: "可调用", count: scopedAgents.filter((agent) => agent.routeReady).length },
  ];

  useEffect(() => setDetailAgentId(null), [view]);

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
      {!loading && scopedAgents.length === 0 && <div className="settings-card skills-market-empty"><Bot size={22} /><div>{view === "mine" ? "还没有个人专家" : "暂无可用专家"}</div></div>}
      {!loading && scopedAgents.length > 0 && filteredAgents.length === 0 && <div className="settings-card skills-market-empty"><Search size={22} /><div>没有匹配的专家</div></div>}

      {!loading && filteredAgents.length > 0 && (
        <div className="skills-mcp-grid">
          {filteredAgents.map((agent) => (
            <article key={agent.id} className="skills-mcp-card-v2 skills-catalog-card skills-action-card skills-expert-card" data-connected={agent.routeReady ? "true" : "false"}>
              <button
                className="skills-expert-card__summon"
                type="button"
                disabled={!agent.routeReady}
                aria-label={`召唤${agent.name}`}
                onClick={() => onTryExpert?.(agent.id)}
              >
                召唤
              </button>
              <button className="skills-catalog-card__surface" type="button" onClick={() => setDetailAgentId(agent.id)}>
                <span className="skills-catalog-card__head">
                <span className="skills-catalog-card__icon skills-mcp-card-v2__icon" data-source={agent.source === "personal" ? "personal" : "preset"}>
                  <ExpertAvatar agentId={agent.id} agentName={agent.name} />
                </span>
                <span className="skills-catalog-card__title-wrap">
                  <span className="skills-catalog-card__title">{agent.name}</span>
                  <span className="skills-catalog-card__meta">
                    {agent.source === "personal" ? "我的专家" : "公共专家"} · {agentStatusLabel(agent)}
                  </span>
                </span>
                </span>
                <span className="skills-catalog-card__desc">{agentDisplayDescription(agent)}</span>
                <span className="skills-catalog-card__capabilities" aria-label="核心能力">
                  {expertCapabilityLabels(agent).map((capability) => <span key={capability}>{capability}</span>)}
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
                <ExpertAvatar agentId={selectedAgent.id} agentName={selectedAgent.name} />
              </span>
              <div className="skills-mcp-detail__intro">
                <DialogTitle>{selectedAgent.name}</DialogTitle>
                <div className="skills-mcp-detail__meta">
                  <span className="skills-mcp-detail__status" data-health={agentStatusHealth(selectedAgent)}>
                    <span aria-hidden="true" />{agentStatusLabel(selectedAgent)}
                  </span>
                  <span>{selectedAgent.source === "personal" ? "我的专家" : "公共专家"}</span>
                  <span>{Math.max(0, Number(selectedAgent.usageCount || 0))} 次使用</span>
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
      className="skills-my-card skills-catalog-card skills-action-card"
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

export function SkillsPage({ section = "skills", adoptId, onChanged, onAddMcp, onManageMcp, onTryMcp, onMcpChanged, onAddExpert, onManageExpert, onTryExpert }: {
  section?: SkillsPageSection;
  skills?: { shared: any[]; system: any[]; private: any[] } | null | undefined;
  canEdit?: boolean;
  pending?: boolean;
  onToggle?: (skillId: string, enable: boolean, source: "shared" | "system") => void;
  adoptId?: string;
  onChanged?: () => void | Promise<void>;
  onAddMcp?: (template?: CustomMcpTemplate) => void;
  onManageMcp?: () => void;
  onTryMcp?: () => void;
  onMcpChanged?: () => void | Promise<void>;
  onAddExpert?: () => void;
  onManageExpert?: () => void;
  onTryExpert?: (expertId: string) => void;
}) {
  const { confirm, dialog } = useConfirmDialog();
  const [skillTab, setSkillTab] = useState<SkillTab>(() => initialSkillTab(section));
  const [lastSkillView, setLastSkillView] = useState<"mine" | "market">(() => cachedSkillTab() === "market" ? "market" : "mine");
  const [expertView, setExpertView] = useState<CatalogView>("market");
  const [connectorView, setConnectorView] = useState<CatalogView>("market");
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

  useLayoutEffect(() => {
    if (section === "experts") setSkillTab("agent");
    else if (section === "connectors") setSkillTab("mcp");
    else setSkillTab((current) => current === "mine" || current === "market" ? current : lastSkillView);
  }, [section, lastSkillView]);

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
  const pageTitle = section === "experts" ? "专家" : section === "connectors" ? "连接器" : "技能";

  return (
    <PageContainer title={pageTitle}>
      {dialog}
      <div className="skills-page">
        <div className="skills-console-toolbar">
        <div className="skills-secondary-tabs" role="tablist" aria-label={`${pageTitle}分栏`}>
          {section === "skills" ? (
            <>
              <button id="skills-subtab-market" type="button" role="tab" aria-selected={skillTab === "market"} data-active={skillTab === "market" ? "true" : "false"} onClick={() => setSkillTab("market")}>技能市场</button>
              <button id="skills-subtab-mine" type="button" role="tab" aria-selected={skillTab === "mine"} data-active={skillTab === "mine" ? "true" : "false"} onClick={() => setSkillTab("mine")}>我的技能</button>
            </>
          ) : section === "experts" ? (
            <>
              <button id="experts-subtab-market" type="button" role="tab" aria-selected={expertView === "market"} data-active={expertView === "market" ? "true" : "false"} onClick={() => setExpertView("market")}>专家市场</button>
              <button id="experts-subtab-mine" type="button" role="tab" aria-selected={expertView === "mine"} data-active={expertView === "mine" ? "true" : "false"} onClick={() => setExpertView("mine")}>我的专家</button>
            </>
          ) : (
            <>
              <button id="connectors-subtab-market" type="button" role="tab" aria-selected={connectorView === "market"} data-active={connectorView === "market" ? "true" : "false"} onClick={() => setConnectorView("market")}>连接器市场</button>
              <button id="connectors-subtab-mine" type="button" role="tab" aria-selected={connectorView === "mine"} data-active={connectorView === "mine" ? "true" : "false"} onClick={() => setConnectorView("mine")}>我的连接</button>
            </>
          )}
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
              {connectorView === "mine" && onManageMcp ? <button className="skills-console-action" type="button" onClick={onManageMcp}><Plug aria-hidden="true" /> 管理连接</button> : null}
              {onAddMcp ? <button className="skills-console-action" type="button" onClick={() => onAddMcp()}><Plus aria-hidden="true" /> 添加连接</button> : null}
            </>
          ) : (
            <>
              {expertView === "mine" && onManageExpert ? <button className="skills-console-action" type="button" onClick={onManageExpert}><Bot aria-hidden="true" /> 管理专家</button> : null}
              {onAddExpert ? <button className="skills-console-action" type="button" onClick={onAddExpert}><Plus aria-hidden="true" /> 添加专家</button> : null}
            </>
          )}
        </div>
        </div>

        {skillTab === "market" && (
          <div id="skills-panel-market" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby="skills-subtab-market" tabIndex={0}>
            <MarketplacePage adoptId={adoptId} onChanged={onChanged} query={marketQuery} />
          </div>
        )}

        {skillTab === "mcp" && (
          <div id="skills-panel-mcp" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby={`connectors-subtab-${connectorView}`} tabIndex={0}>
            <McpToolsPage
              adoptId={adoptId}
              query={mcpQuery}
              view={connectorView}
              onAddMcp={onAddMcp}
              onTryMcp={onTryMcp}
              onConnectionsChanged={onMcpChanged}
            />
          </div>
        )}

        {skillTab === "agent" && (
          <div id="skills-panel-agent" className="skills-panel skills-panel--market stealth-scrollbar" role="tabpanel" aria-labelledby={`experts-subtab-${expertView}`} tabIndex={0}>
            <AgentToolsPage adoptId={adoptId} query={expertQuery} view={expertView} onTryExpert={onTryExpert} />
          </div>
        )}

        {skillTab === "mine" && (
          <div id="skills-panel-mine" className="skills-panel stealth-scrollbar" role="tabpanel" aria-labelledby="skills-subtab-mine" tabIndex={0}>
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
