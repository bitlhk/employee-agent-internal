import { createHash } from "node:crypto";

export const POST_LOAN_RISK_A2A_REQUEST_SCHEMA = "ea.post-loan-risk-assessment-request.v1";
export const POST_LOAN_RISK_SNAPSHOT_SCHEMA = "ea.post-loan-risk-snapshot.v1";

type JsonObject = Record<string, unknown>;

export type PostLoanRiskA2AContractResult =
  | { ok: true; value: JsonObject; snapshotFingerprint: string; enterpriseId: string }
  | { ok: false; reasonCode: string; message: string };

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function snapshotFingerprint(snapshot: JsonObject): string {
  const { resultFingerprint: _resultFingerprint, snapshotFingerprint: _snapshotFingerprint, ...payload } = snapshot;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function validatePostLoanRiskA2APayload(raw: unknown): PostLoanRiskA2AContractResult {
  const value = record(raw);
  if (value.schema !== POST_LOAN_RISK_A2A_REQUEST_SCHEMA) {
    return { ok: false, reasonCode: "INVALID_REQUEST_SCHEMA", message: "风险 A2A 请求 schema 不受支持。" };
  }

  const enterpriseId = String(value.enterpriseId || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{18}$/.test(enterpriseId)) {
    return { ok: false, reasonCode: "INVALID_ENTERPRISE_ID", message: "风险 A2A 请求缺少有效统一社会信用代码。" };
  }

  const declaredFingerprint = String(value.snapshotFingerprint || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(declaredFingerprint)) {
    return { ok: false, reasonCode: "INVALID_SNAPSHOT_FINGERPRINT", message: "风险 A2A 请求缺少有效快照指纹。" };
  }

  const snapshot = record(value.riskSnapshot);
  if (snapshot.schema !== POST_LOAN_RISK_SNAPSHOT_SCHEMA || snapshot.status !== "READY") {
    return { ok: false, reasonCode: "SNAPSHOT_NOT_READY", message: "风险快照未达到 READY 状态。" };
  }

  const storedFingerprint = String(snapshot.snapshotFingerprint || "").trim().toLowerCase();
  const resultFingerprint = String(snapshot.resultFingerprint || "").trim().toLowerCase();
  const computedFingerprint = snapshotFingerprint(snapshot);
  if (
    storedFingerprint !== declaredFingerprint ||
    resultFingerprint !== declaredFingerprint ||
    computedFingerprint !== declaredFingerprint
  ) {
    return { ok: false, reasonCode: "SNAPSHOT_FINGERPRINT_MISMATCH", message: "风险快照指纹校验失败。" };
  }

  const data = record(snapshot.data);
  const completeness = record(data.completeness);
  if (completeness.criticalComplete !== true) {
    return { ok: false, reasonCode: "CRITICAL_RISK_DATA_INCOMPLETE", message: "风险快照关键数据不完整。" };
  }

  const snapshotEnterprise = record(data.enterprise);
  const snapshotEnterpriseId = String(
    snapshotEnterprise.enterpriseId || snapshotEnterprise.unifiedSocialCode || "",
  ).trim().toUpperCase();
  if (snapshotEnterpriseId !== enterpriseId) {
    return { ok: false, reasonCode: "ENTERPRISE_SNAPSHOT_MISMATCH", message: "风险快照与评估企业不一致。" };
  }

  const constraints = record(data.constraints);
  if (
    constraints.regulatoryClassificationAllowed !== false ||
    constraints.automaticCreditActionAllowed !== false ||
    constraints.humanReviewRequired !== true
  ) {
    return { ok: false, reasonCode: "UNSAFE_SNAPSHOT_CONSTRAINTS", message: "风险快照缺少必要的人工复核与禁止自动处置约束。" };
  }

  return { ok: true, value, snapshotFingerprint: declaredFingerprint, enterpriseId };
}
