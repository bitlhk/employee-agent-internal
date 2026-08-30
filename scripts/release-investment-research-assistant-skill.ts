import "dotenv/config";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getApprovedSkillVersionByIdentityAndVersion,
  getSkillIdentityBySkillId,
  getUserByEmail,
  listClawAdoptionsAdmin,
  reviewSkillVersionByLegacyMarketId,
  updateSkillIdentityPresentation,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { runInvestmentResearchRolePackControlledScenarios } from "../server/_core/investment-research-role-pack-scenarios";
import { runInvestmentResearchRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";
import { digestSkillSourceTree } from "../server/_core/skills/skill-artifact";
import { publishSkillVersionFromSource } from "../server/_core/skills/skill-market-v2-service";
import { releaseRoleDefaultSkillVersion } from "../server/_core/skills/role-default-skill-release";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
import { applyInvestmentResearchRolePackBaseline } from "./install-investment-research-reference-pack";

const ROLE_KEY = "investment-researcher";
const SKILL_ID = "investment-research-assistant";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(
  APP_ROOT,
  "examples",
  "investment-research-reference-role-pack",
  "skills",
  SKILL_ID,
);

function option(name: string): string {
  const prefix = `--${name}=`;
  return String(process.argv.find(arg => arg.startsWith(prefix)) || "")
    .slice(prefix.length)
    .trim();
}

function baselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  return configured
    ? path.resolve(configured)
    : path.join(APP_ROOT, "docs", "design", "role-skill-mcp-baseline.json");
}

function applyBaseline(file: string): boolean {
  const baseline = JSON.parse(readFileSync(file, "utf8"));
  const before = JSON.stringify(baseline);
  applyInvestmentResearchRolePackBaseline(baseline);
  if (JSON.stringify(baseline) === before) return false;
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const actorEmail = option("actor-email").toLowerCase();
  if (!actorEmail) throw new Error("--actor-email=<admin email> is required");

  const actor = await getUserByEmail(actorEmail);
  if (!actor || actor.role !== "admin") {
    throw new Error(`Role-default release actor must be an administrator: ${actorEmail}`);
  }

  const parsed = parseSkillSourceDirectory(SKILL_ROOT, SKILL_ID);
  if (parsed.skillId !== SKILL_ID || parsed.warnings.length > 0) {
    throw new Error(
      parsed.skillId !== SKILL_ID
        ? `Skill ID mismatch: ${parsed.skillId}`
        : `Skill static scan failed: ${parsed.warnings.join("; ")}`,
    );
  }
  const versionName = String(parsed.manifest?.version || "").trim();
  const digest = digestSkillSourceTree(SKILL_ROOT);
  const targetBaseline = baselinePath();
  let identity = await getSkillIdentityBySkillId(SKILL_ID);
  let version = identity
    ? await getApprovedSkillVersionByIdentityAndVersion(identity.identityId, versionName)
    : undefined;

  const requestedAdoptIds = process.argv
    .filter(arg => arg.startsWith("--adopt-id="))
    .flatMap(arg => arg.slice("--adopt-id=".length).split(","))
    .map(value => value.trim())
    .filter(Boolean);
  const activeRoleAdoptions = process.argv.includes("--all-role-instances")
    ? (await listClawAdoptionsAdmin({ status: "active", limit: 1000 }))
      .filter(row => String(row.roleTemplate || "") === ROLE_KEY)
      .map(row => String(row.adoptId))
      .filter(adoptId => !adoptId.startsWith("lgj-eval-ui-"))
    : requestedAdoptIds;
  const adoptIds = [...new Set(activeRoleAdoptions)].sort();

  const plan = {
    mode: apply ? "apply" : "dry-run",
    roleKey: ROLE_KEY,
    skillId: SKILL_ID,
    version: versionName,
    artifactSha256: digest.sha256,
    identityId: identity?.identityId || null,
    approvedVersionId: version?.versionId || null,
    actorEmail,
    actorUserId: Number(actor.id),
    baselineFile: targetBaseline,
    adoptIds,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const contract = runInvestmentResearchRolePackContractChecks();
  const scenario = await runInvestmentResearchRolePackControlledScenarios();
  if (contract.status !== "PASS" || scenario.status !== "PASS") {
    throw new Error("Investment Research Role Pack validation failed");
  }

  if (!version) {
    const publication = await publishSkillVersionFromSource({
      action: identity ? "publish_new_version" : "create_new_skill",
      sourcePath: SKILL_ROOT,
      actorUserId: Number(actor.id),
      isPlatformAdmin: true,
      maintainerType: "system",
      organizationId: null,
      visibility: "platform",
      ...(identity ? { selectedIdentityId: identity.identityId } : {}),
      requestedVersion: versionName,
      changelog: "升级公司研究、财报质量、估值事件和研究表达方法，突出盈利驱动、反证、失效条件和可执行跟踪项。",
      authorLabel: "灵感金融 Investment Research Role Pack",
      sourceOrigin: "finance",
      category: "finance",
      license: "Internal Reference",
    });
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: publication.legacyMarketId,
      status: "approved",
      reviewedBy: Number(actor.id),
      reviewNote: "投顾分析 Role Pack 合同、受控场景和同模型 Skill 业务对照已完成。",
    });
    identity = await getSkillIdentityBySkillId(SKILL_ID);
    version = identity
      ? await getApprovedSkillVersionByIdentityAndVersion(identity.identityId, versionName)
      : undefined;
  }
  if (!identity || !version) throw new Error(`Approved version unavailable: ${SKILL_ID}@${versionName}`);
  if (version.artifactSha256 !== digest.sha256) {
    throw new Error(`Approved artifact differs from source: ${version.artifactSha256}`);
  }

  await updateSkillIdentityPresentation({
    identityId: identity.identityId,
    displayName: parsed.displayName || SKILL_ID,
    description: parsed.description || null,
    category: "finance",
  });
  const baselineChanged = applyBaseline(targetBaseline);
  await persistReferenceRolePackScenarioReport(scenario, contract);
  const released = await releaseRoleDefaultSkillVersion({
    roleKey: ROLE_KEY,
    skillId: SKILL_ID,
    versionId: version.versionId,
    rolePackReleaseId: scenario.releaseCandidateId,
    goldenTaskRunId: `skill-value:${digest.sha256}`,
    providedArtifactSha256: digest.sha256,
    actorUserId: Number(actor.id),
    adoptIds,
  });

  console.log(JSON.stringify({
    ...plan,
    identityId: identity.identityId,
    approvedVersionId: version.versionId,
    baselineChanged,
    rolePackReleaseId: scenario.releaseCandidateId,
    operationId: released.operationId,
    reconciled: released.reconciled,
    status: "released",
  }, null, 2));
}

main()
  .then(() => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
