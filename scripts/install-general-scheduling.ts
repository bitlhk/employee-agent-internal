import "dotenv/config";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDbConnection } from "../server/db/connection";
import {
  getClawByAdoptId,
  insertSkillMarketItem,
  listSkillMarketItems,
  replaceAdminRoleAssetGrantsForAsset,
  resolveEffectiveRoleAssets,
  updateSkillMarketItem,
} from "../server/db";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
import {
  ensureSkillStoreDirs,
  skillStoreMarketplaceDir,
} from "../server/_core/skills/skill-store";
import { resolveAgentRoleTemplate } from "../server/_core/role-templates";
import { getRoleRuntimeAdapter } from "../server/routers/role-runtime-adapters";
import { resolveRuntimeAgentId } from "../server/_core/helpers";
import { recordAuditRequired } from "../server/_core/audit-events";
import { isJiuwenClawRuntimeEnabled } from "../server/_core/jiuwenclaw-bridge";

const roleKey = "general-assistant";
// Keep the published skill ID stable for existing installations.
const skillId = "scheduling-assistant";
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
async function main() {
  const sourceDir = path.join(
    appRoot,
    "examples/scheduling-assistant/skills",
    skillId
  );
  const targetDir = path.join(skillStoreMarketplaceDir("approved"), skillId);
  const parsed = parseSkillSourceDirectory(sourceDir, skillId);
  if (parsed.warnings.length) throw new Error(parsed.warnings.join("; "));
  const role = resolveAgentRoleTemplate(roleKey);
  if (!role.defaultSkills.includes(skillId))
    throw new Error("General assistant must declare its scheduling skill");
  const adoptIds = [
    ...new Set(
      process.argv
        .filter(arg => arg.startsWith("--adopt-id="))
        .map(arg => arg.slice(11))
    ),
  ];
  const plan = {
    roleKey,
    skillId,
    sourceDir,
    targetDir,
    adoptIds,
    apply: process.argv.includes("--apply"),
  };
  if (!plan.apply) {
    console.log(JSON.stringify(plan));
    return;
  }
  ensureSkillStoreDirs();
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: false,
  });
  const current = (await listSkillMarketItems("all")).find(
    row => row.skillId === skillId && row.origin === "opensource"
  );
  const patch = {
    name: parsed.displayName || "日程协同",
    description: parsed.description || null,
    author: "Employee Agent",
    version: String(
      parsed.manifest.version || parsed.mdMeta.version || "1.4.1"
    ),
    category: "office" as const,
    origin: "opensource",
    status: "approved" as const,
    license: "MIT",
    packagePath: targetDir,
    roleTag: roleKey,
    provider: "employee-agent",
  };
  const marketId = current
    ? (await updateSkillMarketItem(Number(current.id), patch),
      Number(current.id))
    : await insertSkillMarketItem({ skillId, ...patch });
  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "skill",
    assetId: skillId,
    grants: [{ roleKey, grantMode: "default" }],
    actor: "general-scheduling-installer",
  });
  const reconciled = [];
  for (const adoptId of adoptIds) {
    const adoption = await getClawByAdoptId(adoptId);
    if (!adoption || adoption.roleTemplate !== roleKey)
      throw new Error(`Not a general assistant: ${adoptId}`);
    const adapter = getRoleRuntimeAdapter(role.runtime);
    const agentId = resolveRuntimeAgentId(
      adoptId,
      String(adoption.agentId || "")
    );
    const result = await adapter.reconcileAssets!({
      adoptId,
      agentId,
      role,
      effectiveAssets: await resolveEffectiveRoleAssets(roleKey),
    });
    if (!result.ok)
      throw new Error(result.reason || "Role asset reconciliation failed");
    const refresh = isJiuwenClawRuntimeEnabled()
      ? "refreshed"
      : "deferred-runtime-disabled";
    if (refresh === "refreshed")
      await adapter.refreshCapabilities(adoptId, agentId);
    reconciled.push({ adoptId, changed: result.changed, refresh });
  }
  await recordAuditRequired({
    action: "role_pack.reference_asset.installed",
    actorType: "system",
    actorName: "scheduling-role-pack-installer",
    targetType: "role_template",
    targetId: roleKey,
    metadata: { marketId, reconciled },
  });
  console.log(JSON.stringify({ ...plan, marketId, reconciled }));
}
main()
  .catch(error => {
    console.error(
      error instanceof Error ? error.message : "Role pack install failed"
    );
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
