import { readFileSync } from "node:fs";
import path from "node:path";
import { buildResponseEvidence, extractTrustedContextReceipt } from "./governance/response-evidence";
import { evaluateInvestmentResearchDataAssurance, evaluateInvestmentResearchOutputBoundary } from "./investment-research-policy";
import { runInvestmentResearchRolePackContractChecks } from "./reference-role-pack-contracts";
import { attachReferenceRoleTaskReceipt } from "./reference-role-task-evidence";

type Scenario = { scenarioId: string; taskId: `IR-GT-0${1 | 2 | 3 | 4 | 5 | 6}`; status: "PASS" | "FAIL"; checks: Array<{ assertion: string; passed: boolean; actual?: unknown }> };
const NOW = new Date("2026-08-18T00:00:00.000Z");
const common = {
  roleTemplate: "investment-researcher",
  principalFingerprint: "p".repeat(64),
  capabilityVersion: "1",
  policyDecision: { decisionId: "ir-controlled-decision", policyCode: "EA_ENTERPRISE_MCP_POLICY", ruleVersion: "enterprise-mcp-v1", effect: "ALLOW" as const },
  requestId: "ir-controlled-request",
  argumentsFingerprint: "a".repeat(64),
  failed: false,
  now: NOW,
};

function check(assertion: string, passed: boolean, actual?: unknown) {
  return { assertion, passed, ...(passed || actual === undefined ? {} : { actual }) };
}

function receipt(serverId: string, toolName: string, resultFingerprint: string) {
  return extractTrustedContextReceipt(`enterprise_${toolName}`, attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "controlled Wind result" }] },
    serverId,
    toolName,
    sideEffect: "read",
    resultFingerprint,
  }));
}

