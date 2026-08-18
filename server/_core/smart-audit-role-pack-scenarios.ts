import { readFileSync } from "node:fs";
import path from "node:path";
import { buildResponseEvidence, extractTrustedContextReceipt } from "./governance/response-evidence";
import { runSmartAuditRolePackContractChecks } from "./reference-role-pack-contracts";
import { attachReferenceRoleTaskReceipt } from "./reference-role-task-evidence";
import {
  evaluateAuditHumanReviewGate,
  evaluateAuditRequiredMaterials,
  evaluateAuditRuleVersionEligibility,
} from "./smart-audit-policy";

type ScenarioCheck = { assertion: string; passed: boolean; actual?: unknown };
type ScenarioResult = {
  scenarioId: string;
  taskId: `AU-GT-0${1 | 2 | 3 | 4 | 5 | 6}`;
  status: "PASS" | "FAIL";
  checks: ScenarioCheck[];
};

const NOW = new Date("2026-08-18T00:00:00.000Z");
const common = {
  roleTemplate: "credential-compliance",
  principalFingerprint: "p".repeat(64),
  capabilityVersion: "1",
  policyDecision: {
    decisionId: "au-controlled-decision",
    policyCode: "EA_ENTERPRISE_MCP_POLICY",
    ruleVersion: "enterprise-mcp-v1",
    effect: "ALLOW" as const,
  },
  requestId: "au-controlled-request",
  argumentsFingerprint: "a".repeat(64),
  failed: false,
  now: NOW,
};

function check(assertion: string, passed: boolean, actual?: unknown): ScenarioCheck {
  return { assertion, passed, ...(passed || actual === undefined ? {} : { actual }) };
}

