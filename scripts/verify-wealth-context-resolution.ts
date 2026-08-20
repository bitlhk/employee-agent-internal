import "dotenv/config";
import { performance } from "node:perf_hooks";
import { listContextSourceBindingContracts } from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { resolveContextSources } from "../server/_core/context-resolution/source-resolver";
import { wealthContextNeedPlan } from "../server/_core/context-resolution/wealth-context-plans";
import type { ContextProviderTypeV1 } from "../shared/context-resolution";

const ROLE_PACK_ID = "linggan-bank.wealth-manager";
const TASK_IDS = ["WM-GT-01", "WM-GT-02", "WM-GT-03", "WM-GT-05"] as const;

type ObservedSource = {
  logicalAssetId: string;
  providerType: ContextProviderTypeV1;
  resourceRef: string;
};

function option(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || "";
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function legacySources(knowledgeBaseId: string): Record<(typeof TASK_IDS)[number], ObservedSource[]> {
  const policy = { providerType: "llamaindex" as const, resourceRef: `kb://${knowledgeBaseId}` };
  return {
    "WM-GT-01": [
      { logicalAssetId: "customer_profile", providerType: "mcp", resourceRef: "mcp://wealth-customer/wealth_assistant_customer_detail" },
      { logicalAssetId: "customer_portfolio", providerType: "mcp", resourceRef: "mcp://wealth-customer/wealth_assistant_customer_detail" },
      { logicalAssetId: "current_previsit_sop", ...policy },
      { logicalAssetId: "customer_relationship_memory", providerType: "api", resourceRef: "api://employee-agent/agent-memory/relevant" },
    ],
    "WM-GT-02": [
      { logicalAssetId: "customer_profile", providerType: "mcp", resourceRef: "mcp://wealth-customer/wealth_assistant_customer_detail" },
      { logicalAssetId: "customer_portfolio", providerType: "mcp", resourceRef: "mcp://wealth-customer/wealth_assistant_customer_detail" },
      { logicalAssetId: "available_products", providerType: "mcp", resourceRef: "mcp://wealth-product/wealth_assistant_product_search" },
      { logicalAssetId: "current_wealth_policy", ...policy },
    ],
    "WM-GT-03": [{ logicalAssetId: "current_wealth_policy", ...policy }],
    "WM-GT-05": [{
      logicalAssetId: "governed_followup_payload",
      providerType: "api",
      resourceRef: "api://employee-agent/enterprise-mcp/governed-followup-intent",
    }],
  };
}

async function main() {
  const organizationId = option("organization");
  const knowledgeBaseId = option("knowledge-base");
  const stage = option("stage") === "production" ? "production" as const : "shadow" as const;
  const iterations = Math.max(1, Math.min(500, Number(option("iterations") || 100)));
  if (!organizationId) throw new Error("缺少 --organization=<organizationId>");
  if (!/^kb_[A-Za-z0-9_-]{8,56}$/.test(knowledgeBaseId)) throw new Error("缺少有效的 --knowledge-base=<kb_public_id>");

  const observedByTask = legacySources(knowledgeBaseId);
  const durations: number[] = [];
  const results = [];
  let comparisonCount = 0;
  let sourceMatches = 0;
  let differences = 0;
  for (const taskId of TASK_IDS) {
    const sourcePlan = wealthContextNeedPlan(taskId);
    if (!sourcePlan) throw new Error(`Context Need Plan missing: ${taskId}`);
    let resolved = null as ReturnType<typeof resolveContextSources> | null;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const startedAt = performance.now();
      const bindings = await listContextSourceBindingContracts({ organizationId, rolePackId: ROLE_PACK_ID, stage });
      resolved = resolveContextSources({ plan: sourcePlan, bindings, organizationId, stage });
      durations.push(performance.now() - startedAt);
    }
    if (!resolved) throw new Error(`Resolver did not run: ${taskId}`);
    const comparisons = resolved.resolutions.map((resolution) => {
      const actual = observedByTask[taskId].find((source) => source.logicalAssetId === resolution.need.logicalAssetId);
      const expected = resolution.binding;
      const sourceMatch = actual && expected
        ? actual.providerType === expected.providerType && actual.resourceRef === expected.resourceRef
        : !actual && !expected;
      comparisonCount += 1;
      if (sourceMatch) sourceMatches += 1;
      else differences += 1;
      return {
        logicalAssetId: resolution.need.logicalAssetId,
        requiredness: resolution.need.requiredness,
        resolutionStatus: resolution.status,
        reasonCode: resolution.reasonCode || null,
        observed: Boolean(actual),
        sourceMatch,
      };
    });
    results.push({
      taskId,
      status: resolved.status,
      bindingSnapshotFingerprint: resolved.bindingSnapshotFingerprint,
      comparisons,
    });
  }
  const summary = {
    schema: "ea.context-resolution-verification.v1",
    organizationId,
    rolePackId: ROLE_PACK_ID,
    stage,
    iterationsPerTask: iterations,
    comparisonCount,
    sourceMatches,
    differences,
    sourceMatchRate: comparisonCount ? sourceMatches / comparisonCount : 0,
    resolverLatencyMs: {
      p50: Number(percentile(durations, 0.5).toFixed(3)),
      p95: Number(percentile(durations, 0.95).toFixed(3)),
      max: Number(Math.max(...durations).toFixed(3)),
    },
    tasks: results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (differences > 0) process.exitCode = 2;
}

main()
  .then(async () => closeDbConnection())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
