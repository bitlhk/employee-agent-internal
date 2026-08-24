import { describe, expect, it } from "vitest";
import { loadCustomerProfileContracts } from "./customer-profile-contracts";
import {
  projectCustomerProfile,
  type CustomerProfileProviderInputV1,
} from "./customer-profile-provider";
import {
  customerProfileSourceFingerprint,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";

const NOW = "2026-08-24T07:00:00.000Z";

function valueFor(path: string): unknown {
  if (path === "serviceScope.inScope") return true;
  if (path === "demographics.age") return 41;
  if (path.endsWith("confirmedNeeds")) return ["governed-need"];
  if (path.endsWith("complianceFlags")) return ["none"];
  if (path.endsWith("protectionGaps")) return ["medical"];
  if (path === "insurance.vehicleSummary")
    return [{ vehicleRef: "masked-vehicle" }];
  return `${path}:value`;
}

function completeSource(
  overrides: Partial<NormalizedCustomerProfileSourceV1> = {}
): NormalizedCustomerProfileSourceV1 {
  const { contract } = loadCustomerProfileContracts();
  const fields = contract.fields.map(field => ({
    path: field.path,
    value: valueFor(field.path),
    provenance: {
      sourceSystem: "enterprise_customer_master",
      sourceRecordRef: "customer-master:record-001",
      asOf: NOW,
      observedAt: NOW,
      mappingRuleVersion: "1.0.0",
    },
  }));
  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: "enterprise-customer-master-v1",
    sourceSystem: "enterprise_customer_master",
    subjectId: "CUST-001",
    sourceRecordRef: "customer-master:record-001",
    asOf: NOW,
    observedAt: NOW,
    productionReady: true,
    providerGaps: [],
    fields,
    resultFingerprint: "",
    ...overrides,
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}

function request(
  overrides: Partial<CustomerProfileProviderInputV1> = {}
): CustomerProfileProviderInputV1 {
  return {
    roleTemplate: "wealth-manager",
    requestedSubjectId: "CUST-001",
    principalFingerprint: "principal-fingerprint",
    principalAuthorized: true,
    subjectInScope: true,
    sources: [completeSource()],
    now: new Date(NOW),
    ...overrides,
  };
}

describe("Customer Profile Provider", () => {
  it("projects different governed views from the same canonical source", () => {
    const wealth = projectCustomerProfile(request());
    const insurance = projectCustomerProfile(
      request({ roleTemplate: "insurance-advisor" })
    );

    expect(wealth.status).toBe("READY");
    expect(wealth.purposeId).toBe("wealth_advisory");
    expect(wealth.fields.some(field => field.path === "wealth.aumBand")).toBe(
      true
    );
    expect(
      wealth.fields.some(field => field.path.startsWith("insurance."))
    ).toBe(false);

    expect(insurance.status).toBe("READY");
    expect(insurance.purposeId).toBe("insurance_advisory");
    expect(
      insurance.fields.some(field => field.path === "insurance.renewalAt")
    ).toBe(true);
    expect(
      insurance.fields.some(field => field.path.startsWith("wealth."))
    ).toBe(false);
    expect(insurance.sourceEvidence[0]?.resultFingerprint).toBe(
      wealth.sourceEvidence[0]?.resultFingerprint
    );
  });

  it("denies roles that have no confirmed customer service purpose", () => {
    for (const roleTemplate of [
      "investment-researcher",
      "post-loan-risk-control",
    ]) {
      const result = projectCustomerProfile(request({ roleTemplate }));
      expect(result.status).toBe("BLOCKED");
      expect(result.reasonCodes).toContain("ROLE_PROJECTION_DENIED");
      expect(result.fields).toEqual([]);
    }
  });

  it("keeps audit access case-bound and minimizes the returned fields", () => {
    const blocked = projectCustomerProfile(
      request({ roleTemplate: "credential-compliance" })
    );
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reasonCodes).toContain("AUDIT_CASE_SCOPE_REQUIRED");
    expect(blocked.fields).toEqual([]);

    const allowed = projectCustomerProfile(
      request({
        roleTemplate: "credential-compliance",
        auditCaseScopeVerified: true,
        auditCaseSubjectMatches: true,
      })
    );
    expect(allowed.status).toBe("READY");
    expect(allowed.fields.map(field => field.path)).toEqual([
      "risk.complianceFlags",
      "serviceScope.inScope",
      "subject.customerStatus",
      "subject.displayName",
      "subject.subjectId",
      "subject.subjectType",
    ]);
  });

  it("fails closed for authorization, subject and source readiness gaps", () => {
    const cases: CustomerProfileProviderInputV1[] = [
      request({ principalAuthorized: false }),
      request({ subjectInScope: false }),
      request({
        requestedSubjectId: "CUST-002",
      }),
      request({
        sources: [completeSource({ productionReady: false })],
      }),
    ];
    const expectedReasons = [
      "PRINCIPAL_NOT_AUTHORIZED",
      "SUBJECT_OUT_OF_SCOPE",
      "CUSTOMER_PROFILE_SUBJECT_MISMATCH",
      "CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY",
    ];

    cases.forEach((input, index) => {
      const result = projectCustomerProfile(input);
      expect(result.status).toBe("BLOCKED");
      expect(result.reasonCodes).toContain(expectedReasons[index]);
      expect(result.fields).toEqual([]);
    });
  });

  it("blocks conflicting enterprise facts instead of selecting a winner", () => {
    const second = completeSource({
      sourceContractId: "enterprise-customer-secondary-v1",
      sourceSystem: "enterprise_customer_secondary",
      fields: completeSource().fields.map(field =>
        field.path === "subject.customerStatus"
          ? { ...field, value: "suspended" }
          : field
      ),
    });
    const result = projectCustomerProfile(
      request({ sources: [completeSource(), second] })
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.reasonCodes).toContain("CUSTOMER_PROFILE_FIELD_CONFLICT");
    expect(result.conflictingFields).toContain("subject.customerStatus");
    expect(result.fields).toEqual([]);
  });

  it("composes disjoint canonical facts while preserving source provenance", () => {
    const complete = completeSource();
    const customerMaster = completeSource({
      sourceContractId: "enterprise-customer-master-v1",
      sourceSystem: "enterprise_customer_master",
      sourceRecordRef: "customer-master:record-001",
      fields: complete.fields.filter(
        field => !field.path.startsWith("insurance.")
      ),
    });
    customerMaster.resultFingerprint =
      customerProfileSourceFingerprint(customerMaster);

    const insurancePolicy = completeSource({
      sourceContractId: "insurance-policy-facts-v1",
      sourceSystem: "insurance_policy_system",
      sourceRecordRef: "insurance-policy:record-001",
      fields: complete.fields
        .filter(field => field.path.startsWith("insurance."))
        .map(field => ({
          ...field,
          provenance: {
            ...field.provenance,
            sourceSystem: "insurance_policy_system",
            sourceRecordRef: "insurance-policy:record-001",
          },
        })),
    });
    insurancePolicy.resultFingerprint =
      customerProfileSourceFingerprint(insurancePolicy);

    const result = projectCustomerProfile(
      request({
        roleTemplate: "insurance-advisor",
        taskId: "IA-GT-01",
        sources: [customerMaster, insurancePolicy],
      })
    );

    expect(result.status).toBe("READY");
    expect(result.sourceEvidence).toHaveLength(2);
    expect(
      result.fields.find(field => field.path === "subject.subjectId")
        ?.provenance.sourceSystem
    ).toBe("enterprise_customer_master");
    expect(
      result.fields.find(field => field.path === "insurance.renewalAt")
        ?.provenance.sourceSystem
    ).toBe("insurance_policy_system");
  });

  it("enforces task-required fields before a profile can be provided", () => {
    const source = completeSource();
    source.fields = source.fields.filter(
      field => field.path !== "risk.investmentRiskLevel"
    );
    source.resultFingerprint = customerProfileSourceFingerprint(source);
    const result = projectCustomerProfile(
      request({ taskId: "WM-GT-02", sources: [source] })
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.reasonCodes).toContain(
      "CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"
    );
    expect(result.missingRequiredFields).toContain("risk.investmentRiskLevel");
    expect(result.fields).toEqual([]);
  });

  it("blocks invalid field types, provenance and source fingerprints", () => {
    const source = completeSource();
    const riskField = source.fields.find(
      field => field.path === "risk.investmentRiskLevel"
    );
    if (!riskField) throw new Error("risk fixture missing");
    riskField.value = ["invalid-type"];
    riskField.provenance.asOf = "";
    const result = projectCustomerProfile(request({ sources: [source] }));

    expect(result.status).toBe("BLOCKED");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "CUSTOMER_PROFILE_SOURCE_FINGERPRINT_INVALID",
        "CUSTOMER_PROFILE_FIELD_TYPE_INVALID",
        "CUSTOMER_PROFILE_PROVENANCE_MISSING",
      ])
    );
    expect(result.invalidFields).toContain("risk.investmentRiskLevel");
    expect(result.invalidProvenanceFields).toContain(
      "risk.investmentRiskLevel"
    );
    expect(result.fields).toEqual([]);
  });
});
