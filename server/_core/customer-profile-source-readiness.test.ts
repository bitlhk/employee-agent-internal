import { describe, expect, it } from "vitest";
import { loadCustomerProfileContracts } from "./customer-profile-contracts";
import {
  customerProfileSourceFingerprint,
  normalizeCustomerProfileSource,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";
import { assessCustomerProfileSourceReadiness } from "./customer-profile-source-readiness";

const NOW = "2026-08-24T08:00:00.000Z";

function valueFor(path: string): unknown {
  if (path === "serviceScope.inScope") return true;
  if (path === "demographics.age") return 42;
  if (path.endsWith("confirmedNeeds")) return ["confirmed need"];
  if (path.endsWith("complianceFlags")) return ["none"];
  if (path.endsWith("protectionGaps")) return ["medical"];
  if (path === "insurance.vehicleSummary")
    return [{ vehicleRef: "masked-vehicle" }];
  return `${path}:governed`;
}

function completeSource(): NormalizedCustomerProfileSourceV1 {
  const fields = loadCustomerProfileContracts().contract.fields.map(field => ({
    path: field.path,
    value: valueFor(field.path),
    provenance: {
      sourceSystem: "enterprise_customer_master",
      sourceRecordRef: "customer:opaque",
      asOf: NOW,
      observedAt: NOW,
      mappingRuleVersion: "1.0.0",
    },
  }));
  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: "wealth-assistant-customer-v2.1",
    sourceSystem: "enterprise_customer_master",
    subjectId: "CUST-001",
    sourceRecordRef: "customer:opaque",
    asOf: NOW,
    observedAt: NOW,
    productionReady: true,
    providerGaps: [],
    fields,
    resultFingerprint: "",
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}

describe("Customer Profile Source Readiness Gate", () => {
  it("reports all task gates as ready for a complete governed source", () => {
    const report = assessCustomerProfileSourceReadiness({
      roleTemplate: "wealth-manager",
      principalFingerprint: "principal",
      principalAuthorized: true,
      subjectInScope: true,
      requestedSubjectId: "CUST-001",
      sources: [completeSource()],
      now: new Date(NOW),
    });

    expect(report.status).toBe("READY");
    expect(report.taskEvaluations.every(item => item.status === "READY")).toBe(
      true
    );
    expect(
      report.taskEvaluations.every(
        item => item.observedMissingRequiredFields.length === 0
      )
    ).toBe(true);
    expect(report.containsCustomerValues).toBe(false);
    expect(JSON.stringify(report)).not.toContain("subject.subjectId:governed");
    expect(report.reportFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("diagnoses real legacy Wealth mapping and provider gaps without customer values", () => {
    const source = normalizeCustomerProfileSource({
      sourceContractId: "wealth-assistant-customer-v2.1",
      observedAt: NOW,
      authorization: {
        inScope: true,
        organizationRef: "org-demo",
        principalRef: "principal-wealth",
      },
      payload: {
        updatedAt: NOW,
        data: {
          customer: {
            CUST_NO: "CUST-SECRET-001",
            CUST_NAME: "Secret Customer Name",
            CUSTM_RSK_LVL_CD: "3",
            CUST_RSK_RT_VLD_DT: "2027-01-31",
          },
        },
      },
    });
    const report = assessCustomerProfileSourceReadiness({
      roleTemplate: "wealth-manager",
      principalFingerprint: "principal",
      principalAuthorized: true,
      subjectInScope: true,
      requestedSubjectId: "CUST-SECRET-001",
      sources: [source],
      now: new Date(NOW),
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.sourceContracts[0]?.productionReady).toBe(false);
    expect(report.taskEvaluations[0]?.reasonCodes).toContain(
      "CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY"
    );
    expect(
      report.taskEvaluations.some(item =>
        item.missingRequiredFields.includes("subject.customerStatus")
      )
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("CUST-SECRET-001");
    expect(JSON.stringify(report)).not.toContain("Secret Customer Name");
  });

  it("shows declared insurance task gaps even when no source is authorized", () => {
    const report = assessCustomerProfileSourceReadiness({
      roleTemplate: "insurance-advisor",
      principalFingerprint: "principal",
      principalAuthorized: false,
      subjectInScope: false,
      requestedSubjectId: "unresolved",
      sources: [],
      declaredSourceContractIds: ["insurance-customer-profile-demo-v1"],
      now: new Date(NOW),
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.authorization.principalAuthorized).toBe(false);
    expect(
      report.taskEvaluations.find(item => item.taskId === "IA-GT-01")
        ?.observedMissingRequiredFields
    ).toEqual(
      expect.arrayContaining([
        "subject.subjectId",
        "insurance.renewalAt",
        "insurance.currentCoverageSummary",
      ])
    );
    expect(
      report.taskEvaluations.find(item => item.taskId === "IA-GT-01")
        ?.declaredMissingRequiredFields
    ).toEqual(
      expect.arrayContaining([
        "insurance.renewalAt",
        "insurance.renewalStatus",
        "insurance.currentCoverageSummary",
        "insurance.claimsRiskSummary",
      ])
    );
  });
});
