import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getApprovedSkillVersionByIdentityAndVersion,
  getSkillIdentityBySkillId,
  getUserByEmail,
  reviewSkillVersionByLegacyMarketId,
  updateSkillIdentityPresentation,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { digestSkillSourceTree } from "../server/_core/skills/skill-artifact";
import { publishSkillVersionFromSource } from "../server/_core/skills/skill-market-v2-service";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";

const SKILL_ID = "goldencoach-stage-evaluation";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(
  APP_ROOT,
  "examples",
  "insurance-advisor-reference-role-pack",
  "skills",
  SKILL_ID,
);
const SHANGHAI_EVIDENCE_JOB_IDS = [
  "skill-eval-e92b247b5325-mtmsrt4t",
  "skill-eval-f348a4788686-mtmswqhx",
  "skill-eval-87a696ff98a8-mtmt1qjh",
];

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
      "--submitter-email=<maintainer email> and --approver-email=<admin email> are required",
    );
  }

  const [submitter, approver] = await Promise.all([
    getUserByEmail(submitterEmail),
    getUserByEmail(approverEmail),
  ]);
  if (!submitter) throw new Error(`Skill submitter not found: ${submitterEmail}`);
  if (!approver || approver.role !== "admin") {
    throw new Error(`Skill approver must be an administrator: ${approverEmail}`);
  }
  if (Number(submitter.id) === Number(approver.id)) {
    throw new Error("Skill submitter and approver must be different users");
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
  if (!identity) throw new Error(`Existing Skill identity not found: ${SKILL_ID}`);
  if (
    identity.maintainerType !== "user"
    || Number(identity.maintainerUserId) !== Number(submitter.id)
  ) {
    throw new Error("Skill submitter does not own the existing Skill identity");
  }

  let version = await getApprovedSkillVersionByIdentityAndVersion(
    identity.identityId,
    versionName,
  );
  const plan = {
    mode: apply ? "apply" : "dry-run",
    skillId: SKILL_ID,
    version: versionName,
    artifactSha256: digest.sha256,
    identityId: identity.identityId,
    approvedVersionId: version?.versionId || null,
    submitterEmail,
    submitterUserId: Number(submitter.id),
    approverEmail,
    approverUserId: Number(approver.id),
    evidenceJobIds: SHANGHAI_EVIDENCE_JOB_IDS,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
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
        "按任务意图区分聚焦阶段点评与完整训练评估，减少短对话过度评分和无依据客户画像，并提升下一轮问题的决策价值。",
      authorLabel: identity.upstreamAuthor || "赵印伟",
      sourceOrigin: identity.sourceOrigin,
      category: identity.category,
      license: identity.upstreamLicense || "内部共享",
      upstreamRepository: identity.upstreamRepository,
    });
    await reviewSkillVersionByLegacyMarketId({
      legacyMarketId: publication.legacyMarketId,
      status: "approved",
      reviewedBy: Number(approver.id),
      reviewNote:
        `同模型 A/B 已在上海完成 3/3 胜出；证据任务：${SHANGHAI_EVIDENCE_JOB_IDS.join(", ")}。`,
    });
    identity = (await getSkillIdentityBySkillId(SKILL_ID))!;
    version = await getApprovedSkillVersionByIdentityAndVersion(
      identity.identityId,
      versionName,
    );
  }
  if (!version) throw new Error(`Approved version unavailable: ${SKILL_ID}@${versionName}`);
  if (version.artifactSha256 !== digest.sha256) {
    throw new Error(`Approved artifact differs from source: ${version.artifactSha256}`);
  }

  await updateSkillIdentityPresentation({
    identityId: identity.identityId,
    displayName: parsed.displayName || SKILL_ID,
    description: parsed.description || null,
    category: identity.category,
  });

  console.log(JSON.stringify({
    ...plan,
    approvedVersionId: version.versionId,
    status: "approved",
  }, null, 2));
}

main()
  .then(() => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
