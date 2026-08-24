import "dotenv/config";
import { createHash } from "node:crypto";
import type {
  ContextProviderTypeV1,
  ContextTypeV1,
} from "../shared/context-resolution";
import {
  listContextSourceBindingContracts,
  upsertContextSourceBinding,
} from "../server/db/context-source-bindings";
import { closeDbConnection } from "../server/db/connection";

const ACTOR = "enterprise-shared-context-binding-configurator";

type BindingSeed = {
  logicalAssetId: string;
  contextType: ContextTypeV1;
  providerType: ContextProviderTypeV1;
  resourceRef: string;
  capabilities: string[];
  bindingVersion: string;
};

const SEEDS: BindingSeed[] = [
  {
    logicalAssetId: "customer_profile",
    contextType: "business_data",
    providerType: "mcp",
    resourceRef: "mcp://customer-profile/get_governed_customer_profile",
    capabilities: ["point_read"],
    bindingVersion: "1.shared.customer-profile-v1",
  },
  {
    logicalAssetId: "customer_relationship_memory",
    contextType: "memory",
    providerType: "api",
    resourceRef: "api://employee-agent/agent-memory/relevant",
    capabilities: ["purpose_filter", "relevant_retrieval"],
    bindingVersion: "1.shared.purpose-v1",
  },
  {
    logicalAssetId: "governed_work_state",
    contextType: "memory",
    providerType: "api",
    resourceRef: "api://employee-agent/governed-work-items",
    capabilities: ["purpose_filter", "read_work_state", "relevant_retrieval"],
    bindingVersion: "1.shared.purpose-v1",
  },
];

function option(name: string): string {
  const prefix = `--${name}=`;
  return (
    process.argv
      .slice(2)
      .find(argument => argument.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() || ""
  );
}

function bindingId(organizationId: string, logicalAssetId: string): string {
  const suffix = createHash("sha256")
    .update(`${organizationId}|enterprise_shared|${logicalAssetId}|shadow`)
    .digest("hex")
    .slice(0, 24);
  return `ctxb_shared_shadow_${suffix}`;
}

async function main() {
  const organizationId =
    option("organization")
    || String(process.env.EA_DEMO_ORGANIZATION_ID || "org_linggan_finance").trim();
  const apply = process.argv.includes("--apply");
  if (!organizationId || organizationId === "*")
    throw new Error("Shared Binding requires a concrete organization");
  if (!apply) {
    return {
      mode: "dry-run",
      organizationId,
      stage: "shadow",
      seeds: SEEDS,
    };
  }
  for (const seed of SEEDS) {
    await upsertContextSourceBinding({
      bindingId: bindingId(organizationId, seed.logicalAssetId),
      organizationId,
      rolePackId: "*",
      bindingScope: "enterprise_shared",
      logicalAssetId: seed.logicalAssetId,
      contextType: seed.contextType,
      providerType: seed.providerType,
      resourceRef: seed.resourceRef,
      capabilitiesJson: seed.capabilities,
      bindingVersion: seed.bindingVersion,
      stage: "shadow",
      status: "active",
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });
  }
  const bindings = await listContextSourceBindingContracts({
    organizationId,
    rolePackId: "linggan-insurance.insurance-advisor",
    stage: "shadow",
  });
  const configured = bindings
    .filter(binding => SEEDS.some(seed => seed.logicalAssetId === binding.logicalAssetId))
    .sort((left, right) => left.logicalAssetId.localeCompare(right.logicalAssetId));
  if (configured.length !== SEEDS.length)
    throw new Error("Shared Shadow Binding configuration is incomplete");
  return {
    mode: "apply",
    organizationId,
    stage: "shadow",
    configured,
  };
}

main()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
