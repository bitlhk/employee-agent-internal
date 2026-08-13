import { readFileSync } from "node:fs";
import path from "node:path";
import { buildResponseEvidence, extractTrustedContextReceipt } from "./governance/response-evidence";
import { runInsuranceRolePackContractChecks } from "./reference-role-pack-contracts";
import { attachReferenceRoleTaskReceipt } from "./reference-role-task-evidence";

type ScenarioCheck = { assertion: string; passed: boolean; actual?: unknown };
type ScenarioResult = {
  scenarioId: string;
  taskId: `IA-GT-0${1 | 2 | 3 | 4 | 5 | 6}`;
  status: "PASS" | "FAIL";
  checks: ScenarioCheck[];
};

const NOW = new Date("2026-08-13T00:00:00.000Z");
const common = {
  roleTemplate: "insurance-advisor",
  principalFingerprint: "p".repeat(64),
  capabilityVersion: "1",
  policyDecision: {
    decisionId: "ia-controlled-decision",
    policyCode: "EA_ENTERPRISE_MCP_POLICY",
    ruleVersion: "enterprise-mcp-v1",
    effect: "ALLOW" as const,
  },
  requestId: "ia-controlled-request",
  argumentsFingerprint: "a".repeat(64),
  failed: false,
  now: NOW,
};

function check(assertion: string, passed: boolean, actual?: unknown): ScenarioCheck {
  return { assertion, passed, ...(passed || actual === undefined ? {} : { actual }) };
}

function readReceipt(serverId: string, toolName: string) {
  const result = attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "controlled fixture result" }] },
    serverId,
    toolName,
    sideEffect: "read",
    resultFingerprint: `${toolName.charCodeAt(0).toString(16)}`.repeat(64).slice(0, 64),
  });
  return extractTrustedContextReceipt(`enterprise_${toolName}`, result);
}

function roleAsset(root: string, file: string): string {
  return readFileSync(path.join(root, "examples", "insurance-advisor-reference-role-pack", file), "utf8");
}

export async function runInsuranceRolePackControlledScenarios(root = process.cwd()) {
  const contract = runInsuranceRolePackContractChecks(root);
  const customerReceipt = readReceipt("insurance_customer_profile", "get_customer_profile_by_name");
  const productReceipt = readReceipt("insurance_product_exam_points", "search_products");
  const detailReceipt = readReceipt("insurance_product_exam_points", "get_product_detail");
  const examReceipt = readReceipt("insurance_product_exam_points", "get_exam_points");
  const followupResult = attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "created" }] },
    serverId: "wealth_governance_demo",
    toolName: "demo_create_followup_task",
    sideEffect: "write",
    resultFingerprint: "f".repeat(64),
    approvalId: "approval-controlled",
    externalRequestId: "DEMO-INSURANCE-FOLLOWUP",
    idempotencyProtected: true,
  });
  const followupReceipt = extractTrustedContextReceipt("enterprise_demo_create_followup_task", followupResult);
  const responseEvidence = buildResponseEvidence({
    receipts: [customerReceipt, followupReceipt].filter((item): item is NonNullable<typeof item> => Boolean(item)),
    correlationId: "ia-gt-01-controlled",
    assistantMessageId: "ia-gt-01-message",
    responseText: "已完成续保访前准备并创建演示跟进。",
    citedKnowledgeSources: [{ documentId: "ia-auto-previsit-sop", documentName: "车险客户访前与续保准备作业指导书", documentVersion: "V1.0" }],
    now: NOW,
  });
  const skill = roleAsset(root, "skills/auto-insurance-advisor/SKILL.md");
  const knowledgeManifest = JSON.parse(roleAsset(root, "knowledge/manifest.json")) as {
    assets: Array<{ assetId: string; taskIds: string[] }>;
  };
  const covered = (taskId: string) => knowledgeManifest.assets.some((asset) => asset.taskIds.includes(taskId));

  const scenarios: ScenarioResult[] = [
    {
      scenarioId: "IA-GT-01-CONTROLLED-CLOSED-LOOP",
      taskId: "IA-GT-01",
      status: customerReceipt?.taskId === "IA-GT-01" && followupReceipt?.taskId === "IA-GT-01" && responseEvidence?.receiptBundle.stages.length === 2 ? "PASS" : "FAIL",
      checks: [
        check("customer_context_receipt_is_present", customerReceipt?.taskId === "IA-GT-01"),
        check("confirmed_followup_business_receipt_is_present", followupReceipt?.applied.capabilityExecutions[0]?.approvalId === "approval-controlled"),
        check("response_evidence_bundles_read_and_write_stages", responseEvidence?.receiptBundle.stages.length === 2),
      ],
    },
    {
      scenarioId: "IA-GT-02-CONTROLLED-PRODUCT-CONTEXT",
      taskId: "IA-GT-02",
      status: productReceipt?.taskId === "IA-GT-02" ? "PASS" : "FAIL",
      checks: [
        check("product_context_comes_from_enterprise_mcp_receipt", productReceipt?.provided.businessData[0]?.sourceSystem === "insurance_product_exam_points"),
        check("raw_product_payload_is_not_copied_to_receipt", !JSON.stringify(productReceipt).includes("controlled fixture result")),
      ],
    },
    {
      scenarioId: "IA-GT-03-CONTROLLED-PRODUCT-DETAIL",
      taskId: "IA-GT-03",
      status: detailReceipt?.taskId === "IA-GT-03" ? "PASS" : "FAIL",
      checks: [check("product_detail_has_task_bound_context_receipt", detailReceipt?.taskId === "IA-GT-03")],
    },
    {
      scenarioId: "IA-GT-04-CONTROLLED-SKILL-BOUNDARY",
      taskId: "IA-GT-04",
      status: covered("IA-GT-04") && skill.includes("insurance-telesales-recommend") ? "PASS" : "FAIL",
      checks: [
        check("objection_task_has_reference_knowledge", covered("IA-GT-04")),
        check("existing_telesales_skill_is_reused", skill.includes("insurance-telesales-recommend")),
      ],
    },
    {
      scenarioId: "IA-GT-05-CONTROLLED-TRAINING-EVIDENCE",
      taskId: "IA-GT-05",
      status: examReceipt?.taskId === "IA-GT-05" ? "PASS" : "FAIL",
      checks: [
        check("training_points_have_context_receipt", examReceipt?.taskId === "IA-GT-05"),
        check("existing_stage_evaluation_skill_is_reused", skill.includes("goldencoach-stage-evaluation")),
      ],
    },
    {
      scenarioId: "IA-GT-06-CONTROLLED-ESCALATION-BOUNDARY",
      taskId: "IA-GT-06",
      status: covered("IA-GT-06") && skill.includes("转人工") ? "PASS" : "FAIL",
      checks: [
        check("compliance_escalation_has_reference_knowledge", covered("IA-GT-06")),
        check("human_escalation_is_explicit", skill.includes("转人工")),
      ],
    },
  ];
  const errors = scenarios.filter((scenario) => scenario.status === "FAIL").map((scenario) => scenario.scenarioId);
  return {
    schema: "ea.reference-role-pack-scenario-report.v1",
    status: contract.status === "PASS" && !errors.length ? "PASS" : "FAIL",
    executionLevel: "controlled_scenario",
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
