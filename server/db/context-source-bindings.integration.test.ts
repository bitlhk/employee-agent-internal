import "dotenv/config";
import { randomUUID } from "node:crypto";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
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
import { sharedBindingCandidateFingerprint } from "../_core/context-resolution/shared-binding-validation-snapshot";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const rolePackId = `test.context-role.${suffix}`;
const organizationId = `org-context-${suffix}`;
let pool: Pool;

suite("Context Source Binding promotion", () => {
  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM context_source_binding_promotions WHERE promotion_id LIKE ?", [`%${suffix}%`]);
      await pool.query("DELETE FROM context_source_bindings WHERE binding_id LIKE ?", [`%${suffix}%`]);
      await pool.query("DELETE FROM role_pack_releases WHERE release_id LIKE ?", [`%${suffix}%`]);
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

  it("atomically replaces exact role mappings with one shared Binding set and restores them on rollback", async () => {
    const roles = [`wealth-${suffix}`, `insurance-${suffix}`];
    const logicalAssets = ["customer_profile", "customer_relationship_memory", "governed_work_state"];
    const releases = new Map<string, string>();
    for (const targetRolePackId of roles) {
      const releaseId = `${targetRolePackId}@verified-${suffix}`;
      releases.set(targetRolePackId, releaseId);
      await persistRolePackRelease({
        releaseId,
        rolePackId: targetRolePackId,
        evalSuiteVersion: "shared-v1",
        assetSetFingerprint: "8".repeat(64),
        verificationLevel: "controlled_scenario",
        status: "verified",
        contractReport: { status: "PASS" },
        scenarioReport: { status: "PASS" },
      });
      for (const logicalAssetId of logicalAssets) {
        await upsertContextSourceBinding({
          bindingId: `ctxb-exact-${targetRolePackId}-${logicalAssetId}-${suffix}`,
          organizationId,
          rolePackId: targetRolePackId,
          bindingScope: "role_pack",
          logicalAssetId,
          contextType: logicalAssetId === "customer_profile" ? "business_data" : "memory",
          providerType: logicalAssetId === "customer_profile" ? "mcp" : "api",
          resourceRef: `api://exact/${targetRolePackId}/${logicalAssetId}`,
          capabilitiesJson: ["read"],
          stage: "production",
          createdBy: "integration-test",
          updatedBy: "integration-test",
        });
      }
    }
    const mappings = [];
    for (const logicalAssetId of logicalAssets) {
      const shadowBindingId = `ctxb-shared-shadow-${logicalAssetId}-${suffix}`;
      await upsertContextSourceBinding({
        bindingId: shadowBindingId,
        organizationId,
        rolePackId: "*",
        bindingScope: "enterprise_shared",
        logicalAssetId,
        contextType: logicalAssetId === "customer_profile" ? "business_data" : "memory",
        providerType: logicalAssetId === "customer_profile" ? "mcp" : "api",
        resourceRef: `api://shared/${logicalAssetId}`,
        capabilitiesJson: ["read"],
        stage: "shadow",
        createdBy: "integration-test",
        updatedBy: "integration-test",
      });
      mappings.push({ shadowBindingId, productionBindingId: `ctxb-shared-production-${logicalAssetId}-${suffix}` });
    }
    const promotionId = `ctxp-shared-${suffix}`;
    const sharedBindings = await listContextSourceBindingContracts({
      organizationId,
      rolePackId: roles[0],
      stage: "shadow",
    });
    const validationSnapshotFingerprint = "s".repeat(64);
    const providedCandidateFingerprints = Object.fromEntries(
      sharedBindings.map(binding => [binding.bindingId, sharedBindingCandidateFingerprint(binding)]),
    );
    const promoted = await promoteShadowContextSourceBindings({
      bindings: mappings,
      actor: "integration-test",
      promotionId,
      sharedValidation: {
        schema: "ea.shared-binding-promotion-validation.v1",
        validationSnapshotFingerprint,
        expectedBindingIds: mappings.map(item => item.shadowBindingId),
        sharedBindingIdentityCount: 3,
        expectedSharedBindingIdentityCount: 3,
        purposeIsolationPassed: true,
        eligibilityViolationCount: 0,
        roleValidations: roles.map(targetRolePackId => ({
          rolePackId: targetRolePackId,
          verifiedReleaseId: releases.get(targetRolePackId)!,
          goldenTaskPassed: true,
          validationSnapshotFingerprint,
          goldenTaskReportFingerprint: `${targetRolePackId}:${suffix}`.padEnd(64, "0").slice(0, 64),
          providedCandidateFingerprints,
        })),
      },
    });
    expect(promoted).toHaveLength(3);
    expect(promoted.every(binding => binding.bindingScope === "enterprise_shared" && binding.rolePackId === "*")).toBe(true);
    const [exactCount] = await pool.query<Array<RowDataPacket & { count: number | string }>>(
      "SELECT COUNT(*) AS count FROM context_source_bindings WHERE binding_id LIKE ? AND binding_scope = 'role_pack'",
      [`ctxb-exact-%-${suffix}`],
    );
    expect(Number(exactCount[0].count)).toBe(0);

    const restored = await rollbackContextSourceBindingPromotion({ promotionId, actor: "integration-test-rollback" });
    expect(restored).toHaveLength(6);
    expect(restored.every(binding => binding.bindingScope === "role_pack")).toBe(true);
  });
});
