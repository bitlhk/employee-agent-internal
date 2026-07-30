import express from "express";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from "fs";
import path from "path";
import type { Skill, SkillSource } from "../../shared/types/skill";
import {
  requireClawOwner,
  resolveRuntimeAgentId,
  bumpSessionEpoch,
  clearAgentSessionsCache,
  OPENCLAW_BASE_HOME,
  OPENCLAW_HOME,
  OPENCLAW_JSON_PATH,
  isJiuwenClawAdoptId,
  openClawAgentDir,
  readSessionEpoch,
  resolveRuntimeWorkspaceByIds,
} from "./helpers";
import {
  deleteAgentMcpPreference,
  getAgentMcpPreference,
  listCustomMcpConnections,
  listMcpInvocationCounts,
  resolveEffectiveRoleAssets,
  resolvePersistedAgentMcpSelection,
  setAgentMcpPreference,
} from "../db";
import { skillRegistry } from "./skills/skill-registry";
import { listSkillsWithRoleDefaults } from "./skills/role-default-skills";
import { roleSkillPreferences } from "./skills/role-skill-preferences";
import { setAgentSkillEnabled } from "./skills/skill-enable-service";
import { skillInstaller } from "./skills/skill-installer";
import { parseSkillSourceDirectory } from "./skills/skill-source";
import {
  generatedSkillDiscoveryExcludedRoots,
  shouldDiscoverGeneratedRuntimeSkill,
} from "./skills/skill-discovery";
import {
  skillStoreGeneratedDir,
  skillStoreRuntimeImportedDir,
  skillSourceDirsForRuntime,
} from "./skills/skill-store";
import { registerSkillMarketRoutes } from "./skills/routes/skill-market-routes";
import { registerSkillPackageRoutes } from "./skills/routes/skill-package-routes";
import { getRoleRuntimeAdapter } from "../routers/role-runtime-adapters";
import { resolveAgentRoleTemplate } from "./role-templates";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import {
  buildCustomMcpStatusGroup,
  customMcpServerId,
  parseCustomMcpServerId,
  toggleCustomMcpConnection,
} from "./custom-mcp";
import {
  removeSkillPackageIndexRows,
} from "./skills/skill-package-index";

function registryErrorStatus(kind?: string): number {
  if (kind === "not_found") return 404;
  if (kind === "permission_denied") return 403;
  if (kind === "validation_failed") return 400;
  return 500;
}

function skillSourceCacheDir(adoptId: string, skillId: string): string {
  return skillStoreRuntimeImportedDir(adoptId, skillId);
}

type McpToolGroupOverride = {
  id: string;
  name: string;
  category: string;
  description: string;
  serverIds?: string[];
  serverIdPrefixes?: string[];
  recommendedSkills?: string[];
};

const DEFAULT_MCP_CATEGORY = "MCP 工具";

const MCP_TOOL_GROUP_OVERRIDES: McpToolGroupOverride[] = [
  { id: "wind_stock_data", name: "Wind A股数据", category: "公共金融数据", description: "查询 A 股行情、K 线、公司档案、财务、股东、事件、技术与风险指标。", serverIds: ["wind_stock_data"] },
  { id: "wind_global_stock_data", name: "Wind 全球股票", category: "公共金融数据", description: "查询港股和美股行情、K 线、公司基本面、股东、事件、技术与风险指标。", serverIds: ["wind_global_stock_data"] },
  { id: "wind_fund_data", name: "Wind 基金数据", category: "公共金融数据", description: "查询 ETF、公募基金行情、档案、持仓、业绩、持有人和基金公司信息。", serverIds: ["wind_fund_data"] },
  { id: "wind_index_data", name: "Wind 指数数据", category: "公共金融数据", description: "查询指数和行业板块的行情、成分、估值与技术指标，把握市场结构。", serverIds: ["wind_index_data"] },
  { id: "wind_bond_data", name: "Wind 债券数据", category: "公共金融数据", description: "查询债券档案、发债主体、行情估值、久期利差与主体财务数据。", serverIds: ["wind_bond_data"] },
  { id: "wind_financial_docs", name: "Wind 公告资讯", category: "公共金融数据", description: "检索上市公司公告和财经新闻，辅助公司研究、事件跟踪与事实核验。", serverIds: ["wind_financial_docs"] },
  { id: "wind_economic_data", name: "Wind 宏观经济", category: "公共金融数据", description: "查询宏观经济和行业指标时间序列，覆盖频率、量纲和币种等维度。", serverIds: ["wind_economic_data"] },
  { id: "wind_analytics_data", name: "Wind 综合取数", category: "公共金融数据", description: "通过自然语言跨领域查询 Wind 数据，适合复杂金融问题和补充取数。", serverIds: ["wind_analytics_data"] },
  { id: "qieman", name: "且慢基金数据", category: "公共金融数据", description: "查询公募基金档案、净值、持仓和组合表现，用于基金筛选与对比。", serverIds: ["qieman"] },
  { id: "bond_quote_parse", name: "债券报价", category: "内部业务 MCP", description: "识别文本或文件中的债券报价，并转换为可检索、可计算的结构化数据。", serverIds: ["bond_quote_parse"] },
  { id: "group_insurance_audit", name: "团险审核", category: "内部业务 MCP", description: "核对团险投保材料、关键字段和审核规则，提示缺失信息与业务风险。", serverIds: ["group_insurance_audit"] },
  { id: "credential_skills", name: "凭证审核", category: "内部业务 MCP", description: "识别业务凭证和影像内容，校验关键字段并输出结构化审核结果。", serverIds: ["credential_skills"] },
  { id: "insurance_telesales_recommend", name: "保险电销推荐", category: "内部业务 MCP", description: "结合客户需求匹配保险产品，生成电销沟通重点、推荐理由和话术建议。", serverIds: ["insurance_telesales_recommend"] },
  { id: "insurance_kb", name: "保险知识库", category: "内部业务 MCP", description: "检索保险产品、责任条款、投保规则与业务口径，回答保险专业问题。", serverIds: ["insurance_kb"] },
  { id: "post_loan_risk_data", name: "贷后风险数据", category: "内部业务 MCP", description: "查询企业贷后指标、风险事件与预警信号，支撑风险评估和持续跟踪。", serverIds: ["post_loan_risk_data"] },
  { id: "wealth_assistant_customer", name: "财富客户数据", category: "内部业务 MCP", description: "查询当前客户经理负责的客户、资产、持仓与服务信息，辅助客户洞察。", serverIds: ["wealth_assistant_customer"] },
  { id: "wealth_assistant_product", name: "财富产品数据", category: "内部业务 MCP", description: "查询财富产品详情、风险等级与适配条件，完成产品筛选和客户匹配。", serverIds: ["wealth_assistant_product"] },
  { id: "platform_tools", name: "平台协作工具", category: "平台能力", description: "管理投递通道、定时任务和跨智能体协作，让对话结果进入后续工作流程。", serverIds: ["platform_tools"] },
  { id: "custom_mcp_gateway", name: "自定义连接网关", category: "平台能力", description: "将用户添加的 MCP 安全接入当前智能体，并按用户和智能体实例隔离调用。", serverIds: ["custom_mcp_gateway"] },
];

