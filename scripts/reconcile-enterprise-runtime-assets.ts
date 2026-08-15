import "dotenv/config";

import { setTimeout as delay } from "node:timers/promises";
import { closeDbConnection } from "../server/db/connection";
import { getClawByAdoptId, listClawAdoptionsAdmin } from "../server/db/claw";
import { resolveEffectiveRoleAssets } from "../server/db/role-assets";
import { ensureEnterpriseRuntimeBindingForAdoption } from "../server/_core/enterprise-runtime-assets";
import { resolveAgentRoleTemplate } from "../server/_core/role-templates";
import { getRoleRuntimeAdapter } from "../server/routers/role-runtime-adapters";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

async function adoptionIds(): Promise<string[]> {
  const explicit = option("--adoptions")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit.length) return Array.from(new Set(explicit));
  const rows = await listClawAdoptionsAdmin({ status: "active", limit: 1000 });
  return rows
    .filter((row) => String(row.adoptId || "").startsWith("lgj-"))
    .map((row) => String(row.adoptId));
}

async function main(): Promise<void> {
  const ids = await adoptionIds();
  const results: Array<Record<string, unknown>> = [];
  for (const adoptionId of ids) {
    const adoption = await getClawByAdoptId(adoptionId);
    if (!adoption || adoption.status !== "active") {
      results.push({ adoptionId, ok: false, reason: "active_adoption_not_found" });
      continue;
    }
    try {
      const role = resolveAgentRoleTemplate(adoption.roleTemplate);
      const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
      const adapter = getRoleRuntimeAdapter("jiuwenswarm");
      const skill = await adapter.reconcileSkills({
        adoptId: adoption.adoptId,
        agentId: adoption.agentId,
        role,
        effectiveAssets,
      });
      const mcp = await adapter.reconcileMcp({
        adoptId: adoption.adoptId,
        agentId: adoption.agentId,
        role,
        effectiveAssets,
      });
      const binding = await ensureEnterpriseRuntimeBindingForAdoption(adoptionId);
      results.push({
        adoptionId,
        ok: Boolean(binding && binding.status === "ready"),
        roleTemplate: role.id,
        skillChanged: skill.changed,
        mcpChanged: mcp.changed,
        bindingId: binding?.bindingId || null,
        assetSetFingerprint: binding?.assetSetFingerprint || null,
      });
    } catch (error) {
      results.push({
        adoptionId,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ requested: ids.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // Reconcile operations can enqueue audit writes after their primary result.
    // Let those callbacks drain before closing the shared MySQL pool.
    await delay(500);
    await closeDbConnection();
  }
}

void run();
