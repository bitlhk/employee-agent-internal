import { createHash } from "node:crypto";

export const POST_LOAN_RISK_A2A_REQUEST_SCHEMA = "ea.post-loan-risk-assessment-request.v1";
export const POST_LOAN_RISK_SNAPSHOT_SCHEMA = "ea.post-loan-risk-snapshot.v1";
export const POST_LOAN_RISK_SNAPSHOT_REF_SOURCE = "post_loan_risk_data";

type JsonObject = Record<string, unknown>;

export type PostLoanRiskA2AContractResult =
  | { ok: true; value: JsonObject; snapshotFingerprint: string; enterpriseId: string }
  | { ok: false; reasonCode: string; message: string };

export type PostLoanRiskA2AReportResult =
  | { ok: true }
  | { ok: false; reasonCode: string; message: string };

export type PostLoanRiskSnapshotLoader = (enterpriseId: string) => unknown;

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

export function materializePostLoanRiskA2APayload(
  raw: unknown,
  loadSnapshot: PostLoanRiskSnapshotLoader,
): PostLoanRiskA2AContractResult {
  const value = record(raw);
  const snapshotRef = record(value.snapshotRef);
  if (!Object.keys(snapshotRef).length) return validatePostLoanRiskA2APayload(value);

  if (snapshotRef.source !== POST_LOAN_RISK_SNAPSHOT_REF_SOURCE) {
    return {
      ok: false,
      reasonCode: "INVALID_SNAPSHOT_REFERENCE",
      message: "风险快照引用来源不受支持。",
    };
  }

  const enterpriseId = String(value.enterpriseId || "").trim().toUpperCase();
  const declaredFingerprint = String(value.snapshotFingerprint || "").trim().toLowerCase();
  if (!/^[A-Z0-9]{18}$/.test(enterpriseId)) {
    return { ok: false, reasonCode: "INVALID_ENTERPRISE_ID", message: "风险 A2A 请求缺少有效统一社会信用代码。" };
  }
  if (!/^[a-f0-9]{64}$/.test(declaredFingerprint)) {
    return { ok: false, reasonCode: "INVALID_SNAPSHOT_FINGERPRINT", message: "风险 A2A 请求缺少有效快照指纹。" };
  }

  const snapshot = record(loadSnapshot(enterpriseId));
  const hydrated = {
    ...value,
    snapshotRef: {
      source: POST_LOAN_RISK_SNAPSHOT_REF_SOURCE,
      resolvedBy: "ea_platform",
    },
    riskSnapshot: snapshot,
  };
  const validated = validatePostLoanRiskA2APayload(hydrated);
  if (!validated.ok && validated.reasonCode === "SNAPSHOT_FINGERPRINT_MISMATCH") {
    return {
      ok: false,
      reasonCode: "SNAPSHOT_REFERENCE_STALE",
      message: "风险快照引用已变化，请重新获取快照后再提交。",
    };
  }
  return validated;
}

const REQUIRED_REPORT_HEADINGS = [
  "# 贷后风险分析草稿",
  "## 评估对象与快照",
  "## 已核验事实",
  "## 四维诊断",
  "## 红旗指标",
  "## 待核验事项",
  "## 建议人工复核动作",
] as const;

export function validatePostLoanRiskA2AReport(
  report: unknown,
  contract: Extract<PostLoanRiskA2AContractResult, { ok: true }>,
): PostLoanRiskA2AReportResult {
  const text = String(report || "").trim();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < 600 || bytes > 30_000) {
    return {
      ok: false,
      reasonCode: "RISK_REPORT_LENGTH_INVALID",
      message: "远端风险报告长度异常，可能未完成或超出受控输出预算。",
    };
  }

  const payload = contract.value;
  const snapshot = record(payload.riskSnapshot);
  const data = record(snapshot.data);
  const enterprise = record(data.enterprise);
  const enterpriseName = String(
    payload.enterpriseName || enterprise.enterpriseName || enterprise.enterprise_name || "",
  ).trim();

  if (!text.includes(contract.enterpriseId) || !text.includes(contract.snapshotFingerprint)) {
    return {
      ok: false,
      reasonCode: "RISK_REPORT_SNAPSHOT_EVIDENCE_MISSING",
      message: "远端风险报告未包含受治理企业身份或快照指纹。",
    };
  }
  if (enterpriseName && !text.includes(enterpriseName)) {
    return {
      ok: false,
      reasonCode: "RISK_REPORT_ENTERPRISE_MISMATCH",
      message: "远端风险报告未包含受治理企业名称。",
    };
  }

  let previousIndex = -1;
  for (const heading of REQUIRED_REPORT_HEADINGS) {
    const index = text.indexOf(heading);
    if (index < 0 || index <= previousIndex) {
      return {
        ok: false,
        reasonCode: "RISK_REPORT_STRUCTURE_INVALID",
        message: `远端风险报告缺少或错序：${heading}`,
      };
    }
    previousIndex = index;
  }

  if (
    text.includes("最终只输出以下结构")
    || text.includes("## 唯一事实源")
    || text.includes("## 输出格式")
    || /(?:企业|快照指纹)[：:]\s*\.{3}/.test(text)
  ) {
    return {
      ok: false,
      reasonCode: "RISK_REPORT_TEMPLATE_ECHOED",
      message: "远端风险报告回显了技能说明或未填充模板。",
    };
  }

  if (!text.includes("不是监管五级分类、授信审批或自动处置结论")) {
    return {
      ok: false,
      reasonCode: "RISK_REPORT_DISCLAIMER_MISSING",
      message: "远端风险报告缺少人工复核与非自动处置声明。",
    };
  }

  return { ok: true };
}
