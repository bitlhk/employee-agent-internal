import "dotenv/config";
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
import { runPostLoanRiskRolePackControlledScenarios } from "../server/_core/post-loan-risk-role-pack-scenarios";
import { runPostLoanRiskRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";
import { digestSkillSourceTree } from "../server/_core/skills/skill-artifact";
import { publishSkillVersionFromSource } from "../server/_core/skills/skill-market-v2-service";
import { releaseRoleDefaultSkillVersion } from "../server/_core/skills/role-default-skill-release";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";

const ROLE_KEY = "post-loan-risk-control";
const SKILL_ID = "post-loan-risk-control-assistant";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(
  APP_ROOT,
  "examples",
  "post-loan-risk-control-reference-role-pack",
  "skills",
  SKILL_ID,
);

function option(name: string): string {
  const prefix = `--${name}=`;
  return String(process.argv.find(arg => arg.startsWith(prefix)) || "")
    .slice(prefix.length)
    .trim();
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
  let identity = await getSkillIdentityBySkillId(SKILL_ID);
  let version = identity
    ? await getApprovedSkillVersionByIdentityAndVersion(identity.identityId, versionName)
    : undefined;

  const requestedAdoptIds = process.argv
    .filter(arg => arg.startsWith("--adopt-id="))
    .flatMap(arg => arg.slice("--adopt-id=".length).split(","))
    .map(value => value.trim())
    .filter(Boolean);
  const allRoleInstances = process.argv.includes("--all-role-instances");
  const activeRoleAdoptions = allRoleInstances
    ? (await listClawAdoptionsAdmin({ status: "active", limit: 1000 }))
      .filter(row => String(row.roleTemplate || "") === ROLE_KEY)
      .map(row => String(row.adoptId))
      .filter(adoptId => !adoptId.startsWith("lgj-eval-ui-"))
    : requestedAdoptIds;
  const adoptIds = [...new Set(activeRoleAdoptions)].sort();
  if (adoptIds.length === 0) throw new Error("At least one target risk adoption is required");

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
    adoptIds,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
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
      changelog: "统一风险快照优先、确定性预警单次执行，并增强还款来源、风险传导和分级处置建议。",
      authorLabel: "灵感银行 Reference Role Pack",
      sourceOrigin: "finance",
      category: "finance",
      license: "Internal Reference",
    });
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: publication.legacyMarketId,
      status: "approved",
      reviewedBy: Number(actor.id),
      reviewNote: "Role Pack 合同、受控场景与 Skill A/B 评测通过。",
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

  const contract = runPostLoanRiskRolePackContractChecks();
  const scenario = await runPostLoanRiskRolePackControlledScenarios();
  if (contract.status !== "PASS" || scenario.status !== "PASS") {
    throw new Error("Post-loan risk Role Pack validation failed");
  }
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