export async function runInvestmentResearchRolePackControlledScenarios(root = process.cwd()) {
  const contract = runInvestmentResearchRolePackContractChecks(root);
  const company = receipt("wind_stock_data", "get_stock_basicinfo", "1".repeat(64));
  const earnings = receipt("wind_stock_data", "get_stock_fundamentals", "2".repeat(64));
  const peer = receipt("wind_analytics_data", "get_financial_data", "3".repeat(64));
  const risk = receipt("wind_stock_data", "get_risk_metrics", "4".repeat(64));
  const event = receipt("wind_financial_docs", "get_company_announcements", "5".repeat(64));
  const watch = extractTrustedContextReceipt("enterprise_demo_create_research_watch_task", attachReferenceRoleTaskReceipt({
    ...common,
    result: { content: [{ type: "text", text: "created" }] },
    serverId: "wealth_governance_demo",
    toolName: "demo_create_research_watch_task",
    sideEffect: "write",
    resultFingerprint: "6".repeat(64),
    approvalId: "approval-ir-controlled",
    externalRequestId: "DEMO-RESEARCH-WATCH-CONTROLLED",
    idempotencyProtected: true,
  }));
  const dataReady = evaluateInvestmentResearchDataAssurance({ roleTemplate: "investment-researcher", securityId: "600000.SH", sourceSystem: "wind_stock_data", dataAsOf: NOW.toISOString(), requiredDimensions: ["price", "financials"], availableDimensions: ["price", "financials"], sourceAuthorized: true, comparable: true });
  const dataDegraded = evaluateInvestmentResearchDataAssurance({ roleTemplate: "investment-researcher", securityId: "600000.SH", sourceSystem: "wind_stock_data", dataAsOf: NOW.toISOString(), requiredDimensions: ["price", "cash_flow"], availableDimensions: ["price"], sourceAuthorized: true, comparable: false });
  const outputBlocked = evaluateInvestmentResearchOutputBoundary({ roleTemplate: "investment-researcher", requestedOutcome: "automatic_trade", automaticTradeRequested: true, containsReturnPromise: true, personalizedRecommendationRequested: false, hasCustomerSuitabilityContext: false });
  const response = buildResponseEvidence({
    receipts: [company, earnings, peer, risk, event, watch].filter((item): item is NonNullable<typeof item> => Boolean(item)),
    correlationId: "ir-controlled-closed-loop",
    assistantMessageId: "ir-controlled-message",
    responseText: "已核实公司、财报、同业、风险和公告，并在确认后创建研究跟踪任务。",
    citedKnowledgeSources: [{ documentId: "ir-data-assurance-v2.0", documentName: "研究数据来源与时效管理办法", documentVersion: "V2.0" }],
    now: NOW,
  });
  const manifest = JSON.parse(readFileSync(path.join(root, "examples", "investment-research-reference-role-pack", "knowledge", "manifest.json"), "utf8")) as { assets: Array<{ assetId: string; lifecycle: string; taskIds: string[] }> };
  const covered = (taskId: string) => manifest.assets.some((asset) => asset.taskIds.includes(taskId));
  const scenarios: Scenario[] = [
    { scenarioId: "IR-GT-01-CONTROLLED-FIRST-LOOK", taskId: "IR-GT-01", status: company?.taskId === "IR-GT-01" && covered("IR-GT-01") ? "PASS" : "FAIL", checks: [check("company_receipt_is_present", company?.taskId === "IR-GT-01"), check("current_company_knowledge_is_present", covered("IR-GT-01"))] },
    { scenarioId: "IR-GT-02-CONTROLLED-EARNINGS", taskId: "IR-GT-02", status: earnings?.taskId === "IR-GT-02" && dataReady.formalResearchAllowed ? "PASS" : "FAIL", checks: [check("earnings_receipt_is_present", earnings?.taskId === "IR-GT-02"), check("complete_data_allows_research_draft", dataReady.formalResearchAllowed)] },
    { scenarioId: "IR-GT-03-CONTROLLED-PEER", taskId: "IR-GT-03", status: peer?.taskId === "IR-GT-03" && dataDegraded.status === "degraded" ? "PASS" : "FAIL", checks: [check("peer_receipt_is_present", peer?.taskId === "IR-GT-03"), check("incomparable_data_degrades_formal_output", dataDegraded.status === "degraded")] },
    { scenarioId: "IR-GT-04-CONTROLLED-RISK", taskId: "IR-GT-04", status: risk?.taskId === "IR-GT-04" && !outputBlocked.allowed ? "PASS" : "FAIL", checks: [check("risk_receipt_is_present", risk?.taskId === "IR-GT-04"), check("trade_and_return_promise_are_blocked", outputBlocked.reasons.includes("AUTOMATIC_TRADE_PROHIBITED") && outputBlocked.reasons.includes("RETURN_PROMISE_PROHIBITED"))] },
    { scenarioId: "IR-GT-05-CONTROLLED-EVENT", taskId: "IR-GT-05", status: event?.taskId === "IR-GT-05" ? "PASS" : "FAIL", checks: [check("official_announcement_receipt_is_present", event?.taskId === "IR-GT-05"), check("historical_data_policy_is_not_active", !manifest.assets.some((asset) => asset.assetId === "ir-data-assurance-v1.0" && asset.lifecycle === "active"))] },
    { scenarioId: "IR-GT-06-CONTROLLED-WATCH-WRITE", taskId: "IR-GT-06", status: watch?.taskId === "IR-GT-06" && response?.receiptBundle.stages.length === 6 ? "PASS" : "FAIL", checks: [check("confirmed_watch_receipt_is_present", watch?.applied.capabilityExecutions[0]?.approvalId === "approval-ir-controlled"), check("watch_write_is_idempotency_protected", watch?.applied.capabilityExecutions[0]?.idempotencyProtected === true), check("response_evidence_bundles_all_stages", response?.receiptBundle.stages.length === 6)] },
  ];
  const errors = scenarios.filter((scenario) => scenario.status === "FAIL").map((scenario) => scenario.scenarioId);
  return { schema: "ea.reference-role-pack-scenario-report.v1", status: contract.status === "PASS" && !errors.length ? "PASS" : "FAIL", executionLevel: "controlled_scenario" as const, rolePackId: contract.rolePackId, roleTemplate: contract.roleTemplate, evalSuiteVersion: contract.evalSuiteVersion, releaseCandidateId: contract.releaseCandidateId, assetSetFingerprint: contract.assetSetFingerprint, scenarioCount: scenarios.length, scenarios, errors: [...contract.errors, ...errors] };
}
