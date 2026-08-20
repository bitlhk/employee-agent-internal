import "dotenv/config";
import { randomUUID } from "node:crypto";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import type { ContextSourceBinding } from "../../drizzle/schema";
import { closeDbConnection } from "./connection";
import {
  listContextSourceBindingContracts,
  promoteShadowContextSourceBindings,
  rollbackContextSourceBindingPromotion,
  upsertContextSourceBinding,
} from "./context-source-bindings";
import { persistRolePackRelease } from "./role-pack-releases";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const rolePackId = `test.context-role.${suffix}`;
const organizationId = `org-context-${suffix}`;
let pool: Pool;

suite("Context Source Binding promotion", () => {
  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM context_source_binding_promotions WHERE role_pack_id = ?", [rolePackId]);
      await pool.query("DELETE FROM context_source_bindings WHERE role_pack_id = ?", [rolePackId]);
      await pool.query("DELETE FROM role_pack_releases WHERE role_pack_id = ?", [rolePackId]);
    }
    await closeDbConnection();
    await pool?.end();
  });

  it("atomically promotes a complete shadow set only against a verified release", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 1 });
    const contractReleaseId = `${rolePackId}@contract-only`;
    await persistRolePackRelease({
      releaseId: contractReleaseId,
      rolePackId,
      evalSuiteVersion: "v1",
      assetSetFingerprint: "6".repeat(64),
      verificationLevel: "contract",
      status: "verified",
      contractReport: { status: "PASS" },
    });
    for (const logicalAssetId of ["current_policy", "customer_profile"]) {
      await upsertContextSourceBinding({
        bindingId: `ctxb-shadow-${logicalAssetId}-${suffix}`,
        organizationId,
        rolePackId,
        logicalAssetId,
        contextType: logicalAssetId === "current_policy" ? "knowledge" : "business_data",
        providerType: logicalAssetId === "current_policy" ? "llamaindex" : "mcp",
        resourceRef: logicalAssetId === "current_policy" ? "kb://kb_context_test_01" : "mcp://wealth-customer/wealth_assistant_customer_detail",
        capabilitiesJson: ["point_read"],
        bindingVersion: "1",
        stage: "shadow",
        status: "active",
        createdBy: "integration-test",
        updatedBy: "integration-test",
      });
    }
    await upsertContextSourceBinding({
      bindingId: `ctxb-production-current_policy-${suffix}`,
      organizationId,
      rolePackId,
      logicalAssetId: "current_policy",
      contextType: "knowledge",
      providerType: "llamaindex",
      resourceRef: "kb://kb_context_previous_01",
      capabilitiesJson: ["point_read"],
      bindingVersion: "previous",
      stage: "production",
      status: "active",
      createdBy: "integration-test",
      updatedBy: "integration-test",
    });
    const shadow = await listContextSourceBindingContracts({ organizationId, rolePackId, stage: "shadow" });
    await expect(promoteShadowContextSourceBindings({
      bindings: shadow.map((binding) => ({
        shadowBindingId: binding.bindingId,
        productionBindingId: binding.bindingId.replace("shadow", "production"),
      })),
      verifiedReleaseId: contractReleaseId,
      actor: "integration-test",
    })).rejects.toThrow(/Golden Task verified/);
    const releaseId = `${rolePackId}@verified`;
    await persistRolePackRelease({
      releaseId,
      rolePackId,
      evalSuiteVersion: "v1",
      assetSetFingerprint: "7".repeat(64),
      verificationLevel: "controlled_scenario",
      status: "verified",
      contractReport: { status: "PASS" },
      scenarioReport: { status: "PASS" },
    });
    const promotionIds = [`ctxp-${suffix}-a`, `ctxp-${suffix}-b`];
    const attempts = await Promise.allSettled(promotionIds.map((promotionId) => promoteShadowContextSourceBindings({
      bindings: shadow.map((binding) => ({
        shadowBindingId: binding.bindingId,
        productionBindingId: binding.bindingId.replace("shadow", "production"),
      })),
      verifiedReleaseId: releaseId,
      actor: "integration-test",
      promotionId,
    })));
    const successes = attempts.filter((attempt): attempt is PromiseFulfilledResult<ContextSourceBinding[]> => attempt.status === "fulfilled");
    const failures = attempts.filter((attempt) => attempt.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const promoted = successes[0].value;
    expect(promoted).toHaveLength(2);
    expect(promoted.every((binding) => binding.stage === "production" && binding.verifiedReleaseId === releaseId)).toBe(true);
    const disabledShadow = await listContextSourceBindingContracts({ organizationId, rolePackId, stage: "shadow" });
    expect(disabledShadow.every((binding) => binding.status === "disabled")).toBe(true);
    const winningPromotionId = promotionIds[attempts.findIndex((attempt) => attempt.status === "fulfilled")];
    const restored = await rollbackContextSourceBindingPromotion({
      promotionId: winningPromotionId,
      actor: "integration-test-rollback",
    });
    expect(restored).toHaveLength(1);
    expect(restored[0].resourceRef).toBe("kb://kb_context_previous_01");
    await expect(rollbackContextSourceBindingPromotion({
      promotionId: winningPromotionId,
      actor: "integration-test-rollback",
    })).rejects.toThrow(/not found/);
  });
});
