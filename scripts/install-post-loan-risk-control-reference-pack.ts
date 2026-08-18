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

const ROLE_KEY = "post-loan-risk-control";
const ROLE_PACK_ID = "linggan-bank.post-loan-risk-control";
const ACTOR = "post-loan-risk-control-reference-pack-installer";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ID = "post-loan-risk-control-assistant";
const SKILL_ROOT = path.join(APP_ROOT, "examples", "post-loan-risk-control-reference-role-pack", "skills", SKILL_ID);
const RISK_DATA_TOOLS = [
  "get_enterprise_profile",
  "get_loan_account",
  "get_financial_statements",
  "get_repayment_history",
  "get_collateral_info",
  "get_guarantor_info",
  "get_credit_rating",
  "get_judicial_info",
  "get_public_opinion",
  "get_business_abnormal",
  "get_tax_info",
  "get_dishonest_record",
  "get_industry_benchmark",
  "get_industry_rating",
  "get_macro_indicator",
] as const;
const DEFAULT_SKILLS = [SKILL_ID, "post-loan-risk-prediction"];
const DEFAULT_MCP_SERVERS = ["post_loan_risk_data", "platform_tools", "wealth_governance_demo"];

type Baseline = {
  skillRequirements?: Record<string, { servers?: Record<string, readonly string[]> }>;
  industries?: Record<string, { roles?: Record<string, { defaultSkills?: string[]; optionalSkills?: string[]; mcpServers?: string[] }> }>;
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

export function applyPostLoanRiskRolePackBaseline(baseline: Baseline): Baseline {
  const role = Object.values(baseline.industries || {})
    .map((industry) => industry.roles?.[ROLE_KEY])
    .find(Boolean);
  if (!role) throw new Error(`岗位基线缺少 ${ROLE_KEY}`);
  baseline.skillRequirements ||= {};
  baseline.skillRequirements[SKILL_ID] = {
    servers: {
      post_loan_risk_data: RISK_DATA_TOOLS,
      platform_tools: ["evaluate_post_loan_risk_escalation"],
      wealth_governance_demo: ["demo_create_followup_task"],
    },
  };
  role.defaultSkills = unique([...DEFAULT_SKILLS, ...(role.defaultSkills || [])]);
  role.mcpServers = unique([...DEFAULT_MCP_SERVERS, ...(role.mcpServers || [])]);
  return baseline;
}

function configuredBaselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  return configured ? path.resolve(configured) : path.join(APP_ROOT, "docs", "design", "role-skill-mcp-baseline.json");
}

