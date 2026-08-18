import { createHash } from "node:crypto";

export type AuditMaterialDecision = {
  schema: "ea.audit-required-materials.v1";
  policyCode: "AUDIT_REQUIRED_MATERIALS";
  ruleVersion: "2.0";
  status: "ready" | "blocked";
  provided: string[];
  missing: string[];
  needsCorrection: string[];
  formalReviewAllowed: boolean;
  requiresHumanReview: boolean;
  decisionId: string;
};

export type AuditRuleCandidate = {
  assetId: string;
  versionLabel: string;
  lifecycle: "draft" | "active" | "expired" | "retired";
  effectiveAt: string;
  expiresAt?: string | null;
  applicableRoles: string[];
};

export type AuditRuleEligibilityDecision = {
  schema: "ea.audit-rule-version-eligibility.v1";
  policyCode: "AUDIT_RULE_VERSION_ELIGIBILITY";
  ruleVersion: "2.0";
  status: "ready" | "blocked";
  selectedAssetIds: string[];
  excluded: Array<{ assetId: string; reason: string }>;
  formalRuleUseAllowed: boolean;
  decisionId: string;
};

export type AuditHumanReviewLevel = "L1" | "L2" | "L3" | "L4";

export type AuditHumanReviewDecision = {
  schema: "ea.audit-human-review-gate.v1";
  policyCode: "AUDIT_HUMAN_REVIEW_GATE";
  ruleVersion: "2.0";
  status: "ready" | "blocked";
  level: AuditHumanReviewLevel | null;
  triggers: string[];
  formalOpinionAllowed: boolean;
  humanReviewRequired: boolean;
  allowedOutcomes: string[];
  deniedOutcomes: string[];
  requiredActions: string[];
  decisionId: string;
};

function normalizedList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean))).sort();
}

function stableDecisionId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function roleAuthorized(roleTemplate: string): boolean {
  return roleTemplate === "credential-compliance";
}

export function evaluateAuditRequiredMaterials(input: {
  roleTemplate: string;
  requiredMaterialTypes: string[];
  providedMaterialTypes: string[];
  unreadableMaterialTypes?: string[];
}): AuditMaterialDecision {
  const required = normalizedList(input.requiredMaterialTypes);
  const provided = normalizedList(input.providedMaterialTypes);
  const unreadable = normalizedList(input.unreadableMaterialTypes || []);
  const missing = required.filter((item) => !provided.includes(item));
  const needsCorrection = unreadable.filter((item) => provided.includes(item));
  const authorized = roleAuthorized(input.roleTemplate);
  const formalReviewAllowed = authorized && required.length > 0 && missing.length === 0 && needsCorrection.length === 0;
  const decision = {
    roleTemplate: input.roleTemplate,
    required,
    provided,
    missing,
    needsCorrection,
    formalReviewAllowed,
  };
  return {
    schema: "ea.audit-required-materials.v1",
    policyCode: "AUDIT_REQUIRED_MATERIALS",
    ruleVersion: "2.0",
    status: formalReviewAllowed ? "ready" : "blocked",
    provided,
    missing,
    needsCorrection,
    formalReviewAllowed,
    requiresHumanReview: authorized && (missing.length > 0 || needsCorrection.length > 0),
    decisionId: stableDecisionId("audm", decision),
  };
}

