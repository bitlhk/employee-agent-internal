import { createHash } from "node:crypto";

export type InvestmentResearchDataDecision = {
  schema: "ea.investment-research-data-assurance.v1";
  policyCode: "INVESTMENT_RESEARCH_DATA_ASSURANCE";
  ruleVersion: "1.0";
  status: "ready" | "degraded" | "blocked";
  missingDimensions: string[];
  formalResearchAllowed: boolean;
  allowedOutcomes: string[];
  deniedOutcomes: string[];
  reasons: string[];
  decisionId: string;
};

export type InvestmentResearchOutputDecision = {
  schema: "ea.investment-research-output-boundary.v1";
  policyCode: "INVESTMENT_RESEARCH_OUTPUT_BOUNDARY";
  ruleVersion: "1.0";
  status: "ready" | "blocked";
  allowed: boolean;
  humanReviewRequired: boolean;
  allowedOutcomes: string[];
  deniedOutcomes: string[];
  reasons: string[];
  decisionId: string;
};

function normalizedList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean))).sort();
}

function stableDecisionId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function authorized(roleTemplate: string): boolean {
  return roleTemplate === "investment-researcher";
}

export function evaluateInvestmentResearchDataAssurance(input: {
  roleTemplate: string;
  securityId: string;
  sourceSystem: string;
  dataAsOf: string;
  requiredDimensions: string[];
  availableDimensions: string[];
  sourceAuthorized: boolean;
  comparable: boolean;
}): InvestmentResearchDataDecision {
  const required = normalizedList(input.requiredDimensions);
  const available = normalizedList(input.availableDimensions);
  const missingDimensions = required.filter((dimension) => !available.includes(dimension));
  const validAsOf = Number.isFinite(new Date(input.dataAsOf).getTime());
  const reasons = normalizedList([
    ...(!authorized(input.roleTemplate) ? ["ROLE_NOT_AUTHORIZED"] : []),
    ...(!input.securityId.trim() ? ["SECURITY_ID_MISSING"] : []),
    ...(!input.sourceSystem.trim() ? ["SOURCE_SYSTEM_MISSING"] : []),
    ...(!input.sourceAuthorized ? ["SOURCE_NOT_AUTHORIZED"] : []),
    ...(!validAsOf ? ["DATA_AS_OF_INVALID"] : []),
    ...(required.length === 0 ? ["REQUIRED_DIMENSIONS_EMPTY"] : []),
    ...(missingDimensions.length ? ["REQUIRED_DIMENSIONS_MISSING"] : []),
    ...(!input.comparable ? ["DATA_NOT_COMPARABLE"] : []),
  ]);
  const hardBlocked = reasons.some((reason) => [
    "ROLE_NOT_AUTHORIZED",
    "SECURITY_ID_MISSING",
    "SOURCE_SYSTEM_MISSING",
    "SOURCE_NOT_AUTHORIZED",
    "DATA_AS_OF_INVALID",
  ].includes(reason));
  const formalResearchAllowed = !hardBlocked && reasons.length === 0;
  const status = formalResearchAllowed ? "ready" : hardBlocked ? "blocked" : "degraded";
  const decision = { ...input, required, available, missingDimensions, reasons, status };
  return {
    schema: "ea.investment-research-data-assurance.v1",
    policyCode: "INVESTMENT_RESEARCH_DATA_ASSURANCE",
    ruleVersion: "1.0",
    status,
    missingDimensions,
    formalResearchAllowed,
    allowedOutcomes: formalResearchAllowed
      ? ["research_working_draft", "risk_watchlist", "research_tracking_draft"]
      : hardBlocked ? ["minimum_input_checklist"] : ["verified_fact_summary", "data_gap_checklist"],
    deniedOutcomes: formalResearchAllowed ? ["automatic_trade", "return_promise"] : ["formal_research_conclusion", "automatic_trade", "return_promise"],
    reasons: reasons.length ? reasons : ["RESEARCH_DATA_ASSURANCE_READY"],
    decisionId: stableDecisionId("ird", decision),
  };
}

export function evaluateInvestmentResearchOutputBoundary(input: {
  roleTemplate: string;
  requestedOutcome: string;
  automaticTradeRequested: boolean;
  containsReturnPromise: boolean;
  personalizedRecommendationRequested: boolean;
  hasCustomerSuitabilityContext: boolean;
}): InvestmentResearchOutputDecision {
  const reasons = normalizedList([
    ...(!authorized(input.roleTemplate) ? ["ROLE_NOT_AUTHORIZED"] : []),
    ...(input.automaticTradeRequested ? ["AUTOMATIC_TRADE_PROHIBITED"] : []),
    ...(input.containsReturnPromise ? ["RETURN_PROMISE_PROHIBITED"] : []),
    ...(input.personalizedRecommendationRequested && !input.hasCustomerSuitabilityContext
      ? ["CUSTOMER_SUITABILITY_CONTEXT_REQUIRED"]
      : []),
  ]);
  const allowed = reasons.length === 0;
  const decision = { ...input, reasons, allowed };
  return {
    schema: "ea.investment-research-output-boundary.v1",
    policyCode: "INVESTMENT_RESEARCH_OUTPUT_BOUNDARY",
    ruleVersion: "1.0",
    status: allowed ? "ready" : "blocked",
    allowed,
    humanReviewRequired: !allowed || input.personalizedRecommendationRequested,
    allowedOutcomes: allowed ? [input.requestedOutcome || "internal_research_draft"] : ["internal_research_draft", "risk_disclosure", "human_review_request"],
    deniedOutcomes: ["automatic_trade", "return_promise", ...(!allowed ? [input.requestedOutcome || "restricted_outcome"] : [])],
    reasons: reasons.length ? reasons : ["RESEARCH_OUTPUT_BOUNDARY_READY"],
    decisionId: stableDecisionId("iro", decision),
  };
}
