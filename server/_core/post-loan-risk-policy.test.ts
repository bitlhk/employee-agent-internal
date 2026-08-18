import { describe, expect, it } from "vitest";
import { evaluatePostLoanRiskEscalation } from "./post-loan-risk-policy";

describe("post-loan deterministic risk escalation policy", () => {
  it("forces RED and human escalation for a 90-day overdue exposure", () => {
    expect(evaluatePostLoanRiskEscalation({
      roleTemplate: "post-loan-risk-control",
      overdueDays: 90,
      fiveLevelClass: "次级",
      criticalDataComplete: true,
    })).toMatchObject({
      status: "ready",
      level: "RED",
      requiresHumanEscalation: true,
      formalConclusionAllowed: true,
      triggers: expect.arrayContaining(["OVERDUE_90_DAYS"]),
    });
  });

  it("blocks a formal level when critical data is incomplete", () => {
    expect(evaluatePostLoanRiskEscalation({
      roleTemplate: "post-loan-risk-control",
      criticalDataComplete: false,
    })).toMatchObject({
      status: "blocked",
      level: null,
      formalConclusionAllowed: false,
      requiresHumanEscalation: true,
      triggers: ["CRITICAL_DATA_INCOMPLETE"],
    });
  });

  it("does not allow an adverse five-level class to be downgraded to green", () => {
    const result = evaluatePostLoanRiskEscalation({
      roleTemplate: "post-loan-risk-control",
      fiveLevelClass: "次级",
      criticalDataComplete: true,
    });
    expect(result.level).toBe("ORANGE");
    expect(result.triggers).toContain("FIVE_LEVEL_ADVERSE");
  });

  it("is deterministic for identical inputs", () => {
    const input = { roleTemplate: "post-loan-risk-control", overdueDays: 3, criticalDataComplete: true };
    expect(evaluatePostLoanRiskEscalation(input).decisionId)
      .toBe(evaluatePostLoanRiskEscalation(input).decisionId);
  });

  it("does not evaluate a different role", () => {
    expect(evaluatePostLoanRiskEscalation({
      roleTemplate: "general-assistant",
      overdueDays: 90,
      criticalDataComplete: true,
    })).toMatchObject({ status: "blocked", level: null, triggers: ["ROLE_NOT_AUTHORIZED"] });
  });
});
