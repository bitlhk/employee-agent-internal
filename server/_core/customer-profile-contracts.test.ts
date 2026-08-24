import { describe, expect, it } from "vitest";
import {
  loadCustomerProfileContracts,
  runCustomerProfileContractChecks,
} from "./customer-profile-contracts";

describe("Customer Profile Contract V1", () => {
  it("validates the canonical contract, five Role projections and source mappings", () => {
    const report = runCustomerProfileContractChecks();
    expect(report.status).toBe("PASS");
    if (report.status !== "PASS") return;
    expect(report.canonicalLogicalContextId).toBe("customer_profile");
    expect(report.canonicalFieldCount).toBe(35);
    expect(report.projectionCount).toBe(5);
    expect(report.sourceContractCount).toBe(2);
    expect(report.productionReadySourceCount).toBe(0);
    expect(report.businessContractFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.sourceMappingFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps engineering proposals out of the domain-confirmed freeze gate", () => {
    const report = runCustomerProfileContractChecks(process.cwd(), {
      requireDomainConfirmed: true,
    });
    expect(report.status).toBe("FAIL");
    expect(report.errors).toContain(
      "Domain confirmation gate requires all 6 reviews and all contract artifacts; confirmed 0"
    );
  });

  it("defines explicit access semantics for all five reference roles", () => {
    const { projections } = loadCustomerProfileContracts();
    const byId = new Map(
      projections.projections.map(item => [item.projectionId, item])
    );

    expect(byId.get("WealthCustomerProfileV1")?.access).toBe("allow");
    expect(byId.get("InsuranceCustomerProfileV1")?.access).toBe("allow");
    expect(byId.get("InvestmentResearchCustomerProfileDeniedV1")?.access).toBe(
      "deny"
    );
    expect(byId.get("PostLoanRiskCustomerProfileDeniedV1")).toMatchObject({
      access: "deny",
      alternativeLogicalContextId: "enterprise_profile",
    });
    expect(byId.get("AuditCustomerSubjectProjectionV1")?.access).toBe(
      "conditional"
    );
  });

  it("does not expose broad wealth payloads through customer_profile", () => {
    const { contract, projections } = loadCustomerProfileContracts();
    const fields = new Set(contract.fields.map(field => field.path));
    expect(fields.has("contact.phone")).toBe(false);
    expect(fields.has("contact.address")).toBe(false);
    expect(fields.has("wealth.exactBalance")).toBe(false);
    expect(fields.has("wealth.holdings")).toBe(false);
    expect(fields.has("wealth.recommendations")).toBe(false);

    const insurance = projections.projections.find(
      item => item.projectionId === "InsuranceCustomerProfileV1"
    );
    expect(
      insurance?.fields.some(field => field.path.startsWith("wealth."))
    ).toBe(false);
  });
});
