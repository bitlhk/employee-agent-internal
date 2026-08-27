import { describe, expect, it } from "vitest";
import {
  loadCustomerCrmContracts,
  runCustomerCrmContractChecks,
} from "./customer-crm-contracts";

describe("Customer CRM Contract V1", () => {
  it("freezes identity, field authority and domain-extension boundaries", () => {
    const report = runCustomerCrmContractChecks();
    expect(report.status).toBe("PASS");
    if (report.status !== "PASS") return;
    expect(report.sourceCount).toBe(3);
    expect(report.authorityRuleCount).toBe(10);
    expect(report.profileSchemaCount).toBe(3);
    expect(report.runtimeApprovedFieldCount).toBe(12);
    expect(report.contractFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.boundaries).toEqual({
      heuristicIdentityMergeAllowed: false,
      unconfirmedSuggestionsAreFacts: false,
      productMasterDataInCustomerProfile: false,
      unknownProfileRuntimeAllowed: false,
    });
  });

  it("keeps suggestions and product data out of authoritative customer facts", () => {
    const { authority, identity } = loadCustomerCrmContracts();
    expect(identity.globalCustomerId.namespace).toBe("enterprise_customer");
    expect(
      identity.sources.find(
        source => source.sourceSystem === "wealth_assistant_customer"
      )
    ).toMatchObject({
      sourceCustomerIdPath: "detail.customer.customerId",
      sourceTenantIdPath: "sourceTenantId",
    });
    expect(
      identity.sources
        .filter(source => source.sourceSystem !== "twenty_crm")
        .every(
          source => source.globalCustomerIdStrategy === "crosswalk_required"
        )
    ).toBe(true);
    expect(
      authority.rules.find(rule => rule.fieldPattern === "suggestion.*")
    ).toMatchObject({
      crmWriteMode: "derived",
      confirmationRequired: true,
      runtimeUse: "denied",
    });
    expect(
      authority.rules.find(rule => rule.fieldPattern === "product.*")
    ).toMatchObject({
      crmWriteMode: "reference_only",
      runtimeUse: "denied",
    });
  });

  it("registers the real auto and life insurance detail shapes", () => {
    const { domainSchemas } = loadCustomerCrmContracts();
    const byType = new Map(
      domainSchemas.schemas.map(schema => [schema.profileType, schema])
    );
    expect(
      byType.get("auto_insurance")?.fields.map(field => field.path)
    ).toEqual([
      "detail.vehicleSummary",
      "detail.annualMileage",
      "detail.drivingRecord",
    ]);
    expect(
      byType.get("life_insurance")?.fields.map(field => field.path)
    ).toContain("detail.healthStatus");
  });
});
