import { describe, expect, it } from "vitest";

import { POST_LOAN_RISK_DEMO_ENTERPRISES } from "./post-loan-risk-demo-fixtures";
import { buildPostLoanRiskSnapshot } from "./post-loan-risk-data-provider";
import {
  materializePostLoanRiskA2APayload,
  POST_LOAN_RISK_A2A_REQUEST_SCHEMA,
  POST_LOAN_RISK_SNAPSHOT_REF_SOURCE,
  validatePostLoanRiskA2APayload,
} from "./post-loan-risk-a2a-contract";

function validPayload() {
  const enterprise = POST_LOAN_RISK_DEMO_ENTERPRISES[0];
  const riskSnapshot = buildPostLoanRiskSnapshot(enterprise);
  return {
    schema: POST_LOAN_RISK_A2A_REQUEST_SCHEMA,
    enterpriseId: enterprise.unifiedSocialCode,
    snapshotFingerprint: riskSnapshot.snapshotFingerprint,
    riskSnapshot,
  };
}

describe("post-loan risk A2A governed payload", () => {
  it("accepts an immutable ready snapshot", () => {
    expect(validatePostLoanRiskA2APayload(validPayload())).toMatchObject({ ok: true });
  });

  it("blocks a snapshot changed after fingerprinting", () => {
    const payload = validPayload();
    const data = payload.riskSnapshot.data as Record<string, unknown>;
    data.domains = { ...(data.domains as Record<string, unknown>), repayment: [] };

    expect(validatePostLoanRiskA2APayload(payload)).toMatchObject({
      ok: false,
      reasonCode: "SNAPSHOT_FINGERPRINT_MISMATCH",
    });
  });

  it("blocks an enterprise identity mismatch", () => {
    const payload = validPayload();
    payload.enterpriseId = POST_LOAN_RISK_DEMO_ENTERPRISES[1].unifiedSocialCode;

    expect(validatePostLoanRiskA2APayload(payload)).toMatchObject({
      ok: false,
      reasonCode: "ENTERPRISE_SNAPSHOT_MISMATCH",
    });
  });

  it("materializes an immutable snapshot reference on the EA server", () => {
    const payload = validPayload();
    delete (payload as Partial<typeof payload>).riskSnapshot;
    const referencedPayload = {
      ...payload,
      snapshotRef: { source: POST_LOAN_RISK_SNAPSHOT_REF_SOURCE },
    };

    const resolved = materializePostLoanRiskA2APayload(
      referencedPayload,
      () => buildPostLoanRiskSnapshot(POST_LOAN_RISK_DEMO_ENTERPRISES[0]),
    );

    expect(resolved).toMatchObject({
      ok: true,
      enterpriseId: POST_LOAN_RISK_DEMO_ENTERPRISES[0].unifiedSocialCode,
      snapshotFingerprint: payload.snapshotFingerprint,
      value: {
        snapshotRef: {
          source: POST_LOAN_RISK_SNAPSHOT_REF_SOURCE,
          resolvedBy: "ea_platform",
        },
        riskSnapshot: {
          snapshotFingerprint: payload.snapshotFingerprint,
        },
      },
    });
  });

  it("fails closed when a referenced snapshot has changed", () => {
    const payload = validPayload();
    const referencedPayload = {
      schema: payload.schema,
      enterpriseId: payload.enterpriseId,
      snapshotFingerprint: payload.snapshotFingerprint,
      snapshotRef: { source: POST_LOAN_RISK_SNAPSHOT_REF_SOURCE },
    };
    const changedSnapshot = buildPostLoanRiskSnapshot(POST_LOAN_RISK_DEMO_ENTERPRISES[0]);
    const data = changedSnapshot.data as Record<string, unknown>;
    data.domains = { ...(data.domains as Record<string, unknown>), repayment: [] };

    expect(materializePostLoanRiskA2APayload(referencedPayload, () => changedSnapshot)).toMatchObject({
      ok: false,
      reasonCode: "SNAPSHOT_REFERENCE_STALE",
    });
  });
});
