import type {
  ReadinessCheck,
} from "./task-execution-envelope";
import {
  evaluateTaskReadiness,
  readinessCheck,
  type TaskReadinessProfile,
} from "./task-readiness";

export { readinessCheck } from "./task-readiness";

export type WealthGoldenTaskId = "WM-GT-01" | "WM-GT-02" | "WM-GT-03" | "WM-GT-04" | "WM-GT-05" | "WM-GT-06";

export function wealthPolicyKnowledgeReadiness(input: {
  policyReady: boolean;
  resolutionStatus?: "READY" | "DEGRADED" | "BLOCKED";
}): ReadinessCheck {
  if (!input.policyReady) {
    return readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", "当前有效适当性制度不可用。");
  }
  if (input.resolutionStatus === "BLOCKED") {
    return readinessCheck("BLOCKED", "REQUIRED_CONTEXT_BINDING_MISSING", "必需知识上下文来源尚未完成受治理绑定。");
  }
  if (input.resolutionStatus === "DEGRADED") {
    return readinessCheck(
      "READY",
      "CURRENT_POLICY_READY_OPTIONAL_CONTEXT_MISSING",
      "当前有效制度已通过知识资格校验；缺少的可选上下文不阻断正式候选。",
    );
  }
  return readinessCheck("READY", "CURRENT_POLICY_READY", "当前有效制度已通过知识资格校验。");
}

const PROFILES: Record<WealthGoldenTaskId, Omit<TaskReadinessProfile, "taskId">> = {
  "WM-GT-01": {
    requestedOutcome: "customer_specific_previsit_brief",
    requiredChecks: ["identity", "knowledge", "customerData", "skill", "evidence"],
    fallbackOutcomes: ["generic_previsit_checklist", "verified_customer_facts_summary"],
  },
  "WM-GT-02": {
    requestedOutcome: "governed_asset_allocation_candidates",
    requiredChecks: ["identity", "knowledge", "customerData", "productData", "policy", "skill", "evidence"],
    fallbackOutcomes: ["verified_customer_analysis", "allocation_constraints", "product_screening_criteria"],
  },
  "WM-GT-03": {
    requestedOutcome: "current_enterprise_policy_conclusion",
    requiredChecks: ["identity", "knowledge", "policy", "evidence"],
    fallbackOutcomes: ["knowledge_admin_remediation"],
  },
  "WM-GT-04": {
    requestedOutcome: "formal_product_recommendation",
    requiredChecks: ["identity", "knowledge", "customerData", "productData", "policy", "capability", "evidence"],
    fallbackOutcomes: ["verified_customer_analysis", "product_screening_criteria", "risk_reassessment_next_step"],
  },
  "WM-GT-05": {
    requestedOutcome: "confirmed_business_followup_write",
    requiredChecks: ["identity", "policy", "capability", "approval", "idempotency", "receipt", "evidence"],
    fallbackOutcomes: ["followup_draft", "confirmation_request"],
  },
  "WM-GT-06": {
    requestedOutcome: "maturity_customer_followup_plan",
    requiredChecks: ["identity", "customerData", "skill", "capability", "evidence"],
    fallbackOutcomes: ["generic_maturity_checklist", "partial_verified_maturity_list"],
  },
};

export function evaluateWealthTaskReadiness(input: {
  taskId: WealthGoldenTaskId;
  checks: Record<string, ReadinessCheck>;
  requestedOutcome?: string;
}) {
  return evaluateTaskReadiness({
    profile: { taskId: input.taskId, ...PROFILES[input.taskId] },
    checks: input.checks,
    requestedOutcome: input.requestedOutcome,
  });
}
