import { describe, expect, it } from "vitest";

import { POST_LOAN_RISK_DEMO_ENTERPRISES } from "./post-loan-risk-demo-fixtures";
import { buildPostLoanRiskSnapshot } from "./post-loan-risk-data-provider";
import {
  POST_LOAN_RISK_A2A_REQUEST_SCHEMA,
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
});
