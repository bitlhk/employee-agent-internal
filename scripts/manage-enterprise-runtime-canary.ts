import { getClawByAdoptId } from "../server/db/claw";
import { closeDbConnection } from "../server/db/connection";
import {
  buildEnterpriseRuntimeBinding,
  getRuntimeAgentBinding,
  updateRuntimeAgentBindingStatus,
  upsertRuntimeAgentBinding,
} from "../server/db/runtime-agent-bindings";

type Action = "plan" | "apply" | "mark-ready" | "disable";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function adoptionIds(): string[] {
  const values = option("--adoptions")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length) throw new Error("--adoptions requires a comma-separated adoption list");
  if (values.length > 25) throw new Error("A canary batch cannot contain more than 25 adoptions");
  if (new Set(values).size !== values.length) throw new Error("Canary adoption IDs must be unique");
  for (const value of values) {
    if (!/^lgj-[A-Za-z0-9_-]{4,64}$/u.test(value)) throw new Error(`Invalid adoption ID: ${value}`);
  }
  return values;
}

function action(): Action {
  const actions: Action[] = [
    ...(process.argv.includes("--apply") ? ["apply" as const] : []),
    ...(process.argv.includes("--mark-ready") ? ["mark-ready" as const] : []),
    ...(process.argv.includes("--disable") ? ["disable" as const] : []),
  ];
  if (actions.length > 1) throw new Error("Use only one of --apply, --mark-ready or --disable");
  return actions[0] || "plan";
}

async function main(): Promise<void> {
  const ids = adoptionIds();
  const requestedAction = action();
  if (["mark-ready", "disable"].includes(requestedAction) && !process.argv.includes("--confirm")) {
    throw new Error(`${requestedAction} requires --confirm`);
  }

  const results = [];
  for (const adoptionId of ids) {
    const adoption = await getClawByAdoptId(adoptionId);
    if (!adoption) {
      results.push({ adoptionId, ok: false, reason: "adoption_not_found" });
      continue;
    }
    if (adoption.status !== "active") {
      results.push({ adoptionId, ok: false, reason: `adoption_${adoption.status}`, roleTemplate: adoption.roleTemplate });
      continue;
    }

    const draft = buildEnterpriseRuntimeBinding({
      adoptionId: adoption.adoptId,
      agentId: adoption.agentId,
      roleTemplate: adoption.roleTemplate,
      runtimeProfile: "enterprise_canary",
    });
    if (requestedAction === "apply") {
      const binding = await upsertRuntimeAgentBinding(draft);
      results.push({ adoptionId, ok: true, action: "pending", roleTemplate: adoption.roleTemplate, binding });
      continue;
    }

    const existing = await getRuntimeAgentBinding(adoptionId);
    if (requestedAction === "mark-ready" || requestedAction === "disable") {
      if (!existing) {
        results.push({ adoptionId, ok: false, reason: "binding_not_found", roleTemplate: adoption.roleTemplate });
        continue;
      }
      const status = requestedAction === "mark-ready" ? "ready" : "disabled";
      await updateRuntimeAgentBindingStatus({
        adoptionId,
        status,
        validatedAt: status === "ready" ? new Date() : null,
        lastError: null,
      });
      results.push({ adoptionId, ok: true, action: status, roleTemplate: adoption.roleTemplate, bindingId: existing.bindingId });
      continue;
    }

    results.push({
      adoptionId,
      ok: true,
      action: "plan",
      roleTemplate: adoption.roleTemplate,
      adoptionStatus: adoption.status,
      currentBindingStatus: existing?.status || null,
      draft,
    });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ action: requestedAction, requested: ids.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