function readableMcpName(serverId: string): string {
  return serverId
    .split(/[._-]+/g)
    .filter(Boolean)
    .map(part => {
      const upper = part.toUpperCase();
      if (["MCP", "API", "HTTP", "KB", "A2A"].includes(upper)) return upper;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ") || serverId;
}

function mcpGroupOverrideFor(serverId: string): McpToolGroupOverride | null {
  for (const item of MCP_TOOL_GROUP_OVERRIDES) {
    if (item.serverIds?.includes(serverId)) return item;
    if (item.serverIdPrefixes?.some(prefix => serverId.startsWith(prefix))) return item;
  }
  return null;
}

function mcpFallbackTool(serverId: string) {
  return {
    name: "tools_list_unavailable",
    description: "MCP 服务 " + serverId + " 已接入；工具明细以服务实时 tools/list 声明为准。",
    source: "fallback",
  };
}

function readOpenClawConfig(): Record<string, any> {
  try {
    if (!existsSync(OPENCLAW_JSON_PATH)) return {};
    const cfg = JSON.parse(
      String(readFileSync(OPENCLAW_JSON_PATH, "utf-8") || "{}")
    );
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function readOpenClawMcpServers(config = readOpenClawConfig()): Record<string, any> {
  return config?.mcp?.servers && typeof config.mcp.servers === "object"
    ? config.mcp.servers
    : {};
}

export function listConfiguredMcpServers() {
  const servers = readOpenClawMcpServers();
  return Object.entries(servers)
    .map(([serverId, raw]) => ({
      serverId,
      configured: true,
      enabled: !Boolean((raw as any)?.disabled),
      status: Boolean((raw as any)?.disabled) ? "disabled" : "available",
      existsOnDisk: mcpServerExistsOnDisk(serverId, raw),
    }))
    .sort((a, b) => a.serverId.localeCompare(b.serverId));
}

type McpLiveTool = {
  name: string;
  description: string;
};

type McpLiveStatus = {
  serverId: string;
  status: "live" | "unavailable" | "unsupported";
  tools: McpLiveTool[];
  checkedAt: string;
  error?: string;
};

const MCP_TOOLS_LIVE_TTL_MS = 45_000;
const mcpToolsLiveCache = new Map<string, { expiresAt: number; value: McpLiveStatus }>();
const agentMcpMutationTails = new Map<string, Promise<void>>();

async function withAgentMcpMutationLock<T>(adoptId: string, action: () => Promise<T>): Promise<T> {
  const previous = agentMcpMutationTails.get(adoptId) || Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  agentMcpMutationTails.set(adoptId, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (agentMcpMutationTails.get(adoptId) === tail) agentMcpMutationTails.delete(adoptId);
  }
}

function normalizeMcpTransport(raw: any): string {
  return String(raw?.transport || raw?.type || "").trim().toLowerCase();
}

function normalizeMcpUrl(raw: any): string {
  return String(raw?.url || raw?.endpoint || "").trim();
}

function normalizeMcpHeaders(raw: any): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = raw?.headers && typeof raw.headers === "object" ? raw.headers : {};
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    headers[key] = String(value ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      if (name === "OPENCLAW_AGENT_ID") return "";
      return process.env[name] || "";
    });
  }
  return headers;
}

function readMcpToolInclude(raw: any): Set<string> | null {
  const include = raw?.toolFilter?.include;
  if (!Array.isArray(include)) return null;
  const names = include.map((item: any) => String(item || "").trim()).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

function parseMcpToolsListPayload(text: string): McpLiveTool[] {
  const payload = String(text || "").trim();
  if (!payload) return [];
  const candidates: string[] = [];
  if (payload.includes("\ndata:") || payload.startsWith("data:")) {
    const dataLines = payload
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .filter(Boolean);
    candidates.push(...dataLines.reverse());
  }
  candidates.push(payload);
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      const tools = json?.result?.tools || json?.tools || json?.data?.tools;
      if (!Array.isArray(tools)) continue;
      return tools
        .map((tool: any) => ({
          name: String(tool?.name || "").trim(),
          description: String(tool?.description || "").trim(),
        }))
        .filter(tool => tool.name);
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchMcpLiveStatus(serverId: string, raw: any, options: { force?: boolean } = {}): Promise<McpLiveStatus> {
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const cacheKey = `${serverId}:${normalizeMcpUrl(raw)}`;
  const cached = mcpToolsLiveCache.get(cacheKey);
  if (!options.force && cached && cached.expiresAt > now) return cached.value;

  const transport = normalizeMcpTransport(raw);
  const url = normalizeMcpUrl(raw);
  if (!url || (transport && transport !== "url" && transport !== "streamable-http" && transport !== "http")) {
    const value: McpLiveStatus = { serverId, status: "unsupported", tools: [], checkedAt };
    mcpToolsLiveCache.set(cacheKey, { expiresAt: now + MCP_TOOLS_LIVE_TTL_MS, value });
    return value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        connection: "close",
        ...normalizeMcpHeaders(raw),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    let tools = parseMcpToolsListPayload(text);
    const include = readMcpToolInclude(raw);
    if (include) tools = tools.filter(tool => include.has(tool.name));
    const value: McpLiveStatus = {
      serverId,
      status: "live",
      tools,
      checkedAt,
    };
    mcpToolsLiveCache.set(cacheKey, { expiresAt: now + MCP_TOOLS_LIVE_TTL_MS, value });
    return value;
  } catch (e: any) {
    const value: McpLiveStatus = {
      serverId,
      status: "unavailable",
      tools: [],
      checkedAt,
      error: e?.name === "AbortError" ? "timeout" : String(e?.message || e || "fetch failed"),
    };
    mcpToolsLiveCache.set(cacheKey, { expiresAt: now + MCP_TOOLS_LIVE_TTL_MS, value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMcpLiveStatuses(
  servers: Record<string, any>,
  allowedServerIds: Set<string>,
  options: { force?: boolean } = {}
): Promise<Record<string, McpLiveStatus>> {
  const entries = Object.entries(servers).filter(
    ([serverId, raw]) => allowedServerIds.has(serverId) && !Boolean((raw as any)?.disabled)
  );
  const result: Record<string, McpLiveStatus> = {};
  const concurrency = 4;
  for (let i = 0; i < entries.length; i += concurrency) {
    const chunk = entries.slice(i, i + concurrency);
    const rows = await Promise.all(chunk.map(([serverId, raw]) => fetchMcpLiveStatus(serverId, raw, options)));
    for (const row of rows) result[row.serverId] = row;
  }
  return result;
}

function readSkillMarkdownCandidate(
  dir?: string
): { text: string; source: "runtime" | "source" } | null {
  if (!dir || !existsSync(dir)) return null;
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return null;
    const file = path.join(dir, "SKILL.md");
    if (!existsSync(file)) return null;
    const fileStat = statSync(file);
    if (!fileStat.isFile() || fileStat.size > 200 * 1024) return null;
    const text = String(readFileSync(file, "utf-8") || "");
    if (!text.trim() || text.includes("\u0000")) return null;
    return { text, source: "runtime" };
  } catch {
    return null;
  }
}

function extractSkillIntroduction(skillMd: string, fallback: string): string {
  const raw = String(skillMd || "");
  const fm = raw.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]*/);
  const fmBlock = fm?.[1] || "";
  const description = fmBlock
    .match(/^description:\s*['"]?([^'"\n]+)['"]?/im)?.[1]
    ?.trim();
  let body = fm ? raw.slice(fm[0].length) : raw;
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*#\s+.+$/m, "")
    .trim();
  const intro = body || description || fallback || "暂无说明";
  return intro.length > 6000
    ? `${intro.slice(0, 6000).trimEnd()}\n\n（内容较长，已截断）`
    : intro;
}

function mcpServerExistsOnDisk(serverId: string, raw: any): boolean {
  const command = typeof raw?.command === "string" ? raw.command : "";
  const args = Array.isArray(raw?.args)
    ? raw.args.map((x: any) => String(x || ""))
    : [];
  const candidates = [command, ...args].filter(Boolean);
  for (const item of candidates) {
    if (item.startsWith("/") && existsSync(item)) return true;
  }
  return existsSync(path.join(OPENCLAW_HOME, "mcp", serverId));
}

export function listMcpToolGroups(options: {
  allowedServerIds?: Set<string> | null;
  invocationCounts?: Record<string, { total: number; tools: Record<string, number> }> | null;
  liveStatuses?: Record<string, McpLiveStatus> | null;
} = {}) {
  const allowedServerIds = options.allowedServerIds || null;
  const invocationCounts = options.invocationCounts || {};
  const liveStatuses = options.liveStatuses || {};
  const config = readOpenClawConfig();
  const servers = readOpenClawMcpServers(config);
  const serverRows = Object.entries(servers).map(([serverId, raw]) => {
    const disabled = Boolean((raw as any)?.disabled);
    return {
      serverId,
      configured: true,
      enabled: !disabled,
      status: disabled ? "disabled" : "available",
      existsOnDisk: mcpServerExistsOnDisk(serverId, raw),
    };
  });
  const byId = new Map(serverRows.map(row => [row.serverId, row]));
  const serverIds = allowedServerIds
    ? Array.from(allowedServerIds).sort()
    : serverRows.map(row => row.serverId).sort();
  const grouped = new Map<string, any>();

  for (const serverId of serverIds) {
    const override = mcpGroupOverrideFor(serverId);
    const groupId = override?.id || serverId;
    const group = grouped.get(groupId) || {
      id: groupId,
      name: override?.name || readableMcpName(serverId),
      category: override?.category || DEFAULT_MCP_CATEGORY,
      description: override?.description || "MCP 服务能力，工具明细由服务实时声明。",
      recommendedSkills: override?.recommendedSkills || [],
      children: [] as any[],
    };
    grouped.set(groupId, group);

    const server =
      byId.get(serverId) || {
        serverId,
        configured: false,
        enabled: false,
        status: "missing",
        existsOnDisk: existsSync(path.join(OPENCLAW_HOME, "mcp", serverId)),
      };
    const liveRow = liveStatuses[serverId];
    const liveTools = liveRow?.status === "live" ? liveRow.tools || [] : [];
    const liveToolNames = new Set<string>();
    const tools = liveTools.length > 0
      ? liveTools
        .filter(tool => {
          if (liveToolNames.has(tool.name)) return false;
          liveToolNames.add(tool.name);
          return true;
        })
        .map(tool => ({
          ...tool,
          invocationCount: Number(invocationCounts[serverId]?.tools?.[tool.name] || 0),
          source: "live",
        }))
      : [{ ...mcpFallbackTool(serverId), invocationCount: 0 }];
    const hasLiveProbe = Boolean(liveRow);
    const hasLiveSuccess = liveRow?.status === "live";
    const hasLiveFailure = liveRow?.status === "unavailable";
    const status = server.enabled && (!hasLiveProbe || hasLiveSuccess)
      ? "available"
      : server.configured || hasLiveFailure
        ? "disabled"
        : "missing";
    const liveStatus = hasLiveSuccess
      ? "live"
      : hasLiveFailure
        ? "unavailable"
        : hasLiveProbe
          ? "unsupported"
          : "fallback";

    group.children.push({
      id: serverId,
      name: readableMcpName(serverId),
      description: "MCP 服务，工具明细以实时 tools/list 声明为准。",
      serverId,
      configured: server.configured,
      enabled: server.enabled,
      status,
      existsOnDisk: server.existsOnDisk,
      invocationCount: Number(invocationCounts[serverId]?.total || 0),
      tools,
      toolSource: liveTools.length > 0 ? "live" : "fallback",
      liveStatus,
      liveCheckedAt: liveRow?.checkedAt || null,
      liveError: liveRow?.error || null,
    });
  }

  const groups = Array.from(grouped.values()).map(item => {
    const children = item.children as any[];
    const availableCount = children.filter(
      (child: any) => child.status === "available"
    ).length;
    const configuredCount = children.filter((child: any) => child.configured).length;
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      recommendedSkills: item.recommendedSkills,
      status:
        availableCount > 0
          ? "available"
          : configuredCount > 0
            ? "disabled"
            : "missing",
      availableCount,
      configuredCount,
      serverCount: children.length,
      invocationCount: children.reduce((sum: number, child: any) => sum + Number(child.invocationCount || 0), 0),
      liveStatus: children.some((child: any) => child.liveStatus === "live")
        ? "live"
        : children.some((child: any) => child.liveStatus === "unavailable")
          ? "unavailable"
          : children.some((child: any) => child.liveStatus === "unsupported")
            ? "unsupported"
            : "fallback",
      children,
    };
  }).sort((a, b) => {
    const categoryOrder = a.category.localeCompare(b.category, "zh-CN");
    return categoryOrder || a.name.localeCompare(b.name, "zh-CN");
  });

  const visibleServerRows = allowedServerIds
    ? serverRows.filter(row => allowedServerIds.has(row.serverId))
    : serverRows;

  return {
    items: groups,
    totals: {
      groups: groups.length,
      configuredServers: visibleServerRows.length,
      availableServers: visibleServerRows.filter(row => row.enabled).length,
      invocations: groups.reduce((sum, group: any) => sum + Number(group.invocationCount || 0), 0),
    },
  };
}

async function discoverGeneratedRuntimeSkills(
  adoptId: string,
  runtimeAgentId: string,
  onlySkillId?: string
): Promise<{
  discovered: number;
  installed: Array<{ skillId: string; displayName: string }>;
  skipped: Array<{ skillId: string; reason: string }>;
}> {
  const runtimeSkillsRoot = path.join(
    resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId),
    "skills"
  );
  if (!existsSync(runtimeSkillsRoot))
    return { discovered: 0, installed: [], skipped: [] };

  const listed = await skillRegistry.listSkills(adoptId);
  const registered = new Set(
    listed.ok ? listed.value.map(item => item.id) : []
  );
  const installed: Array<{ skillId: string; displayName: string }> = [];
  const skipped: Array<{ skillId: string; reason: string }> = [];
  const excludedRoots = generatedSkillDiscoveryExcludedRoots(OPENCLAW_HOME, skillSourceDirsForRuntime());

  for (const entry of readdirSync(runtimeSkillsRoot, { withFileTypes: true })) {
    const sourceDir = path.join(runtimeSkillsRoot, entry.name);
    const discoverable = shouldDiscoverGeneratedRuntimeSkill(sourceDir, excludedRoots);
    if (!discoverable.ok) {
      if (existsSync(path.join(sourceDir, "SKILL.md"))) {
        skipped.push({ skillId: entry.name, reason: discoverable.reason });
      }
      continue;
    }
    if (!existsSync(path.join(sourceDir, "SKILL.md"))) continue;
    if (onlySkillId && entry.name !== onlySkillId) continue;

    try {
      const parsed = parseSkillSourceDirectory(sourceDir, entry.name);
      if (
        onlySkillId &&
        parsed.skillId !== onlySkillId &&
        entry.name !== onlySkillId
      )
        continue;
      if (registered.has(parsed.skillId)) {
        skipped.push({ skillId: parsed.skillId, reason: "already_registered" });
        continue;
      }

      const sourceCache = skillSourceCacheDir(adoptId, parsed.skillId);
      rmSync(sourceCache, { recursive: true, force: true });
      mkdirSync(path.dirname(sourceCache), { recursive: true });
      cpSync(sourceDir, sourceCache, { recursive: true });
      const st = statSync(sourceCache);
      if (!st.isDirectory()) {
        skipped.push({ skillId: parsed.skillId, reason: "source_copy_failed" });
        continue;
      }

      const source: SkillSource = {
        kind: "runtime_imported",
        skillId: parsed.skillId,
        displayName: parsed.displayName || parsed.skillId,
        description: parsed.description || "运行时导入的个人技能",
        sourcePath: sourceCache,
        version: String(parsed.manifest?.version || ""),
      };
      const result = await skillRegistry.install(adoptId, source);
      if (!result.ok) {
        skipped.push({ skillId: parsed.skillId, reason: result.error.detail });
        continue;
      }
      await skillRegistry.updateScan(adoptId, parsed.skillId, {
        warnings: parsed.warnings,
        scannedAt: new Date().toISOString(),
      });
      registered.add(parsed.skillId);
      installed.push({
        skillId: parsed.skillId,
        displayName: source.displayName,
      });
    } catch (e: any) {
      skipped.push({ skillId: entry.name, reason: String(e?.message || e) });
    }
  }

  return { discovered: installed.length, installed, skipped };
}


export function registerSkillRoutes(app: express.Express) {
  registerSkillMarketRoutes(app);
  registerSkillPackageRoutes(app);

  app.get("/api/claw/mcp-tools/status", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const roleTemplate = String((claw as any).roleTemplate || "general-assistant");
      const effectiveAssets = await resolveEffectiveRoleAssets(roleTemplate);
      const selection = await resolvePersistedAgentMcpSelection(adoptId, effectiveAssets);
      const force = String(req.query.force || "") === "1";
      const allowedServerIds = new Set(selection.authorizedServerIds);
      const config = readOpenClawConfig();
      const servers = readOpenClawMcpServers(config);
      const liveStatuses = await fetchMcpLiveStatuses(servers, allowedServerIds, { force }).catch(
        (e) => {
          console.warn("[mcp tools] live probe failed", e);
          return {} as Record<string, McpLiveStatus>;
        }
      );
      const invocationCounts = await listMcpInvocationCounts(Array.from(allowedServerIds)).catch(
        () => ({} as Record<string, { total: number; tools: Record<string, number> }>)
      );
      const rawPayload = listMcpToolGroups({ allowedServerIds, invocationCounts, liveStatuses });
      const customRows = await listCustomMcpConnections({
        adoptId,
        userId: Number((claw as any).userId || 0),
      });
      const customGroup = await buildCustomMcpStatusGroup(adoptId, Number((claw as any).userId || 0));
      const customServerIds = customRows.map((row) => customMcpServerId(row.id));
      const enabledCustomServerIds = customRows.filter((row) => row.enabled).map((row) => customMcpServerId(row.id));
      const enabledServerIds = new Set(selection.enabledServerIds);
      const items = customGroup ? [...rawPayload.items, customGroup] : rawPayload.items;
      const payload = {
        ...rawPayload,
        items: items.map((group: any) => {
          if (group.id === "custom-user-mcp") return group;
          const children = group.children.map((child: any) => ({
            ...child,
            enabledForAgent: enabledServerIds.has(child.serverId),
            grantMode: selection.grantModeByServerId[child.serverId] || "optional",
          }));
          return {
            ...group,
            activeCount: children.filter((child: any) => child.enabledForAgent).length,
            children,
          };
        }),
        totals: {
          ...rawPayload.totals,
          groups: items.length,
          configuredServers: Number(rawPayload.totals?.configuredServers || 0) + customRows.length,
          availableServers: Number(rawPayload.totals?.availableServers || 0)
            + customRows.filter((row) => row.enabled && row.healthStatus === "ready").length,
          activeServers: selection.enabledServerIds.length + enabledCustomServerIds.length,
        },
      };
      res.json({
        ...payload,
        roleTemplate,
        filtered: true,
        allowedServerIds: [...selection.authorizedServerIds, ...customServerIds],
        enabledServerIds: [...selection.enabledServerIds, ...enabledCustomServerIds],
        disabledServerIds: [
          ...selection.disabledServerIds,
          ...customRows.filter((row) => !row.enabled).map((row) => customMcpServerId(row.id)),
        ],
        live: {
          enabled: true,
          ttlMs: MCP_TOOLS_LIVE_TTL_MS,
          checkedAt: new Date().toISOString(),
          serverStatuses: Object.fromEntries(
            [
              ...Object.entries(liveStatuses).map(([serverId, status]) => [
                serverId,
                {
                  status: status.status,
                  toolCount: status.tools.length,
                  checkedAt: status.checkedAt,
                  error: status.error || null,
                },
              ]),
              ...customRows.map((row) => [
                customMcpServerId(row.id),
                {
                  status: row.healthStatus === "ready" ? "live" : "unavailable",
                  toolCount: Array.isArray(row.selectedToolNames) ? row.selectedToolNames.length : 0,
                  checkedAt: row.lastTestedAt?.toISOString() || null,
                  error: row.lastError || null,
                },
              ]),
            ]
          ),
        },
      });
    } catch (e) {
      console.error("[mcp tools] status failed", e);
      res.status(500).json({ error: "list mcp tools failed" });
    }
  });

  app.post("/api/claw/mcp-tools/toggle", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const serverId = String(req.body?.serverId || "").trim();
    const enabled = req.body?.enabled;
    if (!adoptId || !serverId || typeof enabled !== "boolean") {
      res.status(400).json({ error: "adoptId, serverId and enabled are required" });
      return;
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(serverId)) {
      res.status(400).json({ error: "invalid serverId" });
      return;
    }

    try {
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (!isJiuwenClawAdoptId(adoptId)) {
        res.status(409).json({ error: "当前运行时暂不支持按智能体切换连接" });
        return;
      }

      const customConnectionId = parseCustomMcpServerId(serverId);
      if (customConnectionId) {
        const userId = Number((claw as any).userId || 0);
        const { result, selection, customRows } = await withAgentMcpMutationLock(adoptId, async () => {
          const result = await toggleCustomMcpConnection({
            id: customConnectionId,
            adoptId,
            userId,
            enabled,
          });
          const roleTemplate = String((claw as any).roleTemplate || "general-assistant");
          const effectiveAssets = await resolveEffectiveRoleAssets(roleTemplate);
          const selection = await resolvePersistedAgentMcpSelection(adoptId, effectiveAssets);
          const customRows = await listCustomMcpConnections({ adoptId, userId });
          return { result, selection, customRows };
        });
        const enabledCustomIds = customRows.filter((row) => row.enabled).map((row) => customMcpServerId(row.id));
        await recordAuditBestEffort({
          action: "agent.connector.updated",
          actorType: "user",
          actorUserId: userId,
          ...auditRequest(req),
          targetType: "agent_connector",
          targetId: `${adoptId}:${serverId}`,
          targetName: serverId,
          agentInstanceId: adoptId,
          runtimeType: "jiuwenswarm",
          metadata: { enabled, custom: true, sessionEpoch: result.sessionEpoch },
        });
        res.json({
          ok: true,
          changed: result.changed,
          serverId,
          enabled,
          enabledServerIds: [...selection.enabledServerIds, ...enabledCustomIds],
          disabledServerIds: [
            ...selection.disabledServerIds,
            ...customRows.filter((row) => !row.enabled).map((row) => customMcpServerId(row.id)),
          ],
          sessionEpoch: result.sessionEpoch,
        });
        return;
      }

      const result = await withAgentMcpMutationLock(adoptId, async () => {
        const roleTemplate = String((claw as any).roleTemplate || "general-assistant");
        const role = resolveAgentRoleTemplate(roleTemplate);
        const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
        const authorized = new Set([
          ...effectiveAssets.mcpServers.default,
          ...effectiveAssets.mcpServers.optional,
        ]);
        if (!authorized.has(serverId)) {
          const error = new Error("该连接未授权给当前岗位");
          (error as any).statusCode = 403;
          throw error;
        }

        const previous = await getAgentMcpPreference(adoptId, serverId);
        const previousEnabled = previous ? Boolean(previous.enabled) : true;
        if (previousEnabled === enabled) {
          const selection = await resolvePersistedAgentMcpSelection(adoptId, effectiveAssets);
          return { changed: false, selection, sessionEpoch: readSessionEpoch(adoptId) };
        }

        const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
        const runtimeAdapter = getRoleRuntimeAdapter("jiuwenswarm");
        try {
          if (enabled) await deleteAgentMcpPreference(adoptId, serverId);
          else await setAgentMcpPreference({
            adoptId,
            serverId,
            enabled: false,
            updatedBy: Number((claw as any).userId || 0) || null,
          });

          const reconcile = await runtimeAdapter.reconcileMcp({
            adoptId,
            agentId: runtimeAgentId,
            role,
            effectiveAssets,
          });
          const sessionEpoch = await runtimeAdapter.bumpSessionEpoch(adoptId, runtimeAgentId);
          if (sessionEpoch <= 0) throw new Error("会话配置刷新失败");
          const selection = await resolvePersistedAgentMcpSelection(adoptId, effectiveAssets);
          await recordAuditBestEffort({
            action: "agent.connector.updated",
            actorType: "user",
            actorUserId: Number((claw as any).userId || 0) || null,
            ...auditRequest(req),
            targetType: "agent_connector",
            targetId: `${adoptId}:${serverId}`,
            targetName: serverId,
            agentInstanceId: adoptId,
            runtimeType: "jiuwenswarm",
            runtimeAgentId,
            metadata: { enabled, roleTemplate: role.id, reconcile, sessionEpoch },
          });
          return { changed: true, selection, sessionEpoch };
        } catch (error) {
          try {
            if (previous) {
              await setAgentMcpPreference({
                adoptId,
                serverId,
                enabled: Boolean(previous.enabled),
                updatedBy: previous.updatedBy,
              });
            } else {
              await deleteAgentMcpPreference(adoptId, serverId);
            }
            await runtimeAdapter.reconcileMcp({
              adoptId,
              agentId: runtimeAgentId,
              role,
              effectiveAssets,
            });
          } catch (rollbackError) {
            console.error("[AGENT-MCP] rollback failed", { adoptId, serverId, rollbackError });
          }
          throw error;
        }
      });

      res.json({
        ok: true,
        changed: result.changed,
        serverId,
        enabled,
        enabledServerIds: result.selection.enabledServerIds,
        disabledServerIds: result.selection.disabledServerIds,
        sessionEpoch: result.sessionEpoch,
      });
    } catch (error) {
      const statusCode = Number((error as any)?.statusCode || 0);
      console.error("[AGENT-MCP] toggle failed", { adoptId, serverId, enabled, error });
      res.status(statusCode >= 400 && statusCode < 500 ? statusCode : 500).json({
        error: error instanceof Error ? error.message : "连接切换失败",
      });
    }
  });

  app.get("/api/claw/skills/registry", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const roleTemplate = String((claw as any).roleTemplate || "general-assistant");
      const runtimeAgentId = await resolveRuntimeAgentId(
        adoptId,
        String((claw as any).agentId || "")
      );
      await discoverGeneratedRuntimeSkills(adoptId, runtimeAgentId);
      const result = await listSkillsWithRoleDefaults({
        adoptId,
        agentId: runtimeAgentId,
        roleTemplate,
      });
      if (!result.ok) {
        res
          .status(registryErrorStatus(result.error.kind))
          .json({ error: result.error.detail, kind: result.error.kind });
        return;
      }
      res.json({
        items: result.value,
        roleTemplate,
        filtered: false,
      });
    } catch (e) {
      console.error("[skills registry] list failed", e);
      res.status(500).json({ error: "list skills failed" });
    }
  });

  app.get("/api/claw/skills/introduction", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const skillId = String(req.query.skillId || "").trim();
      if (!adoptId || !skillId) {
        res.status(400).json({ error: "adoptId and skillId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const roleTemplate = String((claw as any).roleTemplate || "general-assistant");
      const runtimeAgentId = await resolveRuntimeAgentId(
        adoptId,
        String((claw as any).agentId || "")
      );
      await discoverGeneratedRuntimeSkills(adoptId, runtimeAgentId);
      const listed = await listSkillsWithRoleDefaults({
        adoptId,
        agentId: runtimeAgentId,
        roleTemplate,
      });
      if (!listed.ok) {
        res
          .status(registryErrorStatus(listed.error.kind))
          .json({ error: listed.error.detail, kind: listed.error.kind });
        return;
      }
      const skill = listed.value.find(item => item.id === skillId);
      if (!skill) {
        res.status(404).json({ error: "skill not found" });
        return;
      }

      const runtimeRead = readSkillMarkdownCandidate(skill.sync?.runtimePath);
      if (runtimeRead) {
        res.json({
          skillId,
          introduction: extractSkillIntroduction(
            runtimeRead.text,
            skill.source.description || ""
          ),
          source: "runtime",
        });
        return;
      }

      const sourceRead = readSkillMarkdownCandidate(skill.source?.sourcePath);
      if (sourceRead) {
        res.json({
          skillId,
          introduction: extractSkillIntroduction(
            sourceRead.text,
            skill.source.description || ""
          ),
          source: "source",
        });
        return;
      }

      res.json({
        skillId,
        introduction: skill.source.description || "暂无说明",
        source: skill.source.description ? "registry" : "fallback",
      });
    } catch (e) {
      console.error("[skills registry] introduction failed", e);
      res.status(500).json({ error: "load skill introduction failed" });
    }
  });

  app.post("/api/claw/skills/reconcile", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const runtimeAgentId = await resolveRuntimeAgentId(
        adoptId,
        String((claw as any).agentId || "")
      );
      const discovered = await discoverGeneratedRuntimeSkills(
        adoptId,
        runtimeAgentId,
        skillId || undefined
      );
      const result = await skillRegistry.reconcile(
        adoptId,
        skillId ? { skillId } : undefined
      );
      if (!result.ok) {
        res
          .status(registryErrorStatus(result.error.kind))
          .json({ error: result.error.detail, kind: result.error.kind });
        return;
      }
      console.log("[SKILL-RECONCILE]", {
        adoptId,
        skillId: skillId || "(all)",
        scanned: result.value.scanned,
        changed: result.value.changed,
        failed: result.value.failed,
        discovered: discovered.discovered,
      });
      res.json({ report: result.value, discovered });
    } catch (e) {
      console.error("[skills registry] reconcile failed", e);
      res.status(500).json({ error: "reconcile skills failed" });
    }
  });

  app.post("/api/claw/skills/set-enabled", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      const enabled = !!body.enabled;
      if (!adoptId || !skillId) {
        res.status(400).json({ error: "adoptId and skillId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const result = await setAgentSkillEnabled({
        adoptId,
        agentId: String((claw as any).agentId || ""),
        roleTemplate: String((claw as any).roleTemplate || "general-assistant"),
        skillId,
        enabled,
      });
      if (!result.ok) {
        const status = result.kind === "runtime_retired"
          ? 410
          : result.kind === "not_found"
            ? 404
            : 500;
        res.status(status).json({ error: result.detail, kind: result.kind });
        return;
      }
      res.json({ item: result.item });
    } catch (e) {
      console.error("[skills registry] set-enabled failed", e);
      res.status(500).json({ error: "set skill enabled failed" });
    }
  });

  app.post("/api/claw/skills/uninstall", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      if (!adoptId || !skillId) {
        res.status(400).json({ error: "adoptId and skillId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const result = await skillRegistry.uninstall(adoptId, skillId);
      if (!result.ok) {
        res
          .status(registryErrorStatus(result.error.kind))
          .json({ error: result.error.detail, kind: result.error.kind });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[skills registry] uninstall failed", e);
      res.status(500).json({ error: "uninstall skill failed" });
    }
  });

  app.post("/api/claw/skills/destroy", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      if (!adoptId || !skillId) {
        res.status(400).json({ error: "adoptId and skillId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const listed = await skillRegistry.listSkills(adoptId);
      const skill = listed.ok ? listed.value.find((item) => item.id === skillId) : undefined;
      const result = await skillRegistry.destroy(adoptId, skillId);
      if (!result.ok) {
        res
          .status(registryErrorStatus(result.error.kind))
          .json({ error: result.error.detail, kind: result.error.kind });
        return;
      }
      if (skill?.source.kind === "uploaded") {
        removeSkillPackageIndexRows(adoptId, {
          skillId,
          sourcePath: skill.source.sourcePath,
        });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[skills registry] destroy failed", e);
      res.status(500).json({ error: "delete skill failed" });
    }
  });

  app.post("/api/claw/skills/rename", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      const displayName = String(body.displayName || "").trim();
      if (!adoptId || !skillId || !displayName) {
        res
          .status(400)
          .json({ error: "adoptId, skillId and displayName required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const result = await skillRegistry.rename(adoptId, skillId, displayName);
      if (!result.ok) {
        res
          .status(registryErrorStatus(result.error.kind))
          .json({ error: result.error.detail, kind: result.error.kind });
        return;
      }
      res.json({ item: result.value });
    } catch (e) {
      console.error("[skills registry] rename failed", e);
      res.status(500).json({ error: "rename skill failed" });
    }
  });

}