function updateBaseline(file: string): boolean {
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  const before = JSON.stringify(baseline);
  applyPostLoanRiskRolePackBaseline(baseline);
  if (JSON.stringify(baseline) === before) return false;
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

function parseAdoptIds(argv: string[]): string[] {
  return Array.from(new Set(argv
    .filter((arg) => arg.startsWith("--adopt-id="))
    .flatMap((arg) => arg.slice("--adopt-id=".length).split(","))
    .map((value) => value.trim())
    .filter(Boolean)));
}

async function reconcileAdoption(adoptId: string) {
  const adoption = await getClawByAdoptId(adoptId);
  if (!adoption) throw new Error(`岗位实例不存在: ${adoptId}`);
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  if (roleTemplate !== ROLE_KEY) throw new Error(`岗位实例 ${adoptId} 属于 ${roleTemplate}，不是 ${ROLE_KEY}`);
  const role = resolveAgentRoleTemplate(roleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  const pruned = await skillRegistry.pruneRetiredRoleDefaults(adoptId, effectiveAssets.skills.default);
  if (!pruned.ok) throw new Error(pruned.error.detail || `岗位实例 ${adoptId} 默认技能清理失败`);
  const adapter = getRoleRuntimeAdapter("jiuwenswarm");
  const agentId = resolveRuntimeAgentId(adoptId, String(adoption.agentId || ""));
  const result = await adapter.reconcileSkills({ adoptId, agentId, role, effectiveAssets });
  if (!result.ok) throw new Error(result.reason || `岗位实例 ${adoptId} 技能同步失败`);
  await adapter.refreshCapabilities(adoptId, agentId);
  return { adoptId, changed: Number(result.changed || 0), prunedRetiredDefaults: pruned.value };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const adoptIds = parseAdoptIds(process.argv.slice(2));
  if (!existsSync(path.join(SKILL_ROOT, "SKILL.md"))) throw new Error(`Reference Skill 不存在: ${SKILL_ROOT}`);
  const parsed = parseSkillSourceDirectory(SKILL_ROOT, SKILL_ID);
  if (parsed.skillId !== SKILL_ID) throw new Error(`Skill ID 不一致: ${parsed.skillId}`);
  if (parsed.warnings.length) throw new Error(`Reference Skill 安全扫描未通过: ${parsed.warnings.join("；")}`);
  const targetDir = path.join(skillStoreMarketplaceDir("approved"), SKILL_ID);
  const baselineFile = configuredBaselinePath();
  const plan = {
    mode: apply ? "apply" : "dry-run",
    rolePackId: ROLE_PACK_ID,
    roleKey: ROLE_KEY,
    skill: { skillId: SKILL_ID, sourceDir: SKILL_ROOT, targetDir },
    defaultSkills: DEFAULT_SKILLS,
    defaultMcpServers: DEFAULT_MCP_SERVERS,
    requiredRiskDataTools: RISK_DATA_TOOLS,
    baselineFile,
    reconcileAdoptIds: adoptIds,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("Dry-run only. Add --apply and optional --adopt-id=<lgj-id> to install and refresh an instance.");
    return;
  }

  ensureSkillStoreDirs();
  mkdirSync(targetDir, { recursive: true });
  cpSync(SKILL_ROOT, targetDir, { recursive: true, force: true, dereference: false });
  const baselineChanged = updateBaseline(baselineFile);
  const rows = await listSkillMarketItems("all");
  const current = rows
    .filter((row) => String(row.skillId) === SKILL_ID && String(row.origin || "") === "finance")
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  const marketPatch = {
    name: parsed.displayName || "贷后风控岗位助手",
    description: parsed.description || null,
    author: "灵感银行 Reference Role Pack",
    version: String(parsed.manifest?.version || "1.0.0"),
    category: "finance" as const,
    origin: "finance",
    status: "approved" as const,
    reviewNote: "Reference Role Pack 自动发布；已通过静态安全扫描。",
    license: "Internal Reference",
    packagePath: targetDir,
    roleTag: ROLE_KEY,
    provider: "linggan-bank",
  };
  const marketId = current
    ? (await updateSkillMarketItem(Number(current.id), marketPatch), Number(current.id))
    : await insertSkillMarketItem({ skillId: SKILL_ID, ...marketPatch });
  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "skill",
    assetId: SKILL_ID,
    grants: [{ roleKey: ROLE_KEY, grantMode: "default" }],
    actor: ACTOR,
  });
  const reconciled = [];
  for (const adoptId of adoptIds) reconciled.push(await reconcileAdoption(adoptId));
  await recordAuditBestEffort({
    action: "role_pack.reference_asset.installed",
    result: "success",
    severity: "medium",
    actorType: "system",
    actorName: ACTOR,
    targetType: "role_template",
    targetId: ROLE_KEY,
    resourceType: "skill",
    resourceId: ROLE_PACK_ID,
    source: "deployment_script",
    metadata: { marketId, baselineChanged, reconciled },
  });
  console.log(JSON.stringify({ ...plan, marketId, baselineChanged, reconciled }, null, 2));
}

const isDirectExecution = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  main()
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await closeDbConnection();
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      await closeDbConnection().catch(() => undefined);
    });
}
