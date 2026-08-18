import type { Request } from "express";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { attachContextReceipt, buildContextReceipt } from "./governance/context-receipt";
import { governanceFingerprint, principalFingerprint, type RuntimePrincipal } from "./governance/contracts";
import {
  evaluateInvestmentResearchDataAssurance,
  evaluateInvestmentResearchOutputBoundary,
} from "./investment-research-policy";

export const INVESTMENT_RESEARCH_DATA_ASSURANCE_TOOL = {
  name: "evaluate_investment_research_data_assurance",
  description: "核验投顾分析任务的研究对象、授权来源、数据时间、必需维度和可比性；条件不足时降级为事实摘要或补数清单。",
  inputSchema: {
    type: "object",
    properties: {
      security_id: { type: "string" },
      source_system: { type: "string" },
      data_as_of: { type: "string" },
      required_dimensions: { type: "array", items: { type: "string" } },
      available_dimensions: { type: "array", items: { type: "string" } },
      source_authorized: { type: "boolean" },
      comparable: { type: "boolean" },
    },
    required: ["security_id", "source_system", "data_as_of", "required_dimensions", "available_dimensions", "source_authorized", "comparable"],
  },
} as const;

export const INVESTMENT_RESEARCH_OUTPUT_BOUNDARY_TOOL = {
  name: "evaluate_investment_research_output_boundary",
  description: "执行投顾分析输出边界检查，阻断自动交易、收益承诺和缺少客户适当性上下文的个性化产品推荐。",
  inputSchema: {
    type: "object",
    properties: {
      requested_outcome: { type: "string" },
      automatic_trade_requested: { type: "boolean" },
      contains_return_promise: { type: "boolean" },
      personalized_recommendation_requested: { type: "boolean" },
      has_customer_suitability_context: { type: "boolean" },
    },
    required: ["requested_outcome", "automatic_trade_requested", "contains_return_promise", "personalized_recommendation_requested", "has_customer_suitability_context"],
  },
} as const;

export const INVESTMENT_RESEARCH_TOOLS = [
  INVESTMENT_RESEARCH_DATA_ASSURANCE_TOOL,
  INVESTMENT_RESEARCH_OUTPUT_BOUNDARY_TOOL,
] as const;

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function bool(args: Record<string, unknown>, snake: string, camel: string): boolean {
  return args[snake] === true || args[camel] === true;
}

export async function handleInvestmentResearchTool(input: {
  req: Request;
  name: string;
  args: Record<string, unknown>;
  adoptId: string;
  principal: RuntimePrincipal;
}) {
  const { req, name, args, adoptId, principal } = input;
  const dataTool = name === INVESTMENT_RESEARCH_DATA_ASSURANCE_TOOL.name;
  const taskId = dataTool ? "IR-GT-04" : "IR-GT-06";
  const taskLabel = dataTool ? "估值与风险核验" : "研究输出边界核验";
  const decision = dataTool
    ? evaluateInvestmentResearchDataAssurance({
        roleTemplate: principal.roleTemplate,
        securityId: String(args.security_id || args.securityId || ""),
        sourceSystem: String(args.source_system || args.sourceSystem || ""),
        dataAsOf: String(args.data_as_of || args.dataAsOf || ""),
        requiredDimensions: list(args.required_dimensions ?? args.requiredDimensions),
        availableDimensions: list(args.available_dimensions ?? args.availableDimensions),
        sourceAuthorized: bool(args, "source_authorized", "sourceAuthorized"),
        comparable: bool(args, "comparable", "comparable"),
      })
    : evaluateInvestmentResearchOutputBoundary({
        roleTemplate: principal.roleTemplate,
        requestedOutcome: String(args.requested_outcome || args.requestedOutcome || "internal_research_draft"),
        automaticTradeRequested: bool(args, "automatic_trade_requested", "automaticTradeRequested"),
        containsReturnPromise: bool(args, "contains_return_promise", "containsReturnPromise"),
        personalizedRecommendationRequested: bool(args, "personalized_recommendation_requested", "personalizedRecommendationRequested"),
        hasCustomerSuitabilityContext: bool(args, "has_customer_suitability_context", "hasCustomerSuitabilityContext"),
      });
  const ready = decision.status === "ready";
  const modelResult = dataTool
    ? {
        status: decision.status,
        formalResearchAllowed: "formalResearchAllowed" in decision && decision.formalResearchAllowed,
        missingDimensions: "missingDimensions" in decision ? decision.missingDimensions : [],
        reasons: decision.reasons,
      }
    : {
        status: decision.status,
        allowed: "allowed" in decision && decision.allowed,
        humanReviewRequired: "humanReviewRequired" in decision && decision.humanReviewRequired,
        reasons: decision.reasons,
      };
  const requestId = String(input.req.headers["x-request-id"] || input.req.headers["x-correlation-id"] || decision.decisionId);
  const receipt = buildContextReceipt({
    taskId,
    taskLabel,
    principalFingerprint: principalFingerprint(principal),
    provided: {
      knowledge: [],
      businessData: [],
      memory: [],
      capabilities: [{ capabilityId: name, label: taskLabel, version: "1", sideEffect: "compute" }],
    },
    policyDecisions: [{
      decisionId: decision.decisionId,
      policyCode: decision.policyCode,
      ruleVersion: decision.ruleVersion,
      effect: ready ? "ALLOW" : "DENY",
    }],
    capabilityExecutions: [{ capabilityId: name, label: taskLabel, operation: name, status: ready ? "completed" : "blocked", requestId }],
    readiness: {
      status: ready ? "READY" : decision.status === "degraded" ? "DEGRADED" : "BLOCKED",
      requestedOutcome: dataTool ? "formal_research_draft" : String(args.requested_outcome || args.requestedOutcome || "internal_research_draft"),
      allowedOutcomes: decision.allowedOutcomes,
      deniedOutcomes: decision.deniedOutcomes,
      reasons: decision.reasons,
      remediation: ready ? [] : ["补齐授权来源、时间和关键数据后重新核验", "涉及客户推荐时转交具备适当性上下文的岗位"],
      presentation: {
        completed: ready ? [`已完成${taskLabel}`] : ["已保留可核验研究事实"],
        unavailable: ready ? ["不执行自动交易或收益承诺"] : ["暂不能形成正式研究结论或受限输出"],
        nextSteps: ready ? [] : ["补齐缺失条件后重新核验"],
      },
      decisionFingerprint: governanceFingerprint(decision),
    },
  });
  await recordAuditBestEffort({
    action: ready ? "governance.investment_research.evaluated" : "governance.investment_research.restricted",
    result: ready ? "success" : "denied",
    severity: ready ? "medium" : "high",
    actorType: "agent",
    actorUserId: principal.userId || null,
    actorRole: principal.roleTemplate,
    targetType: "investment_research_policy",
    targetId: decision.decisionId,
    agentInstanceId: adoptId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName: name,
    policyCode: decision.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(req),
    metadata: { taskId, ruleVersion: decision.ruleVersion },
  });
  return attachContextReceipt({
    content: [{ type: "text", text: `EA_INVESTMENT_RESEARCH_DECISION:${JSON.stringify(modelResult)}` }],
    ...(decision.status === "blocked" ? { isError: true } : {}),
  }, receipt);
}
