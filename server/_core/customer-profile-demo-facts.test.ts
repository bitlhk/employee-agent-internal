import { describe, expect, it } from "vitest";
import {
  buildDemoWealthCustomerFacts,
  loadDemoInsuranceCustomerFacts,
} from "./customer-profile-demo-facts";
import { customerProfileSourceFingerprint } from "./customer-profile-source-adapters";

describe("Customer Profile Demo facts", () => {
  it("provides only the governed synthetic fields for a known stable id", () => {
    const source = loadDemoInsuranceCustomerFacts({
      subjectId: "1",
      organizationRef: "org-demo",
      principalRef: "principal-demo",
      observedAt: "2026-08-24T10:00:00.000Z",
    });

    expect(source).toMatchObject({
      sourceContractId: "grace-demo-insurance-facts-v1",
      sourceSystem: "grace_demo_insurance_facts",
      subjectId: "1",
      productionReady: false,
      assuranceLevel: "demo",
    });
    expect(source?.fields.map(field => field.path).sort()).toEqual([
      "insurance.claimsRiskSummary",
      "insurance.currentCoverageSummary",
      "insurance.renewalAt",
      "insurance.renewalStatus",
      "serviceScope.inScope",
    ]);
    expect(source?.resultFingerprint).toBe(
      source ? customerProfileSourceFingerprint(source) : ""
    );
    expect(JSON.stringify(source)).not.toContain("customerName");
  });

  it("does not invent facts for an unknown subject", () => {
    expect(
      loadDemoInsuranceCustomerFacts({
        subjectId: "999",
        organizationRef: "org-demo",
        principalRef: "principal-demo",
      })
    ).toBeNull();
  });

  it("adds only the minimum synthetic Wealth facts after subject resolution", () => {
    const source = buildDemoWealthCustomerFacts({
      subjectId: "CUST-DEMO-01",
      observedAt: "2026-08-24T10:00:00.000Z",
    });
    expect(source).toMatchObject({
      sourceContractId: "grace-demo-wealth-facts-v1",
      sourceSystem: "grace_demo_wealth_facts",
      subjectId: "CUST-DEMO-01",
      assuranceLevel: "demo",
      productionReady: false,
    });
    expect(source.fields.map(field => field.path).sort()).toEqual([
      "relationship.recentContactSummary",
      "subject.customerStatus",
    ]);
    expect(source.resultFingerprint).toBe(customerProfileSourceFingerprint(source));
  });
});
