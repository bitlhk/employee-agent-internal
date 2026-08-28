import "dotenv/config";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { clawAdoptions } from "../drizzle/schema";
import { closeDbConnection, getDb } from "../server/db/connection";
import { createClawAdoption, getClawByAdoptId } from "../server/db/claw";
import { createUser, getUserByEmail } from "../server/db/users";
import { resolveRuntimeWorkspaceByIds } from "../server/_core/helpers";
import {
  buildSkillEvaluationRuntimeProfile,
  skillEvaluationAgentId,
} from "../server/_core/skill-quality-evaluation-runtime";
import { loadSkillQualityPilotContracts } from "../server/_core/skill-quality-evaluation-contracts";
import { roleSkillPreferences } from "../server/_core/skills/role-skill-preferences";
import { skillInstaller } from "../server/_core/skills/skill-installer";
import { skillRegistry } from "../server/_core/skills/skill-registry";

function assertIntentionalLocalProvision(): void {
  if (
    !process.argv.includes("--apply") ||
    process.env.EA_SKILL_EVAL_ALLOW_LOCAL_PROVISION !== "1"
  ) {
    throw new Error(
      "Refusing to provision. Use --apply with EA_SKILL_EVAL_ALLOW_LOCAL_PROVISION=1"
    );
  }
  const profile = buildSkillEvaluationRuntimeProfile();
  const host = new URL(profile.baseUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`Provisioning is restricted to a loopback Runtime, received ${host}`);
  }
}

async function main(): Promise<void> {
  assertIntentionalLocalProvision();
  const profile = buildSkillEvaluationRuntimeProfile();
  const contracts = loadSkillQualityPilotContracts({
    skillId: "wealth-manager-assistant",
  });
  const email = "skill-quality-eval@local.linggan.invalid";
  let user = await getUserByEmail(email);
  if (!user) {
    const userId = await createUser({
      name: "Skill Quality Isolated Evaluator",
      email,
      loginMethod: "internal_evaluation",
      role: "user",
      accessLevel: "all",
      organization: "EA Isolated Skill Evaluation",
    });
    user = await getUserByEmail(email);
    if (!user || user.id !== userId) throw new Error("Failed to reload evaluation user");
  }
  const inventory = new Map(
    contracts.inventory.records.map(record => [record.skillVersionId, record])
  );
  const results = [];
  for (const arm of profile.arms) {
    const agentId = skillEvaluationAgentId(arm.adoptionId);
    let adoption = await getClawByAdoptId(arm.adoptionId);
    if (!adoption) {
      await createClawAdoption({
        userId: user.id,
        adoptId: arm.adoptionId,
        agentId,
        status: "active",
        permissionProfile: "internal",
        roleTemplate: "wealth-manager",
        industry: "financial",
        runtime: "jiuwenswarm",
        ttlDays: 3650,
        entryUrl: `/workspace?adoptId=${encodeURIComponent(arm.adoptionId)}`,
        expiresAt: null,
      });
      adoption = await getClawByAdoptId(arm.adoptionId);
    }
    if (!adoption) throw new Error(`Failed to provision ${arm.adoptionId}`);
    if (
      adoption.userId === user.id &&
      adoption.agentId !== agentId &&
      String(adoption.agentId || "").startsWith("jiuwen_eval_")
    ) {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db
        .update(clawAdoptions)
        .set({ agentId })
        .where(eq(clawAdoptions.id, adoption.id));
      adoption = await getClawByAdoptId(arm.adoptionId);
    }
    if (
      adoption.userId !== user.id ||
      adoption.agentId !== agentId ||
      adoption.roleTemplate !== "wealth-manager" ||
      adoption.status !== "active"
    ) {
      throw new Error(`Existing evaluation adoption ${arm.adoptionId} has incompatible identity`);
    }
    if (!arm.expectedSkill) {
      roleSkillPreferences.setDefaultSkillEnabled(
        arm.adoptionId,
        contracts.pilot.skillId,
        false
      );
      await skillRegistry.uninstall(arm.adoptionId, contracts.pilot.skillId).catch(() => undefined);
      await skillRegistry.refreshRuntimeProjection(arm.adoptionId);
      const runtimePath = path.join(
        resolveRuntimeWorkspaceByIds(arm.adoptionId, agentId),
        "skills",
        contracts.pilot.skillId
      );
      if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });
      results.push({ executionArm: arm.executionArm, adoptionId: arm.adoptionId, skill: null });
      continue;
    }
    const record = inventory.get(arm.expectedSkill.skillVersionId);
    if (!record) throw new Error(`Inventory record ${arm.expectedSkill.skillVersionId} is missing`);
    const sourcePath = path.join(contracts.skillStoreRoot, record.artifactRelativePath);
    roleSkillPreferences.setDefaultSkillEnabled(
      arm.adoptionId,
      contracts.pilot.skillId,
      true
    );
    const installed = await skillRegistry.install(
      arm.adoptionId,
      {
        kind: "marketplace",
        skillId: contracts.pilot.skillId,
        displayName: "客户经理财富助手",
        description: "Skill Quality isolated Runtime artifact",
        sourcePath,
        marketplaceId: record.skillVersionId,
        version: record.version,
      },
      {
        allowVersionDowngrade: true,
        preserveImmutableSourcePath: true,
      }
    );
    if (!installed.ok) {
      throw new Error(`${arm.adoptionId}: ${installed.error.detail}`);
    }
    const runtimePath = String(installed.value.sync.runtimePath || "").trim();
    if (!runtimePath) throw new Error(`${arm.adoptionId}: Runtime path is missing after install`);

    // The normal role projection intentionally restores the current role-default
    // version. Evaluation adoptions re-materialize their frozen artifact last so
    // the previous-version arm remains immutable without changing production
    // role projection semantics.
    await skillInstaller.installFromSource(sourcePath, runtimePath);
    results.push({
      executionArm: arm.executionArm,
      adoptionId: arm.adoptionId,
      skill: {
        version: record.version,
        artifactSha256: record.artifactSha256,
        runtimePath,
      },
    });
  }
  console.log(JSON.stringify({ profileFingerprint: profile.profileFingerprint, results }, null, 2));
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnection();
  });
