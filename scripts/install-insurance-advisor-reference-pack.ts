import "dotenv/config";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const ROLE_KEY = "insurance-advisor";
const ROLE_PACK_ID = "linggan-insurance.insurance-advisor";
const ACTOR = "insurance-advisor-reference-pack-installer";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(APP_ROOT, "examples", "insurance-advisor-reference-role-pack", "skills");
const PRIMARY_SKILL = {
  id: "auto-insurance-advisor",
  defaultName: "车险顾问岗位助手",
  requiredMcpServers: {
    insurance_customer_profile: ["list_customer_profiles", "get_customer_profile_by_name"],
    insurance_product_exam_points: ["list_products", "search_products", "get_product_detail", "get_exam_points"],
  },
} as const;
const DEFAULT_SKILLS = [PRIMARY_SKILL.id, "insurance-telesales-recommend", "goldencoach-stage-evaluation"];
const OPTIONAL_SKILLS = ["insurance-advisor-pro"];
const DEFAULT_MCP_SERVERS = ["insurance_customer_profile", "insurance_product_exam_points"];

type InstallOptions = { apply: boolean; adoptIds: string[] };
type Baseline = {
  skillRequirements?: Record<string, { servers?: Record<string, readonly string[]> }>;
  industries?: Record<string, { roles?: Record<string, { defaultSkills?: string[]; optionalSkills?: string[]; mcpServers?: string[] }> }>;
};

function parseOptions(argv: string[]): InstallOptions {
  const adoptIds = argv
    .filter((arg) => arg.startsWith("--adopt-id="))
    .flatMap((arg) => arg.slice("--adopt-id=".length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return { apply: argv.includes("--apply"), adoptIds: Array.from(new Set(adoptIds)) };
}

function configuredBaselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  return configured ? path.resolve(configured) : path.join(APP_ROOT, "docs", "design", "role-skill-mcp-baseline.json");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

export function applyInsuranceRolePackBaseline(baseline: Baseline): Baseline {
  const role = baseline.industries?.insurance?.roles?.[ROLE_KEY];
  if (!role) throw new Error(`岗位基线缺少 ${ROLE_KEY}`);
  baseline.skillRequirements ||= {};
  baseline.skillRequirements[PRIMARY_SKILL.id] = { servers: PRIMARY_SKILL.requiredMcpServers };
  const existingDefaults = (role.defaultSkills || []).filter((skillId) => !OPTIONAL_SKILLS.includes(skillId));
  role.defaultSkills = unique([...DEFAULT_SKILLS, ...existingDefaults]);
  role.optionalSkills = unique([...(role.optionalSkills || []), ...OPTIONAL_SKILLS])
    .filter((skillId) => !role.defaultSkills?.includes(skillId));
  role.mcpServers = unique([...(role.mcpServers || []), ...DEFAULT_MCP_SERVERS]);
  return baseline;
}

function updateBaseline(baselineFile: string): boolean {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;
  const before = JSON.stringify(baseline);
  applyInsuranceRolePackBaseline(baseline);
  if (JSON.stringify(baseline) === before) return false;
  const temporary = `${baselineFile}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, baselineFile);
  return true;
}

async function reconcileAdoption(adoptId: string): Promise<{ adoptId: string; changed: number; prunedRetiredDefaults: string[] }> {
  const adoption = await getClawByAdoptId(adoptId);
  if (!adoption) throw new Error(`岗位实例不存在: ${adoptId}`);
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  if (roleTemplate !== ROLE_KEY) throw new Error(`岗位实例 ${adoptId} 属于 ${roleTemplate}，不是 ${ROLE_KEY}`);
  const role = resolveAgentRoleTemplate(roleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  const pruned = await skillRegistry.pruneRetiredRoleDefaults(adoptId, effectiveAssets.skills.default);
  if (!pruned.ok) throw new Error(pruned.error.detail || `岗位实例 ${adoptId} 退役默认技能清理失败`);
  const adapter = getRoleRuntimeAdapter("jiuwenswarm");
  const agentId = resolveRuntimeAgentId(adoptId, String(adoption.agentId || ""));
  const result = await adapter.reconcileSkills({ adoptId, agentId, role, effectiveAssets });
  if (!result.ok) throw new Error(result.reason || `岗位实例 ${adoptId} 技能同步失败`);
  await adapter.refreshCapabilities(adoptId, agentId);
  return { adoptId, changed: Number(result.changed || 0), prunedRetiredDefaults: pruned.value };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sourceDir = path.join(SKILL_ROOT, PRIMARY_SKILL.id);
  if (!existsSync(path.join(sourceDir, "SKILL.md"))) throw new Error(`Reference Skill 不存在: ${sourceDir}`);
  const parsed = parseSkillSourceDirectory(sourceDir, PRIMARY_SKILL.id);
  if (parsed.skillId !== PRIMARY_SKILL.id) throw new Error(`Skill ID 不一致: ${parsed.skillId}`);
  if (parsed.warnings.length > 0) throw new Error(`Reference Skill 安全扫描未通过: ${parsed.warnings.join("；")}`);
  const baselineFile = configuredBaselinePath();
  const targetDir = path.join(skillStoreMarketplaceDir("approved"), PRIMARY_SKILL.id);
  const plan = {
    mode: options.apply ? "apply" : "dry-run",
    rolePackId: ROLE_PACK_ID,
    roleKey: ROLE_KEY,
    skill: { skillId: PRIMARY_SKILL.id, sourceDir, targetDir, requiredMcpServers: PRIMARY_SKILL.requiredMcpServers },
    baselineFile,
    defaultSkills: DEFAULT_SKILLS,
    optionalSkills: OPTIONAL_SKILLS,
    defaultMcpServers: DEFAULT_MCP_SERVERS,
    reconcileAdoptIds: options.adoptIds,
  };
  if (!options.apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("Dry-run only. Add --apply and optional --adopt-id=<lgj-id> to install and refresh an instance.");
    return;
  }

  ensureSkillStoreDirs();
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true, dereference: false });
  const baselineChanged = updateBaseline(baselineFile);

  const rows = await listSkillMarketItems("all");
  const current = rows
    .filter((row) => String(row.skillId) === PRIMARY_SKILL.id && String(row.origin || "") === "finance")
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  const marketPatch = {
    name: parsed.displayName || PRIMARY_SKILL.defaultName,
    description: parsed.description || null,
    author: "灵感保险 Reference Role Pack",
    version: String(parsed.manifest?.version || "1.0.0"),
    category: "finance" as const,
    origin: "finance",
    status: "approved" as const,
    reviewNote: "Reference Role Pack 自动发布；已通过静态安全扫描。",
    license: "Internal Reference",
    packagePath: targetDir,
    roleTag: ROLE_KEY,
    provider: "linggan-insurance",
  };
  const marketId = current
    ? (await updateSkillMarketItem(Number(current.id), marketPatch), Number(current.id))
    : await insertSkillMarketItem({ skillId: PRIMARY_SKILL.id, ...marketPatch });

  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "skill",
    assetId: PRIMARY_SKILL.id,
    grants: [{ roleKey: ROLE_KEY, grantMode: "default" }],
    actor: ACTOR,
  });
  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "skill",
    assetId: "insurance-advisor-pro",
    grants: [{ roleKey: ROLE_KEY, grantMode: "optional" }],
    actor: ACTOR,
  });

  const reconciled = [];
  for (const adoptId of options.adoptIds) reconciled.push(await reconcileAdoption(adoptId));
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
