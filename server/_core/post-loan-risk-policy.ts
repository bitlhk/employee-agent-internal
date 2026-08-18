import { createHash } from "node:crypto";

export type PostLoanRiskLevel = "GREEN" | "YELLOW" | "ORANGE" | "RED";

export type PostLoanRiskPolicyInput = {
  roleTemplate: string;
  overdueDays?: number | null;
  fiveLevelClass?: "正常" | "关注" | "次级" | "可疑" | "损失" | null;
  ratingDowngradeSteps?: number | null;
  majorJudicialEvent?: boolean;
  dishonestEnforcement?: boolean;
  coreCollateralImpaired?: boolean;
  collateralCoverageRatio?: number | null;
  operationStopped?: boolean;
  criticalDataComplete: boolean;
};

export type PostLoanRiskPolicyDecision = {
  schema: "ea.post-loan-risk-escalation.v1";
  policyCode: "POST_LOAN_RISK_ESCALATION";
  ruleVersion: "2.0";
  status: "ready" | "blocked";
  level: PostLoanRiskLevel | null;
  triggers: string[];
  requiredActions: string[];
  requiresHumanEscalation: boolean;
  formalConclusionAllowed: boolean;
  decisionId: string;
};

function normalizedInteger(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function decisionId(input: PostLoanRiskPolicyInput, level: PostLoanRiskLevel | null, triggers: string[]): string {
  return `rcd_${createHash("sha256").update(JSON.stringify({ input, level, triggers })).digest("hex").slice(0, 24)}`;
}

export function evaluatePostLoanRiskEscalation(input: PostLoanRiskPolicyInput): PostLoanRiskPolicyDecision {
  if (input.roleTemplate !== "post-loan-risk-control") {
    const triggers = ["ROLE_NOT_AUTHORIZED"];
    return {
      schema: "ea.post-loan-risk-escalation.v1",
      policyCode: "POST_LOAN_RISK_ESCALATION",
      ruleVersion: "2.0",
      status: "blocked",
      level: null,
      triggers,
      requiredActions: ["切换到已授权的风控经理岗位"],
      requiresHumanEscalation: false,
      formalConclusionAllowed: false,
      decisionId: decisionId(input, null, triggers),
    };
  }
  const overdueDays = normalizedInteger(input.overdueDays);
  const ratingDowngradeSteps = normalizedInteger(input.ratingDowngradeSteps);
  const fiveLevelClass = input.fiveLevelClass || null;
  const redTriggers = [
    overdueDays >= 90 ? "OVERDUE_90_DAYS" : null,
    fiveLevelClass === "可疑" || fiveLevelClass === "损失" ? "FIVE_LEVEL_SEVERE" : null,
    input.dishonestEnforcement ? "DISHONEST_ENFORCEMENT" : null,
    input.operationStopped ? "CORE_OPERATION_STOPPED" : null,
  ].filter((item): item is string => Boolean(item));
  const orangeTriggers = [
    overdueDays >= 30 ? "OVERDUE_30_DAYS" : null,
    ["次级", "可疑", "损失"].includes(String(fiveLevelClass || "")) ? "FIVE_LEVEL_ADVERSE" : null,
    ratingDowngradeSteps >= 2 ? "RATING_DOWNGRADE_TWO_STEPS" : null,
    input.majorJudicialEvent ? "MAJOR_JUDICIAL_EVENT" : null,
    input.coreCollateralImpaired ? "CORE_COLLATERAL_IMPAIRED" : null,
    input.collateralCoverageRatio !== null
      && input.collateralCoverageRatio !== undefined
      && Number(input.collateralCoverageRatio) < 1
      ? "COLLATERAL_COVERAGE_BELOW_ONE"
      : null,
  ].filter((item): item is string => Boolean(item));

  let level: PostLoanRiskLevel | null = null;
  let triggers: string[] = [];
  if (redTriggers.length) {
    level = "RED";
    triggers = redTriggers;
  } else if (orangeTriggers.length) {
    level = "ORANGE";
    triggers = orangeTriggers;
  } else if (!input.criticalDataComplete) {
    triggers = ["CRITICAL_DATA_INCOMPLETE"];
  } else if (overdueDays > 0 || fiveLevelClass === "关注" || ratingDowngradeSteps === 1) {
    level = "YELLOW";
    triggers = [
      ...(overdueDays > 0 ? ["MINOR_OVERDUE"] : []),
      ...(fiveLevelClass === "关注" ? ["FIVE_LEVEL_ATTENTION"] : []),
      ...(ratingDowngradeSteps === 1 ? ["RATING_DOWNGRADE_ONE_STEP"] : []),
    ];
  } else {
    level = "GREEN";
    triggers = ["NO_MATERIAL_SIGNAL"];
  }

  const blocked = level === null;
  const requiresHumanEscalation = blocked || level === "ORANGE" || level === "RED";
  const requiredActions = blocked
    ? ["补齐企业主体、贷款账户和还款关键数据", "由风控经理人工复核后重新分级"]
    : level === "RED"
      ? ["立即升级风险管理负责人", "启动人工专项复核", "不得由 Agent 自动调整授信或分类"]
      : level === "ORANGE"
        ? ["提交人工风险复核", "缩短监测周期", "制定并跟踪风险缓释措施"]
        : level === "YELLOW"
          ? ["补充核验异常指标", "提高跟踪频率"]
          : ["维持常规监测"];

  return {
    schema: "ea.post-loan-risk-escalation.v1",
    policyCode: "POST_LOAN_RISK_ESCALATION",
    ruleVersion: "2.0",
    status: blocked ? "blocked" : "ready",
    level,
    triggers,
    requiredActions,
    requiresHumanEscalation,
    formalConclusionAllowed: !blocked,
    decisionId: decisionId(input, level, triggers),
  };
}
