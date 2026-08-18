import { readFileSync } from "node:fs";
import path from "node:path";
import { buildResponseEvidence, extractTrustedContextReceipt } from "./governance/response-evidence";
import { evaluatePostLoanRiskEscalation } from "./post-loan-risk-policy";
import { runPostLoanRiskRolePackContractChecks } from "./reference-role-pack-contracts";
import { attachReferenceRoleTaskReceipt } from "./reference-role-task-evidence";

type ScenarioCheck = { assertion: string; passed: boolean; actual?: unknown };
type ScenarioResult = {
  scenarioId: string;
  taskId: `RC-GT-0${1 | 2 | 3 | 4 | 5 | 6}`;
  status: "PASS" | "FAIL";
  checks: ScenarioCheck[];
};

const NOW = new Date("2026-08-18T00:00:00.000Z");
const common = {
  roleTemplate: "post-loan-risk-control",
  principalFingerprint: "p".repeat(64),
  capabilityVersion: "1",
  policyDecision: {
    decisionId: "rc-controlled-decision",
    policyCode: "EA_ENTERPRISE_MCP_POLICY",
    ruleVersion: "enterprise-mcp-v1",
    effect: "ALLOW" as const,
  },
  requestId: "rc-controlled-request",
  argumentsFingerprint: "a".repeat(64),
  failed: false,
  now: NOW,
};

function check(assertion: string, passed: boolean, actual?: unknown): ScenarioCheck {
  return { assertion, passed, ...(passed || actual === undefined ? {} : { actual }) };
}

function readReceipt(toolName: string) {
  return extractTrustedContextReceipt(`enterprise_${toolName}`, attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "controlled fixture result" }] },
    serverId: "post_loan_risk_data",
    toolName,
    sideEffect: "read",
    resultFingerprint: `${toolName.charCodeAt(0).toString(16)}`.repeat(64).slice(0, 64),
  }));
}

