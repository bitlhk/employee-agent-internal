import "dotenv/config";
import { createHash } from "node:crypto";
import {
  listContextSourceBindingContracts,
  promoteShadowContextSourceBindings,
  upsertContextSourceBinding,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import type { ContextProviderTypeV1, ContextTypeV1 } from "../shared/context-resolution";

const ROLE_PACK_ID = "linggan-bank.wealth-manager";
const ACTOR = "wealth-context-binding-configurator";

type BindingSeed = {
  logicalAssetId: string;
  contextType: ContextTypeV1;
  providerType: ContextProviderTypeV1;
  resourceRef: string;
  capabilities: string[];
};

function option(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || "";
}

function bindingId(input: { organizationId: string; logicalAssetId: string; stage: "shadow" | "production" }): string {
  const suffix = createHash("sha256")
    .update(`${input.organizationId}|${ROLE_PACK_ID}|${input.logicalAssetId}|${input.stage}`)
    .digest("hex")
    .slice(0, 24);
  return `ctxb_${suffix}`;
}

function seeds(knowledgeBaseId: string): BindingSeed[] {
  const kbRef = `kb://${knowledgeBaseId}`;
  return [
    { logicalAssetId: "customer_profile", contextType: "business_data", providerType: "mcp", resourceRef: "mcp://customer-profile/get_customer_profile", capabilities: ["point_read"] },
    { logicalAssetId: "customer_portfolio", contextType: "business_data", providerType: "mcp", resourceRef: "mcp://customer-profile/get_customer_portfolio", capabilities: ["point_read"] },
    { logicalAssetId: "available_products", contextType: "business_data", providerType: "mcp", resourceRef: "mcp://wealth-product/wealth_assistant_product_search", capabilities: ["search"] },
    { logicalAssetId: "customer_relationship_memory", contextType: "memory", providerType: "api", resourceRef: "api://employee-agent/agent-memory/relevant", capabilities: ["relevant_retrieval"] },
    { logicalAssetId: "governed_followup_payload", contextType: "business_data", providerType: "api", resourceRef: "api://employee-agent/enterprise-mcp/governed-followup-intent", capabilities: ["task_state_read"] },
    { logicalAssetId: "current_previsit_sop", contextType: "knowledge", providerType: "llamaindex", resourceRef: kbRef, capabilities: ["metadata_filter"] },
    { logicalAssetId: "current_wealth_policy", contextType: "knowledge", providerType: "llamaindex", resourceRef: kbRef, capabilities: ["metadata_filter", "citation"] },
  ];
}

async function main() {
  const organizationId = option("organization");
  const knowledgeBaseId = option("knowledge-base");
  const apply = process.argv.includes("--apply");
  const promote = process.argv.includes("--promote");
  const verifiedReleaseId = option("verified-release-id");
  if (!organizationId) throw new Error("缺少 --organization=<organizationId>");
  if (promote && !verifiedReleaseId) throw new Error("提升生产 Binding 需要 --verified-release-id=<releaseId>");
  if (!promote && !/^kb_[A-Za-z0-9_-]{8,56}$/.test(knowledgeBaseId)) {
    throw new Error("缺少有效的 --knowledge-base=<kb_public_id>");
  }

  if (promote) {
    const shadowBindings = await listContextSourceBindingContracts({ organizationId, rolePackId: ROLE_PACK_ID, stage: "shadow" });
    const plan = shadowBindings.filter((binding) => binding.status === "active").map((binding) => ({
      shadowBindingId: binding.bindingId,
      productionBindingId: bindingId({ organizationId, logicalAssetId: binding.logicalAssetId, stage: "production" }),
      logicalAssetId: binding.logicalAssetId,
    }));
    if (!apply) {
      console.log(JSON.stringify({ mode: "dry-run", action: "promote", verifiedReleaseId, plan }, null, 2));
      return;
    }
    const rows = await promoteShadowContextSourceBindings({
      bindings: plan.map((item) => ({
        shadowBindingId: item.shadowBindingId,
        productionBindingId: item.productionBindingId,
      })),
      verifiedReleaseId,
      actor: ACTOR,
    });
    const promoted = rows.map((row) => ({ bindingId: row.bindingId, logicalAssetId: row.logicalAssetId }));
    console.log(JSON.stringify({ action: "promote", verifiedReleaseId, promoted }, null, 2));
    return;
  }

  const plan = seeds(knowledgeBaseId);
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", action: "configure-shadow", organizationId, rolePackId: ROLE_PACK_ID, plan }, null, 2));
    return;
  }
  const configured = [];
  for (const seed of plan) {
    const row = await upsertContextSourceBinding({
      bindingId: bindingId({ organizationId, logicalAssetId: seed.logicalAssetId, stage: "shadow" }),
      organizationId,
      rolePackId: ROLE_PACK_ID,
      logicalAssetId: seed.logicalAssetId,
      contextType: seed.contextType,
      providerType: seed.providerType,
      resourceRef: seed.resourceRef,
      capabilitiesJson: seed.capabilities,
      bindingVersion: "1",
      stage: "shadow",
      status: "active",
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });
    configured.push({ bindingId: row.bindingId, logicalAssetId: row.logicalAssetId });
  }
  console.log(JSON.stringify({ action: "configure-shadow", organizationId, configured }, null, 2));
}

main()
  .then(async () => closeDbConnection())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
