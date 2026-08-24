import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomerProfileSourceEnvelopeV1 } from "../../shared/customer-profile-contract";
import { projectCustomerProfile } from "./customer-profile-provider";
import {
  adaptCustomerProfileSourceEnvelopeCandidate,
  customerProfileSourceEnvelopeFingerprint,
  validateCustomerProfileSourceEnvelope,
  verifyCustomerProfileSourceImplementationContract,
} from "./customer-profile-source-contract";

const FIXTURE_PATH =
  "examples/customer-profile-contract-v1/source-envelope.valid.fixture.json";

function fixture(): CustomerProfileSourceEnvelopeV1 {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), FIXTURE_PATH), "utf8")
  ) as CustomerProfileSourceEnvelopeV1;
}

function expectedIdentity() {
  return {
    organizationId: "demo-bank",
    principalFingerprint:
      "1111111111111111111111111111111111111111111111111111111111111111",
    authorizationSnapshotId: "auth-snapshot-demo-001",
    authorizationFingerprint:
      "2222222222222222222222222222222222222222222222222222222222222222",
    requestedSubjectId: "DEMO-CUSTOMER-001",
  };
}

function refreshResultFingerprint(envelope: CustomerProfileSourceEnvelopeV1) {
  const { sourceResultFingerprint: _fingerprint, ...body } = envelope;
  envelope.sourceResultFingerprint =
    customerProfileSourceEnvelopeFingerprint(body);
}

describe("Customer Profile Source Contract V1", () => {
  it("freezes a fail-closed engineering candidate contract", () => {
    const report = verifyCustomerProfileSourceImplementationContract();
    expect(report.status).toBe("PASS");
    expect(report.sourceContractId).toBe(
      "enterprise-customer-profile-source-v1"
    );
    expect(report.sourceContractFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.runtimeActivationAllowed).toBe(false);
  });

  it("accepts a canonical envelope without activating it", () => {
    const report = validateCustomerProfileSourceEnvelope({
      envelope: fixture(),
      expectedIdentity: expectedIdentity(),
    });
    expect(report.status).toBe("PASS");
    expect(report.subjectMatched).toBe(true);
    expect(report.rowScopeApplied).toBe(true);
    expect(report.runtimeActivationAllowed).toBe(false);
    expect(report.productionReady).toBe(false);
    expect(report.containsCustomerValues).toBe(false);
    expect(report.fieldPaths).toEqual(
      expect.arrayContaining([
        "subject.customerStatus",
        "relationship.recentContactSummary",
        "preferences.investmentHorizon",
        "insurance.currentCoverageSummary",
      ])
    );
  });

  it("adapts a conformant response as an unpromoted Runtime candidate", () => {
    const source = adaptCustomerProfileSourceEnvelopeCandidate({
      envelope: fixture(),
      expectedIdentity: expectedIdentity(),
    });
    expect(source.productionReady).toBe(false);
    expect(source.providerGaps).toEqual([
      "SOURCE_IMPLEMENTATION_CANDIDATE_NOT_PROMOTED",
    ]);

    const projection = projectCustomerProfile({
      roleTemplate: "wealth-manager",
      taskId: "WM-GT-02",
      requestedSubjectId: "DEMO-CUSTOMER-001",
      principalFingerprint: expectedIdentity().principalFingerprint,
      principalAuthorized: true,
      subjectInScope: true,
      sources: [source],
      now: new Date("2026-08-24T08:01:00.000Z"),
    });
    expect(projection.status).toBe("BLOCKED");
    expect(projection.reasonCodes).toContain(
      "CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY"
    );
  });

  it("rejects caller-supplied purpose and raw source payloads", () => {
    const envelope = fixture() as CustomerProfileSourceEnvelopeV1 & {
      purposeId?: string;
      rawPayload?: unknown;
    };
    envelope.purposeId = "insurance_advisory";
    envelope.rawPayload = { forbidden: true };
    refreshResultFingerprint(envelope);
    const report = validateCustomerProfileSourceEnvelope({
      envelope,
      expectedIdentity: expectedIdentity(),
    });
    expect(report.status).toBe("FAIL");
    expect(report.errors).toEqual(
      expect.arrayContaining([
        "Unexpected envelope property: purposeId",
        "Unexpected envelope property: rawPayload",
      ])
    );
  });

  it("rejects authorization evidence that differs from the Runtime principal", () => {
    const envelope = fixture();
    envelope.authorizationEvidence.authorizationFingerprint = "3".repeat(64);
    refreshResultFingerprint(envelope);
    const report = validateCustomerProfileSourceEnvelope({
      envelope,
      expectedIdentity: expectedIdentity(),
    });
    expect(report.status).toBe("FAIL");
    expect(report.errors).toContain(
      "Authorization fingerprint does not match runtime principal"
    );
  });

  it("rejects missing remediation facts even when the response is re-signed", () => {
    const envelope = fixture();
    envelope.fields = envelope.fields.filter(
      field => field.path !== "insurance.claimsRiskSummary"
    );
    refreshResultFingerprint(envelope);
    const report = validateCustomerProfileSourceEnvelope({
      envelope,
      expectedIdentity: expectedIdentity(),
    });
    expect(report.status).toBe("FAIL");
    expect(report.errors).toContain(
      "Required remediation field is missing: insurance.claimsRiskSummary"
    );
  });

  it("reports malformed Provider responses instead of throwing", () => {
    const report = validateCustomerProfileSourceEnvelope({
      envelope: {
        schemaVersion: "ea.customer-profile-source-envelope.v1",
        fields: null,
      },
      expectedIdentity: expectedIdentity(),
    });
    expect(report.status).toBe("FAIL");
    expect(report.errors).toEqual(
      expect.arrayContaining([
        "Envelope fields must be an array",
        "Envelope deniedFields must be an array",
        "Envelope authorizationEvidence must be an object",
      ])
    );
  });
});