export async function runPostLoanRiskRolePackControlledScenarios(root = process.cwd()) {
  const contract = runPostLoanRiskRolePackContractChecks(root);
  const panoramaReceipt = readReceipt("get_enterprise_profile");
  const financialReceipt = readReceipt("get_financial_statements");
  const collateralReceipt = readReceipt("get_collateral_info");
  const externalReceipt = readReceipt("get_judicial_info");
  const industryReceipt = readReceipt("get_industry_benchmark");
  const riskDecision = evaluatePostLoanRiskEscalation({
    roleTemplate: "post-loan-risk-control",
    overdueDays: 45,
    fiveLevelClass: "关注",
    ratingDowngradeSteps: 2,
    criticalDataComplete: true,
  });
  const blockedDecision = evaluatePostLoanRiskEscalation({
    roleTemplate: "post-loan-risk-control",
    criticalDataComplete: false,
  });
  const followupReceipt = extractTrustedContextReceipt("enterprise_demo_create_followup_task", attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "created" }] },
    serverId: "wealth_governance_demo",
    toolName: "demo_create_followup_task",
    sideEffect: "write",
    resultFingerprint: "f".repeat(64),
    approvalId: "approval-controlled",
    externalRequestId: "DEMO-RISK-FOLLOWUP",
    idempotencyProtected: true,
  }));
  const responseEvidence = buildResponseEvidence({
    receipts: [panoramaReceipt, followupReceipt].filter((item): item is NonNullable<typeof item> => Boolean(item)),
    correlationId: "rc-controlled-closed-loop",
    assistantMessageId: "rc-controlled-message",
    responseText: "已完成企业贷后核查，并在确认后创建复评跟踪任务。",
    citedKnowledgeSources: [{ documentId: "rc-panorama-sop", documentName: "企业贷后全景核查作业指导书", documentVersion: "V1.0" }],
    now: NOW,
  });
  const manifest = JSON.parse(readFileSync(path.join(root, "examples", "post-loan-risk-control-reference-role-pack", "knowledge", "manifest.json"), "utf8")) as {
    assets: Array<{ assetId: string; lifecycle: string; taskIds: string[] }>;
  };
  const covered = (taskId: string) => manifest.assets.some((asset) => asset.taskIds.includes(taskId));
  const scenarios: ScenarioResult[] = [
    {
      scenarioId: "RC-GT-01-CONTROLLED-PANORAMA",
      taskId: "RC-GT-01",
      status: panoramaReceipt?.taskId === "RC-GT-01" ? "PASS" : "FAIL",
      checks: [
        check("enterprise_profile_context_receipt_is_present", panoramaReceipt?.taskId === "RC-GT-01"),
        check("raw_business_payload_is_not_copied", !JSON.stringify(panoramaReceipt).includes("controlled fixture result")),
      ],
    },
    {
      scenarioId: "RC-GT-02-CONTROLLED-FINANCIAL",
      taskId: "RC-GT-02",
      status: financialReceipt?.taskId === "RC-GT-02" ? "PASS" : "FAIL",
      checks: [check("financial_context_receipt_is_present", financialReceipt?.taskId === "RC-GT-02"), check("task_has_current_knowledge", covered("RC-GT-02"))],
    },
    {
      scenarioId: "RC-GT-03-CONTROLLED-COLLATERAL",
      taskId: "RC-GT-03",
      status: collateralReceipt?.taskId === "RC-GT-03" ? "PASS" : "FAIL",
      checks: [check("collateral_context_receipt_is_present", collateralReceipt?.taskId === "RC-GT-03"), check("task_has_current_knowledge", covered("RC-GT-03"))],
    },
    {
      scenarioId: "RC-GT-04-CONTROLLED-EXTERNAL-RISK",
      taskId: "RC-GT-04",
      status: externalReceipt?.taskId === "RC-GT-04" ? "PASS" : "FAIL",
      checks: [check("external_risk_context_receipt_is_present", externalReceipt?.taskId === "RC-GT-04"), check("task_has_current_knowledge", covered("RC-GT-04"))],
    },
    {
      scenarioId: "RC-GT-05-CONTROLLED-POLICY",
      taskId: "RC-GT-05",
      status: riskDecision.level === "ORANGE" && blockedDecision.formalConclusionAllowed === false && industryReceipt?.taskId === "RC-GT-05" ? "PASS" : "FAIL",
      checks: [
        check("industry_context_receipt_is_present", industryReceipt?.taskId === "RC-GT-05"),
        check("deterministic_policy_returns_orange", riskDecision.level === "ORANGE", riskDecision),
        check("missing_critical_data_blocks_formal_conclusion", blockedDecision.formalConclusionAllowed === false),
        check("historical_policy_is_not_active", manifest.assets.some((asset) => asset.assetId === "rc-escalation-policy-v1.0" && asset.lifecycle === "expired")),
      ],
    },
    {
      scenarioId: "RC-GT-06-CONTROLLED-FOLLOWUP",
      taskId: "RC-GT-06",
      status: followupReceipt?.taskId === "RC-GT-06" && responseEvidence?.receiptBundle.stages.length === 2 ? "PASS" : "FAIL",
      checks: [
        check("confirmed_followup_business_receipt_is_present", followupReceipt?.applied.capabilityExecutions[0]?.approvalId === "approval-controlled"),
        check("followup_is_idempotency_protected", followupReceipt?.applied.capabilityExecutions[0]?.idempotencyProtected === true),
        check("response_evidence_bundles_read_and_write_stages", responseEvidence?.receiptBundle.stages.length === 2),
      ],
    },
  ];
  const errors = scenarios.filter((scenario) => scenario.status === "FAIL").map((scenario) => scenario.scenarioId);
  return {
    schema: "ea.reference-role-pack-scenario-report.v1",
    status: contract.status === "PASS" && !errors.length ? "PASS" : "FAIL",
    executionLevel: "controlled_scenario" as const,
    rolePackId: contract.rolePackId,
    roleTemplate: contract.roleTemplate,
    evalSuiteVersion: contract.evalSuiteVersion,
    releaseCandidateId: contract.releaseCandidateId,
    assetSetFingerprint: contract.assetSetFingerprint,
    scenarioCount: scenarios.length,
    scenarios,
    errors: [...contract.errors, ...errors],
  };
}
