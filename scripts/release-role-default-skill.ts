import "dotenv/config";
import {
  getApprovedSkillVersionByIdentityAndVersion,
  getSkillIdentityBySkillId,
  getUserByEmail,
  listClawAdoptionsAdmin,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { releaseRoleDefaultSkillVersion } from "../server/_core/skills/role-default-skill-release";

function option(name: string): string {
  const prefix = `--${name}=`;
  return String(process.argv.find(arg => arg.startsWith(prefix)) || "")
    .slice(prefix.length)
    .trim();
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name}=... is required`);
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const operation = process.argv.includes("--rollback")
    ? "rollback"
    : "release";
  const allRoleInstances = process.argv.includes("--all-role-instances");
  const roleKey = required("role-key");
  const skillId = required("skill-id");
  const versionName = required("version");
  const actorEmail = required("actor-email").toLowerCase();
  const rolePackReleaseId = required("role-pack-release-id");
  const goldenTaskRunId = required("golden-task-run-id");
  const providedArtifactSha256 = required(
    "provided-artifact-sha256"
  ).toLowerCase();
  const requestedAdoptIds = process.argv
    .filter(arg => arg.startsWith("--adopt-id="))
    .flatMap(arg => arg.slice("--adopt-id=".length).split(","))
    .map(value => value.trim())
    .filter(Boolean);

  const identity = await getSkillIdentityBySkillId(skillId);
  if (!identity) throw new Error(`Skill identity is unavailable: ${skillId}`);
  const version = await getApprovedSkillVersionByIdentityAndVersion(
    identity.identityId,
    versionName
  );
  if (!version)
    throw new Error(
      `Approved Skill version is unavailable: ${skillId}@${versionName}`
    );
  const actor = await getUserByEmail(actorEmail);
  if (!actor) throw new Error(`Release actor is unavailable: ${actorEmail}`);
  if (actor.role !== "admin") {
    throw new Error(
      `Role-default Skill release requires an administrator: ${actorEmail}`
    );
  }

  const adoptions = allRoleInstances
    ? (await listClawAdoptionsAdmin({ status: "active", limit: 1000 }))
        .filter(row => String(row.roleTemplate || "") === roleKey)
        .map(row => String(row.adoptId))
    : requestedAdoptIds;
  const adoptIds = [...new Set(adoptions)].sort();
  const plan = {
    mode: apply ? "apply" : "dry-run",
    operation,
    roleKey,
    skillId,
    version: version.version,
    versionId: version.versionId,
    artifactSha256: version.artifactSha256,
    actorEmail,
    actorUserId: Number(actor.id),
    rolePackReleaseId,
    goldenTaskRunId,
    providedArtifactSha256,
    adoptIds,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const result = await releaseRoleDefaultSkillVersion({
    operation,
    roleKey,
    skillId,
    versionId: version.versionId,
    rolePackReleaseId,
    goldenTaskRunId,
    providedArtifactSha256,
    actorUserId: Number(actor.id),
    adoptIds,
  });
  console.log(
    JSON.stringify(
      {
        ...plan,
        operationId: result.operationId,
        reconciled: result.reconciled,
        targetPath: result.targetPath,
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
