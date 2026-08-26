import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import {
  listContextSourceBindingContracts,
  promoteShadowContextSourceBindings,
  rollbackContextSourceBindingPromotion,
  upsertContextSourceBinding,
} from "../server/db/context-source-bindings";
import { closeDbConnection } from "../server/db/connection";

const ROLE_PACK_ID = "linggan-bank.wealth-manager";
const LOGICAL_ASSET_ID = "customer_portfolio";
const TARGET_RESOURCE_REF = "mcp://customer-profile/get_customer_portfolio";
const ACTOR = "wealth-customer-portfolio-binding-migrator";

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

function bindingId(
  organizationId: string,
  stage: "shadow" | "production"
): string {
  const suffix = createHash("sha256")
    .update(`${organizationId}|${ROLE_PACK_ID}|${LOGICAL_ASSET_ID}|${stage}`)
    .digest("hex")
    .slice(0, 24);
  return `ctxb_${suffix}`;
}

async function main() {
  const organizationId =
    option("organization") ||
    String(process.env.EA_DEMO_ORGANIZATION_ID || "org_linggan_finance").trim();
  const verifiedReleaseId = option("verified-release-id");
  const rollbackPromotionId = option("rollback-promotion-id");
  const apply = process.argv.includes("--apply");
  const promote = process.argv.includes("--promote");
  if (!organizationId || organizationId === "*")
    throw new Error("需要具体 organizationId");

  if (rollbackPromotionId) {
    if (!apply)
      return { mode: "dry-run", action: "rollback", rollbackPromotionId };
    const restored = await rollbackContextSourceBindingPromotion({
      promotionId: rollbackPromotionId,
      actor: ACTOR,
    });
    return { mode: "apply", action: "rollback", rollbackPromotionId, restored };
  }

  const current = (
    await listContextSourceBindingContracts({
      organizationId,
      rolePackId: ROLE_PACK_ID,
      stage: "production",
    })
  ).find(
    binding =>
      binding.bindingScope === "role_pack" &&
      binding.logicalAssetId === LOGICAL_ASSET_ID
  );
  const plan = {
    organizationId,
    rolePackId: ROLE_PACK_ID,
    logicalAssetId: LOGICAL_ASSET_ID,
    current: current || null,
    candidate: {
      bindingId: bindingId(organizationId, "shadow"),
      resourceRef: TARGET_RESOURCE_REF,
      bindingVersion: "2.customer-context-v1",
      stage: "shadow" as const,
    },
  };
  if (!apply)
    return {
      mode: "dry-run",
      action: promote ? "promote" : "configure-shadow",
      plan,
    };

  const shadow = await upsertContextSourceBinding({
    bindingId: plan.candidate.bindingId,
    organizationId,
    rolePackId: ROLE_PACK_ID,
    bindingScope: "role_pack",
    logicalAssetId: LOGICAL_ASSET_ID,
    contextType: "business_data",
    providerType: "mcp",
    resourceRef: TARGET_RESOURCE_REF,
    capabilitiesJson: ["point_read"],
    bindingVersion: plan.candidate.bindingVersion,
    stage: "shadow",
    status: "active",
    createdBy: ACTOR,
    updatedBy: ACTOR,
  });
  if (!promote)
    return { mode: "apply", action: "configure-shadow", plan, shadow };
  if (!verifiedReleaseId)
    throw new Error("Promote 需要 --verified-release-id=<releaseId>");

  const promotionId = `ctxp_customer_portfolio_${randomUUID().replace(/-/g, "")}`;
  const [production] = await promoteShadowContextSourceBindings({
    bindings: [
      {
        shadowBindingId: shadow.bindingId,
        productionBindingId: bindingId(organizationId, "production"),
      },
    ],
    verifiedReleaseId,
    actor: ACTOR,
    promotionId,
  });
  return { mode: "apply", action: "promote", promotionId, plan, production };
}

main()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
