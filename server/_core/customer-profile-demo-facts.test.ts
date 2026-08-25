import { describe, expect, it } from "vitest";
import {
  applyDemoWealthCustomerScenario,
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

  it("changes only the C005 risk-validity field for the positive Wealth demo path", () => {
    const base = buildDemoWealthCustomerFacts({ subjectId: "C005" });
    base.fields.push({
      path: "risk.investmentRiskValidUntil",
      value: "2025-12-31T00:00:00.000Z",
      provenance: base.fields[0].provenance,
    });
    base.resultFingerprint = customerProfileSourceFingerprint(base);

    const updated = applyDemoWealthCustomerScenario(base);
    expect(updated.fields.find(field => field.path === "risk.investmentRiskValidUntil")).toMatchObject({
      value: "2027-12-31T23:59:59.000Z",
      provenance: { sourceSystem: "grace_demo_wealth_scenario" },
    });
    expect(updated.providerGaps.join(" ")).toContain("synthetic positive-path Demo fact");
    expect(updated.resultFingerprint).toBe(customerProfileSourceFingerprint(updated));

    expect(applyDemoWealthCustomerScenario({ ...base, subjectId: "C003" })).toEqual({ ...base, subjectId: "C003" });
  });

  it("supplies the two expert-required WM-GT-02 preference facts only for C005", () => {
    const positive = buildDemoWealthCustomerFacts({ subjectId: "C005" });
    const blocked = buildDemoWealthCustomerFacts({ subjectId: "C003" });

    expect(positive.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "preferences.investmentHorizon",
        value: "3年以上",
        provenance: expect.objectContaining({ mappingRuleVersion: "wealth-positive-demo-v1" }),
      }),
      expect.objectContaining({
        path: "preferences.liquidityNeeds",
        value: "保留20%高流动性资产",
        provenance: expect.objectContaining({ mappingRuleVersion: "wealth-positive-demo-v1" }),
      }),
    ]));
    expect(blocked.fields.some(field => field.path.startsWith("preferences."))).toBe(false);
    expect(positive.resultFingerprint).toBe(customerProfileSourceFingerprint(positive));
  });
});
