import {
  governanceFingerprint,
} from "./contracts";
import type {
  ReadinessCheck,
  TaskReadinessDecision,
  TaskReadinessStatus,
} from "./task-execution-envelope";

export type WealthGoldenTaskId = "WM-GT-01" | "WM-GT-02" | "WM-GT-03" | "WM-GT-04" | "WM-GT-05" | "WM-GT-06";

const PROFILES: Record<WealthGoldenTaskId, {
  requestedOutcome: string;
  requiredChecks: string[];
  fallbackOutcomes: string[];
}> = {
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

export function readinessCheck(
  status: ReadinessCheck["status"],
  code: string,
  message: string,
  options: Pick<ReadinessCheck, "retryable" | "asOf"> = {},
): ReadinessCheck {
  return { status, code, message, ...options };
}

export function evaluateWealthTaskReadiness(input: {
  taskId: WealthGoldenTaskId;
  checks: Record<string, ReadinessCheck>;
  requestedOutcome?: string;
}): TaskReadinessDecision {
  const profile = PROFILES[input.taskId];
  const checks: Record<string, ReadinessCheck> = { ...input.checks };
  for (const name of profile.requiredChecks) {
    checks[name] ||= readinessCheck("BLOCKED", "READINESS_CHECK_MISSING", `${name} 就绪检查缺失。`);
  }
  const relevant = profile.requiredChecks.map((name) => checks[name]);
  const status: TaskReadinessStatus = relevant.some((check) => check.status === "BLOCKED")
    ? "BLOCKED"
    : relevant.some((check) => check.status === "DEGRADED")
      ? "DEGRADED"
      : "READY";
  const requestedOutcome = String(input.requestedOutcome || profile.requestedOutcome).trim();
  const fallbackOutcomes = status === "READY" ? [] : profile.fallbackOutcomes;
  const body = {
    taskId: input.taskId,
    status,
    requestedOutcome,
    checks,
    allowedOutcomes: status === "READY" ? [requestedOutcome] : fallbackOutcomes,
    deniedOutcomes: status === "READY" ? [] : [requestedOutcome],
    fallbackOutcomes,
    reasons: relevant
      .filter((check) => check.status === "BLOCKED" || check.status === "DEGRADED")
      .map((check) => check.message),
    remediation: relevant
      .filter((check) => check.status !== "READY" && check.status !== "NOT_REQUIRED")
      .map((check) => check.retryable ? "依赖恢复后重试。" : check.message)
      .filter((value, index, values) => values.indexOf(value) === index),
  };
  return { ...body, decisionFingerprint: governanceFingerprint(body) };
}
