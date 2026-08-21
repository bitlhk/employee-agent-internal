import { describe, expect, it } from "vitest";
import type { LogicalContextCatalogV1 } from "../../shared/context-governance";
import { runWealthContextGovernanceContractChecks } from "./context-governance-contracts";
import {
  logicalContextIndex,
  validateContextNeedPlansAgainstCatalog,
  validateLogicalContextCatalog,
} from "./logical-context-catalog";

describe("Context governance contracts", () => {
  it("validates the Wealth Context Golden Set and Logical Context Catalog", () => {
    const report = runWealthContextGovernanceContractChecks();
    expect(report.status).toBe("PASS");
    if (report.status !== "PASS") return;
    expect(report.caseCount).toBeGreaterThanOrEqual(15);
    expect(report.categoryCounts).toEqual(
      expect.objectContaining({
        version_correctness: expect.any(Number),
        eligibility: expect.any(Number),
        context_need: expect.any(Number),
        retrieval_location: expect.any(Number),
      })
    );
  });

  it("does not freeze a proposed Golden Set as an expert-confirmed baseline", () => {
    const report = runWealthContextGovernanceContractChecks(process.cwd(), {
      requireExpertConfirmed: true,
    });
    expect(report.status).toBe("FAIL");
    expect(report.errors).toContain(
      "Expert confirmation gate requires all 16 cases; confirmed 0"
    );
  });

  it("rejects an alias shared by two logical Context entries", () => {
    const catalog: LogicalContextCatalogV1 = {
      schemaVersion: "ea.logical-context-catalog.v1",
      catalogVersion: "test",
      entries: [
        {
          canonicalId: "customer_profile",
          contextType: "business_data",
          displayName: "A",
          description: "A",
          aliases: ["customer.profile"],
          status: "active",
        },
        {
          canonicalId: "customer_portfolio",
          contextType: "business_data",
          displayName: "B",
          description: "B",
          aliases: ["customer.profile"],
          status: "active",
        },
      ],
    };
    expect(validateLogicalContextCatalog(catalog)).toContain(
      "Logical Context identifier customer.profile is shared by customer_profile and customer_portfolio"
    );
    expect(
      logicalContextIndex(catalog).get("customer.profile")?.canonicalId
    ).toBe("customer_portfolio");
  });

  it("rejects unregistered Context IDs before a Role Pack is accepted", () => {
    const catalog: LogicalContextCatalogV1 = {
      schemaVersion: "ea.logical-context-catalog.v1",
      catalogVersion: "test",
      entries: [
        {
          canonicalId: "customer_profile",
          contextType: "business_data",
          displayName: "客户画像",
          description: "客户画像",
          aliases: [],
          status: "active",
        },
      ],
    };
    const errors = validateContextNeedPlansAgainstCatalog(
      [
        {
          schema: "ea.context-need-plan.v1",
          planId: "test-plan",
          planVersion: "1",
          rolePackId: "test-role",
          roleTemplate: "test-role",
          taskId: "TEST-GT-01",
          needs: [
            {
              needId: "unknown",
              logicalAssetId: "unknown_context",
              contextType: "knowledge",
              requiredness: "required",
              purpose: "test",
              freshness: { mode: "current_effective" },
            },
          ],
        },
      ],
      catalog
    );
    expect(errors).toEqual([
      "TEST-GT-01: Logical Context unknown_context is not registered",
    ]);
  });
});
