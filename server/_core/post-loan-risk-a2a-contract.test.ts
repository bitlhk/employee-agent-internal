import { describe, expect, it } from "vitest";

import { POST_LOAN_RISK_DEMO_ENTERPRISES } from "./post-loan-risk-demo-fixtures";
import { buildPostLoanRiskSnapshot } from "./post-loan-risk-data-provider";
import {
  materializePostLoanRiskA2APayload,
  POST_LOAN_RISK_A2A_REQUEST_SCHEMA,
  POST_LOAN_RISK_SNAPSHOT_REF_SOURCE,
  validatePostLoanRiskA2APayload,
  validatePostLoanRiskA2AReport,
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

describe("post-loan risk A2A governed report", () => {
  function validReport() {
    const payload = validatePostLoanRiskA2APayload(validPayload());
    if (!payload.ok) throw new Error(payload.message);
    return {
      payload,
      report: [
        "# 贷后风险分析草稿",
        "",
        "## 评估对象与快照",
        `- 企业：鸿远建设集团有限公司（${payload.enterpriseId}）`,
        `- 快照指纹：${payload.snapshotFingerprint}`,
        "- 数据时间：2026-08-25T08:00:00+08:00",
        "",
        "## 已核验事实",
        "- 营业收入连续下降，来源：financial。",
        "- 内部评级由 A 下调至 BBB，来源：creditRating。",
        "",
        "## 四维诊断",
        "- 经营与财务：收入、利润及经营现金流均下降。",
        "- 信用与外部事件：存在评级下调及在审合同纠纷。",
        "- 债项与缓释：近期有逾期记录，押品覆盖倍数为 1.2。",
        "- 行业与宏观：仅依据快照内行业和宏观域。",
        "",
        "## 红旗指标",
        "- 内部评级下调。",
        "- 近六个月存在逾期。",
        "",
        "## 待核验事项",
        "- 核验合同纠纷进展。",
        "",
        "## 建议人工复核动作",
        "- 建议人工复核评级下调原因和还款安排。",
        "",
        "> 本结果为内部风险预警分析草稿，不是监管五级分类、授信审批或自动处置结论。",
        "补充说明：所有结论均须由有权人员复核，系统未执行任何授信、账户或押品变更。",
      ].join("\n"),
    };
  }

  it("accepts a complete report tied to the governed snapshot", () => {
    const { payload, report } = validReport();
    expect(validatePostLoanRiskA2AReport(report, payload)).toEqual({ ok: true });
  });

  it("rejects a skill template even when it resembles a final envelope", () => {
    const { payload } = validReport();
    const template = `${"x".repeat(700)}\n## 唯一事实源\n## 输出格式\n企业：...\n快照指纹：...`;
    expect(validatePostLoanRiskA2AReport(template, payload)).toMatchObject({
      ok: false,
      reasonCode: "RISK_REPORT_SNAPSHOT_EVIDENCE_MISSING",
    });
  });

  it("rejects a report for a different snapshot", () => {
    const { payload, report } = validReport();
    expect(validatePostLoanRiskA2AReport(
      report.replace(payload.snapshotFingerprint, "f".repeat(64)),
      payload,
    )).toMatchObject({
      ok: false,
      reasonCode: "RISK_REPORT_SNAPSHOT_EVIDENCE_MISSING",
    });
  });

  it("rejects an incomplete report", () => {
    const { payload, report } = validReport();
    expect(validatePostLoanRiskA2AReport(
      report.replace("## 建议人工复核动作", "## 后续"),
      payload,
    )).toMatchObject({
      ok: false,
      reasonCode: "RISK_REPORT_STRUCTURE_INVALID",
    });
  });
});
