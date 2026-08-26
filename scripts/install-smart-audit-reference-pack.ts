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
  getApprovedSkillVersionByIdentityAndVersion,
  getSkillIdentityBySkillId,
  getUserByEmail,
  insertSkillMarketItem,
  listSkillMarketItems,
  replaceAdminRoleAssetGrantsForAsset,
  reviewSkillVersionByLegacyMarketId,
  resolveEffectiveRoleAssets,
  syncRoleAssetSeed,
  updateSkillMarketItem,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { digestSkillSourceTree } from "../server/_core/skills/skill-artifact";
import { publishSkillVersionFromSource } from "../server/_core/skills/skill-market-v2-service";
import { releaseRoleDefaultSkillVersion } from "../server/_core/skills/role-default-skill-release";
import { runSmartAuditRolePackControlledScenarios } from "../server/_core/smart-audit-role-pack-scenarios";
import { runSmartAuditRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";

const ROLE_KEY = "credential-compliance";
const ROLE_PACK_ID = "linggan-bank.smart-audit";
const ACTOR = "smart-audit-reference-pack-installer";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_SKILL = {
  id: "smart-audit-assistant",
  defaultName: "智能审核岗位助手",
  requiredMcpServers: {
    credential_image_workspace: ["credential_image_extract_from_workspace"],
    platform_tools: [
      "evaluate_audit_required_materials",
      "evaluate_audit_rule_eligibility",
      "evaluate_audit_human_review",
    ],
    wealth_governance_demo: ["demo_create_audit_review_task"],
  },
} as const;
const SKILL_ROOT = path.join(APP_ROOT, "examples", "smart-audit-reference-role-pack", "skills", PRIMARY_SKILL.id);
const DEFAULT_MCP_SERVERS = ["credential_image_workspace", "platform_tools", "wealth_governance_demo"];
const OPTIONAL_SKILLS = ["credential-prompt-generator", "group-insurance-audit"];
const RETIRED_DEFAULT_MCP_SERVERS = new Set(["credential_skills", "group_insurance_audit"]);

type InstallOptions = {
  apply: boolean;
  adoptIds: string[];
  releaseDefault: boolean;
  actorEmail: string;
};
type Baseline = {
  skillRequirements?: Record<string, { servers?: Record<string, readonly string[]> }>;
  industries?: Record<string, { roles?: Record<string, {
    defaultSkills?: string[];
    optionalSkills?: string[];
    mcpServers?: string[];
  }> }>;
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function parseOptions(argv: string[]): InstallOptions {
  const adoptIds = argv
    .filter((arg) => arg.startsWith("--adopt-id="))
    .flatMap((arg) => arg.slice("--adopt-id=".length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const actorEmail = String(argv.find((arg) => arg.startsWith("--actor-email=")) || "")
    .slice("--actor-email=".length)
    .trim()
    .toLowerCase();
  return {
    apply: argv.includes("--apply"),
    adoptIds: Array.from(new Set(adoptIds)),
    releaseDefault: argv.includes("--release-default"),
    actorEmail,
  };
}

async function releaseDefaultSkill(input: {
  actorEmail: string;
  adoptIds: string[];
}) {
  if (!input.actorEmail) throw new Error("--actor-email=<admin email> is required with --release-default");
  if (input.adoptIds.length === 0) throw new Error("At least one --adopt-id is required with --release-default");
  const actor = await getUserByEmail(input.actorEmail);
  if (!actor || actor.role !== "admin") throw new Error(`Role-default release actor must be an administrator: ${input.actorEmail}`);
  const parsed = parseSkillSourceDirectory(SKILL_ROOT, PRIMARY_SKILL.id);
  const versionName = String(parsed.manifest?.version || "1.0.0");
  const sourceDigest = digestSkillSourceTree(SKILL_ROOT);
  let identity = await getSkillIdentityBySkillId(PRIMARY_SKILL.id);
  let version = identity
    ? await getApprovedSkillVersionByIdentityAndVersion(identity.identityId, versionName)
    : undefined;
  if (!identity) {
    const publication = await publishSkillVersionFromSource({
      action: "create_new_skill",
      sourcePath: SKILL_ROOT,
      actorUserId: Number(actor.id),
      isPlatformAdmin: true,
      maintainerType: "system",
      organizationId: null,
      visibility: "platform",
      requestedVersion: versionName,
      changelog: "智能审核 Reference Role Pack V1 正式岗位预装基线。",
      authorLabel: "GRACE 平台管理员",
      sourceOrigin: "finance",
      category: "finance",
      license: "Internal Reference",
    });
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: publication.legacyMarketId,
      status: "approved",
      reviewedBy: Number(actor.id),
      reviewNote: "受控 Role Pack 合同与 Golden Task 场景通过。",
    });
    identity = await getSkillIdentityBySkillId(PRIMARY_SKILL.id);
    version = identity
      ? await getApprovedSkillVersionByIdentityAndVersion(identity.identityId, versionName)
      : undefined;
  }
  if (!identity || !version) throw new Error(`Approved Skill version is unavailable: ${PRIMARY_SKILL.id}@${versionName}`);
  if (version.artifactSha256 !== sourceDigest.sha256) {
    throw new Error(`Approved Skill artifact differs from source; publish a new semantic version before release: ${PRIMARY_SKILL.id}@${versionName}`);
  }
  const contract = runSmartAuditRolePackContractChecks();
  const scenario = await runSmartAuditRolePackControlledScenarios();
  if (contract.status !== "PASS" || scenario.status !== "PASS") throw new Error("Smart Audit Role Pack validation failed");
  await persistReferenceRolePackScenarioReport(scenario, contract);
  const released = await releaseRoleDefaultSkillVersion({
    roleKey: ROLE_KEY,
    skillId: PRIMARY_SKILL.id,
    versionId: version.versionId,
    rolePackReleaseId: scenario.releaseCandidateId,
    goldenTaskRunId: `controlled:${scenario.releaseCandidateId}`,
    providedArtifactSha256: version.artifactSha256,
    actorUserId: Number(actor.id),
    adoptIds: input.adoptIds,
  });
  return {
    rolePackReleaseId: scenario.releaseCandidateId,
    skillIdentityId: identity.identityId,
    skillVersionId: version.versionId,
    artifactSha256: version.artifactSha256,
    operationId: released.operationId,
    reconciled: released.reconciled,
  };
}

function configuredBaselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  return configured ? path.resolve(configured) : path.join(APP_ROOT, "docs", "design", "role-skill-mcp-baseline.json");
}

export function applySmartAuditRolePackBaseline(baseline: Baseline): Baseline {
  const role = Object.values(baseline.industries || {})
    .map((industry) => industry.roles?.[ROLE_KEY])
    .find(Boolean);
  if (!role) throw new Error(`岗位基线缺少 ${ROLE_KEY}`);

  baseline.skillRequirements ||= {};
  baseline.skillRequirements[PRIMARY_SKILL.id] = {
    servers: PRIMARY_SKILL.requiredMcpServers,
  };
  role.optionalSkills = unique([
    ...(role.optionalSkills || []),
    ...(role.defaultSkills || []).filter((skillId) => skillId !== PRIMARY_SKILL.id),
    ...OPTIONAL_SKILLS,
  ]);
  role.defaultSkills = [PRIMARY_SKILL.id];
  role.mcpServers = unique([
    ...(role.mcpServers || []).filter((serverId) => !RETIRED_DEFAULT_MCP_SERVERS.has(serverId)),
    ...DEFAULT_MCP_SERVERS,
  ]);
  return baseline;
}

function updateBaseline(file: string): boolean {
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  const before = JSON.stringify(baseline);
  applySmartAuditRolePackBaseline(baseline);
  if (JSON.stringify(baseline) === before) return false;
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

async function reconcileAdoption(adoptId: string): Promise<{
  adoptId: string;
  changed: number;
  prunedRetiredDefaults: string[];
}> {
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
  return {
    adoptId,
    changed: Number(result.changed || 0),
    prunedRetiredDefaults: pruned.value,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!existsSync(path.join(SKILL_ROOT, "SKILL.md"))) throw new Error(`Reference Skill 不存在: ${SKILL_ROOT}`);
  const parsed = parseSkillSourceDirectory(SKILL_ROOT, PRIMARY_SKILL.id);
  if (parsed.skillId !== PRIMARY_SKILL.id) throw new Error(`Skill ID 不一致: ${parsed.skillId}`);
  if (parsed.warnings.length) throw new Error(`Reference Skill 安全扫描未通过: ${parsed.warnings.join("；")}`);

  const baselineFile = configuredBaselinePath();
  const targetDir = path.join(skillStoreMarketplaceDir("approved"), PRIMARY_SKILL.id);
  const plan = {
    mode: options.apply ? "apply" : "dry-run",
    releaseStage: "reference_ready",
    rolePackId: ROLE_PACK_ID,
    roleKey: ROLE_KEY,
    skill: {
      skillId: PRIMARY_SKILL.id,
      sourceDir: SKILL_ROOT,
      targetDir,
      requiredMcpServers: PRIMARY_SKILL.requiredMcpServers,
    },
    baselineFile,
    defaultSkillPolicy: "smart-audit-only",
    defaultMcpServers: DEFAULT_MCP_SERVERS,
    reconcileAdoptIds: options.adoptIds,
    releaseDefault: options.releaseDefault,
    actorEmail: options.actorEmail || null,
  };
  if (!options.apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("Dry-run only. Add --apply and optional --release-default --actor-email=<admin> --adopt-id=<lgj-id>.");
    return;
  }

  ensureSkillStoreDirs();
  mkdirSync(targetDir, { recursive: true });
  cpSync(SKILL_ROOT, targetDir, { recursive: true, force: true, dereference: false });
  const baselineChanged = updateBaseline(baselineFile);
  const seedPlan = await syncRoleAssetSeed();

  const rows = await listSkillMarketItems("all");
  const current = rows
    .filter((row) => String(row.skillId) === PRIMARY_SKILL.id && String(row.origin || "") === "finance")
    .sort((left, right) => Number(right.id) - Number(left.id))[0];
  const marketPatch = {
    name: parsed.displayName || PRIMARY_SKILL.defaultName,
    description: parsed.description || null,
    author: "灵感银行 Smart Audit Candidate",
    version: String(parsed.manifest?.version || "1.0.0"),
    category: "finance" as const,
    origin: "finance",
    status: "approved" as const,
    reviewNote: "智能审核受控最小主路由；已通过静态安全扫描。完整 Role Pack 尚待 Policy 与 Eval 验收。",
    license: "Internal Reference",
    packagePath: targetDir,
    roleTag: ROLE_KEY,
    provider: "linggan-bank",
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

  const reconciled = [];
  for (const adoptId of options.adoptIds) reconciled.push(await reconcileAdoption(adoptId));
  const formalRelease = options.releaseDefault
    ? await releaseDefaultSkill({ actorEmail: options.actorEmail, adoptIds: options.adoptIds })
    : null;
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
    metadata: {
      marketId,
      baselineChanged,
      defaultSkillPolicy: "smart-audit-only",
      seedDesired: seedPlan.desired.length,
      seedPruned: seedPlan.prune.length,
      reconciled,
      formalRelease,
    },
  });
  console.log(JSON.stringify({
    ...plan,
    marketId,
    baselineChanged,
    seedDesired: seedPlan.desired.length,
    seedPruned: seedPlan.prune.length,
    reconciled,
    formalRelease,
  }, null, 2));
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