export async function runSmartAuditRolePackControlledScenarios(root = process.cwd()) {
  const contract = runSmartAuditRolePackContractChecks(root);
  const extractionReceipt = extractTrustedContextReceipt("enterprise_credential_image_extract_from_workspace", attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "controlled credential extraction" }] },
    serverId: "credential_image_workspace",
    toolName: "credential_image_extract_from_workspace",
    sideEffect: "read",
    resultFingerprint: "e".repeat(64),
  }));
  const reviewReceipt = extractTrustedContextReceipt("enterprise_demo_create_audit_review_task", attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "created" }] },
    serverId: "wealth_governance_demo",
    toolName: "demo_create_audit_review_task",
    sideEffect: "write",
    resultFingerprint: "f".repeat(64),
    approvalId: "approval-controlled",
    externalRequestId: "DEMO-AUDIT-REVIEW-CONTROLLED",
    idempotencyProtected: true,
  }));
  const materialReady = evaluateAuditRequiredMaterials({
    roleTemplate: "credential-compliance",
    requiredMaterialTypes: ["申请表", "身份证明"],
    providedMaterialTypes: ["身份证明", "申请表"],
  });
  const materialBlocked = evaluateAuditRequiredMaterials({
    roleTemplate: "credential-compliance",
    requiredMaterialTypes: ["申请表", "收入证明"],
    providedMaterialTypes: ["申请表"],
  });
  const ruleDecision = evaluateAuditRuleVersionEligibility({
    roleTemplate: "credential-compliance",
    asOf: NOW.toISOString(),
    candidates: [
      { assetId: "au-audit-rule-policy-v1.0", versionLabel: "V1.0", lifecycle: "expired", effectiveAt: "2025-01-01T00:00:00.000Z", expiresAt: "2026-06-30T23:59:59.000Z", applicableRoles: ["credential-compliance"] },
      { assetId: "au-audit-rule-policy-v2.0", versionLabel: "V2.0", lifecycle: "active", effectiveAt: "2026-07-01T00:00:00.000Z", applicableRoles: ["credential-compliance"] },
    ],
  });
  const humanGate = evaluateAuditHumanReviewGate({
    roleTemplate: "credential-compliance",
    criticalMissing: false,
    criticalConflicts: true,
    ruleVersionReady: true,
    imageVerificationUncertain: false,
    highRiskRuleHit: true,
    finalDecisionRequested: true,
  });
  const responseEvidence = buildResponseEvidence({
    receipts: [extractionReceipt, reviewReceipt].filter((item): item is NonNullable<typeof item> => Boolean(item)),
    correlationId: "au-controlled-closed-loop",
    assistantMessageId: "au-controlled-message",
    responseText: "已提取凭证要素，并在确认后创建人工复核任务。",
    citedKnowledgeSources: [{ documentId: "au-human-review-policy", documentName: "审核疑点分级与人工复核细则", documentVersion: "V1.0" }],
    now: NOW,
  });
  const manifest = JSON.parse(readFileSync(path.join(root, "examples", "smart-audit-reference-role-pack", "knowledge", "manifest.json"), "utf8")) as {
    assets: Array<{ assetId: string; lifecycle: string; taskIds: string[] }>;
  };
  const covered = (taskId: string) => manifest.assets.some((asset) => asset.taskIds.includes(taskId));
  const scenarios: ScenarioResult[] = [
    {
      scenarioId: "AU-GT-01-CONTROLLED-INTAKE",
      taskId: "AU-GT-01",
      status: covered("AU-GT-01") ? "PASS" : "FAIL",
      checks: [check("task_has_current_intake_knowledge", covered("AU-GT-01")), check("historical_rule_is_not_used_for_intake", !manifest.assets.some((asset) => asset.assetId === "au-audit-rule-policy-v1.0" && asset.lifecycle === "active"))],
    },
    {
      scenarioId: "AU-GT-02-CONTROLLED-EXTRACTION",
      taskId: "AU-GT-02",
      status: extractionReceipt?.taskId === "AU-GT-02" ? "PASS" : "FAIL",
      checks: [
        check("credential_context_receipt_is_present", extractionReceipt?.taskId === "AU-GT-02"),
        check("raw_credential_payload_is_not_copied", !JSON.stringify(extractionReceipt).includes("controlled credential extraction")),
      ],
    },
    {
      scenarioId: "AU-GT-03-CONTROLLED-MATERIAL-POLICY",
      taskId: "AU-GT-03",
      status: materialReady.formalReviewAllowed && !materialBlocked.formalReviewAllowed ? "PASS" : "FAIL",
      checks: [check("complete_materials_allow_working_review", materialReady.formalReviewAllowed), check("missing_material_blocks_formal_review", !materialBlocked.formalReviewAllowed)],
    },
    {
      scenarioId: "AU-GT-04-CONTROLLED-RULE-ELIGIBILITY",
      taskId: "AU-GT-04",
      status: ruleDecision.selectedAssetIds[0] === "au-audit-rule-policy-v2.0" ? "PASS" : "FAIL",
      checks: [check("current_rule_is_selected", ruleDecision.selectedAssetIds.includes("au-audit-rule-policy-v2.0")), check("historical_rule_is_excluded", ruleDecision.excluded.some((item) => item.assetId === "au-audit-rule-policy-v1.0"))],
    },
    {
      scenarioId: "AU-GT-05-CONTROLLED-HUMAN-GATE",
      taskId: "AU-GT-05",
      status: humanGate.level === "L4" && humanGate.formalOpinionAllowed === false ? "PASS" : "FAIL",
      checks: [check("critical_conflict_requires_l4_review", humanGate.level === "L4", humanGate), check("automatic_final_approval_is_denied", humanGate.deniedOutcomes.includes("automatic_final_approval"))],
    },
    {
      scenarioId: "AU-GT-06-CONTROLLED-REVIEW-WRITE",
      taskId: "AU-GT-06",
      status: reviewReceipt?.taskId === "AU-GT-06" && responseEvidence?.receiptBundle.stages.length === 2 ? "PASS" : "FAIL",
      checks: [
        check("confirmed_review_business_receipt_is_present", reviewReceipt?.applied.capabilityExecutions[0]?.approvalId === "approval-controlled"),
        check("review_write_is_idempotency_protected", reviewReceipt?.applied.capabilityExecutions[0]?.idempotencyProtected === true),
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
