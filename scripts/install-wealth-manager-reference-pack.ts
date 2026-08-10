import "dotenv/config";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordAuditBestEffort } from "../server/_core/audit-events";
import { resolveRuntimeAgentId } from "../server/_core/helpers";
import { resolveAgentRoleTemplate } from "../server/_core/role-templates";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
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

const ROLE_KEY = "wealth-manager";
const ACTOR = "wealth-manager-reference-pack-installer";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(APP_ROOT, "examples", "wealth-manager-reference-role-pack", "skills");
const SKILLS = [
  {
    id: "privbank-previsit",
    defaultName: "财富客户访前准备",
    requiredMcpServers: {
      wealth_assistant_customer: [
        "wealth_assistant_context_probe",
        "wealth_assistant_customer_list",
        "wealth_assistant_customer_detail",
      ],
      platform_tools: ["get_wealth_policy_basis"],
    },
  },
  {
    id: "wealth-manager-assistant",
    defaultName: "客户经理财富助手",
    requiredMcpServers: {
      wealth_assistant_customer: [
        "wealth_assistant_context_probe",
        "wealth_assistant_customer_list",
        "wealth_assistant_customer_detail",
      ],
      platform_tools: [
        "get_wealth_policy_basis",
        "prepare_wealth_maturity_context",
        "prepare_wealth_allocation_context",
      ],
    },
  },
] as const;

type InstallOptions = {
  apply: boolean;
  adoptIds: string[];
};

function parseOptions(argv: string[]): InstallOptions {
  const adoptIds = argv
    .filter((arg) => arg.startsWith("--adopt-id="))
    .flatMap((arg) => arg.slice("--adopt-id=".length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    apply: argv.includes("--apply"),
    adoptIds: Array.from(new Set(adoptIds)),
  };
}

function configuredBaselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  return configured
    ? path.resolve(configured)
    : path.join(APP_ROOT, "docs", "design", "role-skill-mcp-baseline.json");
}

function updateSkillReadinessRequirements(baselineFile: string): boolean {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as {
    skillRequirements?: Record<string, { servers?: Record<string, string[]> }>;
  };
  baseline.skillRequirements ||= {};
  let changed = false;
  for (const skill of SKILLS) {
    const next = { servers: skill.requiredMcpServers };
    if (JSON.stringify(baseline.skillRequirements[skill.id]) === JSON.stringify(next)) continue;
    baseline.skillRequirements[skill.id] = next;
    changed = true;
  }
  if (!changed) return false;
  const temporary = `${baselineFile}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, baselineFile);
  return true;
}

async function reconcileAdoption(adoptId: string): Promise<{ adoptId: string; changed: number }> {
  const adoption = await getClawByAdoptId(adoptId);
  if (!adoption) throw new Error(`岗位实例不存在: ${adoptId}`);
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  if (roleTemplate !== ROLE_KEY) {
    throw new Error(`岗位实例 ${adoptId} 属于 ${roleTemplate}，不是 ${ROLE_KEY}`);
  }

  const role = resolveAgentRoleTemplate(roleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  const adapter = getRoleRuntimeAdapter("jiuwenswarm");
  const agentId = resolveRuntimeAgentId(adoptId, String(adoption.agentId || ""));
  const result = await adapter.reconcileSkills({ adoptId, agentId, role, effectiveAssets });
  if (!result.ok) throw new Error(result.reason || `岗位实例 ${adoptId} 技能同步失败`);
  await adapter.refreshCapabilities(adoptId, agentId);
  return { adoptId, changed: Number(result.changed || 0) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const parsedSkills = SKILLS.map((skill) => {
    const sourceDir = path.join(SKILL_ROOT, skill.id);
    if (!existsSync(path.join(sourceDir, "SKILL.md"))) throw new Error(`Reference Skill 不存在: ${sourceDir}`);
    const parsed = parseSkillSourceDirectory(sourceDir, skill.id);
    if (parsed.skillId !== skill.id) throw new Error(`Skill ID 不一致: expected=${skill.id}, actual=${parsed.skillId}`);
    if (parsed.warnings.length > 0) throw new Error(`Reference Skill ${skill.id} 安全扫描未通过: ${parsed.warnings.join("；")}`);
    return { ...skill, sourceDir, parsed, targetDir: path.join(skillStoreMarketplaceDir("approved"), skill.id) };
  });
  const baselineFile = configuredBaselinePath();
  const plan = {
    mode: options.apply ? "apply" : "dry-run",
    roleKey: ROLE_KEY,
    skills: parsedSkills.map((skill) => ({
      skillId: skill.id,
      version: String(skill.parsed.manifest?.version || "1.0.0"),
      sourceDir: skill.sourceDir,
      targetDir: skill.targetDir,
      requiredMcpServers: skill.requiredMcpServers,
    })),
    baselineFile,
    grantMode: "default",
    reconcileAdoptIds: options.adoptIds,
  };
  if (!options.apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("Dry-run only. Add --apply and optional --adopt-id=<lgj-id> to install and refresh an instance.");
    return;
  }

  ensureSkillStoreDirs();
  for (const skill of parsedSkills) {
    mkdirSync(skill.targetDir, { recursive: true });
    cpSync(skill.sourceDir, skill.targetDir, { recursive: true, force: true, dereference: false });
  }
  const baselineChanged = updateSkillReadinessRequirements(baselineFile);

  const rows = await listSkillMarketItems("all");
  const installedSkills = [];
  for (const skill of parsedSkills) {
    const current = rows
      .filter((row) => String(row.skillId) === skill.id && String(row.origin || "") === "finance")
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    const marketPatch = {
      name: skill.parsed.displayName || skill.defaultName,
      description: skill.parsed.description || null,
      author: "灵感银行 Reference Role Pack",
      version: String(skill.parsed.manifest?.version || "1.0.0"),
      category: "finance" as const,
      origin: "finance",
      status: "approved" as const,
      reviewNote: "Reference Role Pack 自动发布；已通过静态安全扫描。",
      license: "Internal Reference",
      packagePath: skill.targetDir,
      roleTag: ROLE_KEY,
      provider: "linggan-bank",
    };
    const marketId = current
      ? (await updateSkillMarketItem(Number(current.id), marketPatch), Number(current.id))
      : await insertSkillMarketItem({ skillId: skill.id, ...marketPatch });
    await replaceAdminRoleAssetGrantsForAsset({
      assetType: "skill",
      assetId: skill.id,
      grants: [{ roleKey: ROLE_KEY, grantMode: "default" }],
      actor: ACTOR,
    });
    installedSkills.push({ skillId: skill.id, version: marketPatch.version, marketId });
  }

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
    resourceId: "linggan-bank.wealth-manager",
    source: "deployment_script",
    metadata: { installedSkills, baselineChanged, reconciled },
  });

  console.log(JSON.stringify({ ...plan, installedSkills, baselineChanged, reconciled }, null, 2));
}

main()
  .then(async () => {
    // The pool initializes session timezone asynchronously on first connection.
    // Let that callback drain before closing this short-lived CLI process.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await closeDbConnection();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
