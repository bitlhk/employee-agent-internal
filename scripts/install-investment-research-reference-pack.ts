import "dotenv/config";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordAuditBestEffort } from "../server/_core/audit-events";
import { resolveRuntimeAgentId } from "../server/_core/helpers";
import { resolveAgentRoleTemplate } from "../server/_core/role-templates";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
import { skillRegistry } from "../server/_core/skills/skill-registry";
import { ensureSkillStoreDirs, skillStoreMarketplaceDir } from "../server/_core/skills/skill-store";
import { getRoleRuntimeAdapter } from "../server/routers/role-runtime-adapters";
import {
  getClawByAdoptId,
  insertSkillMarketItem,
  listSkillMarketItems,
  replaceAdminRoleAssetGrantsForAsset,
  resolveEffectiveRoleAssets,
  updateSkillMarketItem,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";

const ROLE_KEY = "investment-researcher";
const ROLE_PACK_ID = "linggan-finance.investment-research";
const ACTOR = "investment-research-reference-pack-installer";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_SKILL = {
  id: "investment-research-assistant",
  defaultName: "投顾分析岗位助手",
  requiredMcpServers: {
    wind_stock_data: ["get_stock_basicinfo", "get_stock_fundamentals", "get_stock_price_indicators", "get_risk_metrics"],
    wind_financial_docs: ["get_company_announcements", "get_financial_news"],
  },
} as const;
const SKILL_ROOT = path.join(APP_ROOT, "examples", "investment-research-reference-role-pack", "skills", PRIMARY_SKILL.id);
const DEFAULT_MCP_SERVERS = ["wind_stock_data", "wind_financial_docs", "wind_analytics_data", "platform_tools", "wealth_governance_demo"];

type Baseline = {
  skillRequirements?: Record<string, { servers?: Record<string, readonly string[]> }>;
  industries?: Record<string, { roles?: Record<string, { defaultSkills?: string[]; optionalSkills?: string[]; mcpServers?: string[] }> }>;
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

export function applyInvestmentResearchRolePackBaseline(baseline: Baseline): Baseline {
  const role = Object.values(baseline.industries || {}).map((industry) => industry.roles?.[ROLE_KEY]).find(Boolean);
  if (!role) throw new Error(`岗位基线缺少 ${ROLE_KEY}`);
  baseline.skillRequirements ||= {};
  baseline.skillRequirements[PRIMARY_SKILL.id] = { servers: PRIMARY_SKILL.requiredMcpServers };
  role.defaultSkills = unique([PRIMARY_SKILL.id, ...(role.defaultSkills || [])]);
  role.mcpServers = unique([...(role.mcpServers || []), ...DEFAULT_MCP_SERVERS]);
  return baseline;
}

function baselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  return configured ? path.resolve(configured) : path.join(APP_ROOT, "docs", "design", "role-skill-mcp-baseline.json");
}

function updateBaseline(file: string): boolean {
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  const before = JSON.stringify(baseline);
  applyInvestmentResearchRolePackBaseline(baseline);
  if (JSON.stringify(baseline) === before) return false;
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

async function reconcile(adoptId: string) {
  const adoption = await getClawByAdoptId(adoptId);
  if (!adoption) throw new Error(`岗位实例不存在: ${adoptId}`);
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  if (roleTemplate !== ROLE_KEY) throw new Error(`岗位实例 ${adoptId} 属于 ${roleTemplate}，不是 ${ROLE_KEY}`);
  const role = resolveAgentRoleTemplate(roleTemplate);
  const assets = await resolveEffectiveRoleAssets(role.id);
  const pruned = await skillRegistry.pruneRetiredRoleDefaults(adoptId, assets.skills.default);
  if (!pruned.ok) throw new Error(pruned.error.detail || `岗位实例 ${adoptId} 默认技能清理失败`);
  const adapter = getRoleRuntimeAdapter("jiuwenswarm");
  const agentId = resolveRuntimeAgentId(adoptId, String(adoption.agentId || ""));
  const result = await adapter.reconcileSkills({ adoptId, agentId, role, effectiveAssets: assets });
  if (!result.ok) throw new Error(result.reason || `岗位实例 ${adoptId} 技能同步失败`);
  await adapter.refreshCapabilities(adoptId, agentId);
  return { adoptId, changed: Number(result.changed || 0), prunedRetiredDefaults: pruned.value };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const adoptIds = Array.from(new Set(process.argv.filter((arg) => arg.startsWith("--adopt-id=")).flatMap((arg) => arg.slice(11).split(",")).filter(Boolean)));
  if (!existsSync(path.join(SKILL_ROOT, "SKILL.md"))) throw new Error(`Reference Skill 不存在: ${SKILL_ROOT}`);
  const parsed = parseSkillSourceDirectory(SKILL_ROOT, PRIMARY_SKILL.id);
  if (parsed.warnings.length) throw new Error(`Reference Skill 安全扫描未通过: ${parsed.warnings.join("；")}`);
  const file = baselinePath();
  const targetDir = path.join(skillStoreMarketplaceDir("approved"), PRIMARY_SKILL.id);
  const plan = { mode: apply ? "apply" : "dry-run", releaseStage: "reference_ready", rolePackId: ROLE_PACK_ID, roleKey: ROLE_KEY, skillId: PRIMARY_SKILL.id, sourceDir: SKILL_ROOT, targetDir, baselineFile: file, additiveOnly: true, defaultMcpServers: DEFAULT_MCP_SERVERS, reconcileAdoptIds: adoptIds };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("Dry-run only. Add --apply and optional --adopt-id=<lgj-id> to publish and refresh an instance.");
    return;
  }
  ensureSkillStoreDirs();
  mkdirSync(targetDir, { recursive: true });
  cpSync(SKILL_ROOT, targetDir, { recursive: true, force: true, dereference: false });
  const baselineChanged = updateBaseline(file);
  const current = (await listSkillMarketItems("all")).filter((row) => String(row.skillId) === PRIMARY_SKILL.id && String(row.origin || "") === "finance").sort((a, b) => Number(b.id) - Number(a.id))[0];
  const patch = { name: parsed.displayName || PRIMARY_SKILL.defaultName, description: parsed.description || null, author: "灵感金融 Investment Research", version: String(parsed.manifest?.version || "1.0.0"), category: "finance" as const, origin: "finance", status: "approved" as const, reviewNote: "投顾分析受控主路由；动态事实仅来自当前授权 Wind MCP。", license: "Internal Reference", packagePath: targetDir, roleTag: ROLE_KEY, provider: "linggan-finance" };
  const marketId = current ? (await updateSkillMarketItem(Number(current.id), patch), Number(current.id)) : await insertSkillMarketItem({ skillId: PRIMARY_SKILL.id, ...patch });
  await replaceAdminRoleAssetGrantsForAsset({ assetType: "skill", assetId: PRIMARY_SKILL.id, grants: [{ roleKey: ROLE_KEY, grantMode: "default" }], actor: ACTOR });
  const reconciled = [];
  for (const adoptId of adoptIds) reconciled.push(await reconcile(adoptId));
  await recordAuditBestEffort({ action: "role_pack.reference_asset.installed", result: "success", severity: "medium", actorType: "system", actorName: ACTOR, targetType: "role_template", targetId: ROLE_KEY, resourceType: "skill", resourceId: ROLE_PACK_ID, source: "deployment_script", metadata: { marketId, baselineChanged, additiveOnly: true, reconciled } });
  console.log(JSON.stringify({ ...plan, marketId, baselineChanged, reconciled }, null, 2));
}

if (Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then(async () => {
      // Allow best-effort audit writes to drain before closing the shared pool.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await closeDbConnection();
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      await closeDbConnection().catch(() => undefined);
    });
}
