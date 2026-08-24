import { describe, expect, it } from "vitest";
import {
  loadCustomerProfileSourceRemediationPlan,
  verifyCustomerProfileSourceRemediationPlan,
  type CustomerProfileSourceRemediationPlanV1,
} from "./customer-profile-source-remediation";

function clonePlan(): CustomerProfileSourceRemediationPlanV1 {
  return JSON.parse(
    JSON.stringify(loadCustomerProfileSourceRemediationPlan())
  ) as CustomerProfileSourceRemediationPlanV1;
}

describe("Customer Profile source remediation plan", () => {
  it("covers every current readiness gap without allowing activation", () => {
    const report = verifyCustomerProfileSourceRemediationPlan(clonePlan());
    expect(report.status).toBe("PASS");
    expect(report.workItemCount).toBe(9);
    expect(report.review).toEqual({ confirmed: 0, total: 9 });
    expect(report.runtimeActivationAllowed).toBe(false);
    expect(report.planFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an unowned required gap", () => {
    const plan = clonePlan();
    for (const item of plan.workItems)
      item.affectedFields = item.affectedFields.filter(
        field => field !== "insurance.currentCoverageSummary"
      );
    const report = verifyCustomerProfileSourceRemediationPlan(plan);
    expect(report.status).toBe("FAIL");
    expect(report.errors).toContain(
      "Unowned readiness gap: insurance.currentCoverageSummary"
    );
  });

  it("rejects secrets and activation flags in a review plan", () => {
    const plan = clonePlan() as CustomerProfileSourceRemediationPlanV1 & {
      credential?: string;
    };
    plan.activationPolicy.autoActivate = true as false;
    plan.credential = "must-not-be-stored";
    const report = verifyCustomerProfileSourceRemediationPlan(plan);
    expect(report.status).toBe("FAIL");
    expect(report.errors).toEqual(
      expect.arrayContaining([
        "Remediation plan must not activate runtime state",
        "Sensitive input is forbidden in remediation plan: credential",
      ])
    );
  });
});