export function evaluateAuditRuleVersionEligibility(input: {
  roleTemplate: string;
  candidates: AuditRuleCandidate[];
  asOf: string;
}): AuditRuleEligibilityDecision {
  const asOf = new Date(input.asOf).getTime();
  const authorized = roleAuthorized(input.roleTemplate);
  const excluded: Array<{ assetId: string; reason: string }> = [];
  const selected = input.candidates.filter((candidate) => {
    let reason = "";
    if (!authorized || !candidate.applicableRoles.includes(input.roleTemplate)) reason = "ROLE_NOT_APPLICABLE";
    else if (candidate.lifecycle !== "active") reason = "LIFECYCLE_NOT_ACTIVE";
    else if (!Number.isFinite(asOf)) reason = "INVALID_AS_OF";
    else if (new Date(candidate.effectiveAt).getTime() > asOf) reason = "NOT_YET_EFFECTIVE";
    else if (candidate.expiresAt && new Date(candidate.expiresAt).getTime() < asOf) reason = "EXPIRED";
    if (reason) excluded.push({ assetId: candidate.assetId, reason });
    return !reason;
  }).sort((a, b) => b.versionLabel.localeCompare(a.versionLabel));
  const selectedAssetIds = selected.map((candidate) => candidate.assetId);
  const formalRuleUseAllowed = selectedAssetIds.length > 0;
  const decision = { roleTemplate: input.roleTemplate, asOf: input.asOf, selectedAssetIds, excluded };
  return {
    schema: "ea.audit-rule-version-eligibility.v1",
    policyCode: "AUDIT_RULE_VERSION_ELIGIBILITY",
    ruleVersion: "2.0",
    status: formalRuleUseAllowed ? "ready" : "blocked",
    selectedAssetIds,
    excluded,
    formalRuleUseAllowed,
    decisionId: stableDecisionId("audr", decision),
  };
}

export function evaluateAuditHumanReviewGate(input: {
  roleTemplate: string;
  criticalMissing: boolean;
  criticalConflicts: boolean;
  ruleVersionReady: boolean;
  imageVerificationUncertain: boolean;
  highRiskRuleHit: boolean;
  finalDecisionRequested: boolean;
}): AuditHumanReviewDecision {
  const authorized = roleAuthorized(input.roleTemplate);
  const triggers = normalizedList([
    ...(!authorized ? ["ROLE_NOT_AUTHORIZED"] : []),
    ...(input.criticalMissing ? ["CRITICAL_MATERIAL_MISSING"] : []),
    ...(input.criticalConflicts ? ["CRITICAL_FIELD_CONFLICT"] : []),
    ...(!input.ruleVersionReady ? ["CURRENT_RULE_UNAVAILABLE"] : []),
    ...(input.imageVerificationUncertain ? ["IMAGE_VERIFICATION_UNCERTAIN"] : []),
    ...(input.highRiskRuleHit ? ["HIGH_RISK_RULE_HIT"] : []),
    ...(input.finalDecisionRequested ? ["FINAL_DECISION_REQUIRES_HUMAN"] : []),
  ]);
  let level: AuditHumanReviewLevel | null = null;
  if (authorized) {
    if (input.highRiskRuleHit || input.criticalConflicts) level = "L4";
    else if (input.criticalMissing || !input.ruleVersionReady) level = "L3";
    else if (input.imageVerificationUncertain || input.finalDecisionRequested) level = "L2";
    else level = "L1";
  }
  const formalOpinionAllowed = authorized && input.ruleVersionReady && !input.criticalMissing && !input.criticalConflicts;
  const humanReviewRequired = !authorized || level === "L2" || level === "L3" || level === "L4";
  const requiredActions = !authorized
    ? ["切换到已授权的智能审核岗位"]
    : level === "L4"
      ? ["立即提交高级人工复核", "保留原始材料定位和规则命中证据", "不得自动形成最终审批结论"]
      : level === "L3"
        ? ["补齐关键材料或恢复现行规则", "完成人工复核后重新审核"]
        : level === "L2"
          ? ["提交人工确认", "在确认前仅输出审核草稿"]
          : ["保留审核依据和疑点清单"];
  const decision = { ...input, level, triggers };
  return {
    schema: "ea.audit-human-review-gate.v1",
    policyCode: "AUDIT_HUMAN_REVIEW_GATE",
    ruleVersion: "2.0",
    status: authorized && (formalOpinionAllowed || level === "L2") ? "ready" : "blocked",
    level,
    triggers,
    formalOpinionAllowed,
    humanReviewRequired,
    allowedOutcomes: formalOpinionAllowed ? ["audit_opinion_draft", "human_review_task"] : ["verified_fact_summary", "supplement_request"],
    deniedOutcomes: ["automatic_final_approval", ...(!formalOpinionAllowed ? ["formal_audit_opinion"] : [])],
    requiredActions,
    decisionId: stableDecisionId("audh", decision),
  };
}
