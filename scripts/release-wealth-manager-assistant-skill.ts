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
import { runWealthRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";
import { persistReferenceRolePackScenarioReport } from "../server/_core/reference-role-pack-release";
import { digestSkillSourceTree } from "../server/_core/skills/skill-artifact";
import { publishSkillVersionFromSource } from "../server/_core/skills/skill-market-v2-service";
import { releaseRoleDefaultSkillVersion } from "../server/_core/skills/role-default-skill-release";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
import { runWealthRolePackControlledScenarios } from "../server/_core/wealth-role-pack-scenarios";

const ROLE_KEY = "wealth-manager";
const SKILL_ID = "wealth-manager-assistant";
const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SKILL_ROOT = path.join(
  APP_ROOT,
  "examples",
  "skill-quality-evaluation-v1",
  "candidates",
  SKILL_ID,
  "2.1.4"
);

function option(name: string): string {
  const prefix = `--${name}=`;
  return String(process.argv.find(arg => arg.startsWith(prefix)) || "")
    .slice(prefix.length)
    .trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const submitterEmail = option("submitter-email").toLowerCase();
  const approverEmail = option("approver-email").toLowerCase();
  if (!submitterEmail || !approverEmail) {
    throw new Error(
      "--submitter-email=<developer email> and --approver-email=<admin email> are required"
    );
  }

  const [submitter, approver] = await Promise.all([
    getUserByEmail(submitterEmail),
    getUserByEmail(approverEmail),
  ]);
  if (!submitter)
    throw new Error(`Skill submitter not found: ${submitterEmail}`);
  if (!approver || approver.role !== "admin") {
    throw new Error(
      `Skill approver must be an administrator: ${approverEmail}`
    );
  }

  const parsed = parseSkillSourceDirectory(SKILL_ROOT, SKILL_ID);
  if (parsed.skillId !== SKILL_ID || parsed.warnings.length > 0) {
    throw new Error(
      parsed.skillId !== SKILL_ID
        ? `Skill ID mismatch: ${parsed.skillId}`
        : `Skill static scan failed: ${parsed.warnings.join("; ")}`
    );
  }
  const versionName = String(parsed.manifest?.version || "").trim();
  const digest = digestSkillSourceTree(SKILL_ROOT);
  let identity = await getSkillIdentityBySkillId(SKILL_ID);
  if (!identity)
    throw new Error(`Existing Skill identity not found: ${SKILL_ID}`);
  if (
    identity.maintainerType !== "user" ||
    Number(identity.maintainerUserId) !== Number(submitter.id)
  ) {
    throw new Error("Skill submitter does not own the existing Skill identity");
  }
  let version = await getApprovedSkillVersionByIdentityAndVersion(
    identity.identityId,
    versionName
  );

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
  if (!adoptIds.length) {
    throw new Error("At least one target Wealth Manager adoption is required");
  }

  const plan = {
    mode: apply ? "apply" : "dry-run",
    roleKey: ROLE_KEY,
    skillId: SKILL_ID,
    version: versionName,
    artifactSha256: digest.sha256,
    identityId: identity.identityId,
    approvedVersionId: version?.versionId || null,
    submitterEmail,
    submitterUserId: Number(submitter.id),
    approverEmail,
    approverUserId: Number(approver.id),
    adoptIds,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const contract = runWealthRolePackContractChecks();
  const scenario = await runWealthRolePackControlledScenarios();
  if (contract.status !== "PASS" || scenario.status !== "PASS") {
    throw new Error("Wealth Manager Role Pack validation failed");
  }

  if (!version) {
    const publication = await publishSkillVersionFromSource({
      action: "publish_new_version",
      sourcePath: SKILL_ROOT,
      actorUserId: Number(submitter.id),
      isPlatformAdmin: false,
      maintainerType: "user",
      organizationId: identity.organizationId,
      visibility: identity.visibility,
      selectedIdentityId: identity.identityId,
      requestedVersion: versionName,
      changelog:
        "升级访前诊断、配置约束、组合优先的产品映射与客户沟通；严格区分待配置金额、当前持仓和新增资金。",
      authorLabel: parsed.manifest?.author || "李文华",
      sourceOrigin: identity.sourceOrigin,
      category: "finance",
      license: identity.upstreamLicense || "Internal Reference",
      upstreamRepository: identity.upstreamRepository,
    });
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: publication.legacyMarketId,
      status: "approved",
      reviewedBy: Number(approver.id),
      reviewNote:
        "财富专业 A/B、受控场景、Runtime Skill 身份和上海正向演示链路已完成复核。",
    });
    identity = (await getSkillIdentityBySkillId(SKILL_ID))!;
    version = await getApprovedSkillVersionByIdentityAndVersion(
      identity.identityId,
      versionName
    );
  }
  if (!version)
    throw new Error(`Approved version unavailable: ${SKILL_ID}@${versionName}`);
  if (version.artifactSha256 !== digest.sha256) {
    throw new Error(
      `Approved artifact differs from source: ${version.artifactSha256}`
    );
  }

  await updateSkillIdentityPresentation({
    identityId: identity.identityId,
    displayName: parsed.displayName || SKILL_ID,
    description: parsed.description || null,
    category: "finance",
  });
  await persistReferenceRolePackScenarioReport(scenario, contract);
  const released = await releaseRoleDefaultSkillVersion({
    roleKey: ROLE_KEY,
    skillId: SKILL_ID,
    versionId: version.versionId,
    rolePackReleaseId: scenario.releaseCandidateId,
    goldenTaskRunId: `skill-value:${digest.sha256}`,
    providedArtifactSha256: digest.sha256,
    actorUserId: Number(approver.id),
    adoptIds,
  });

  console.log(
    JSON.stringify(
      {
        ...plan,
        approvedVersionId: version.versionId,
        rolePackReleaseId: scenario.releaseCandidateId,
        operationId: released.operationId,
        reconciled: released.reconciled,
        status: "released",
      },
      null,
      2
    )
  );
}

main()
  .then(() => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
