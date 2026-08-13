import { describe, expect, it } from "vitest";
import {
  classifyBenchmarkAssertion,
  INSURANCE_EVAL_SUITE_VERSION,
  runInsuranceRolePackContractChecks,
  runWealthRolePackContractChecks,
  WEALTH_EVAL_SUITE_VERSION,
} from "./reference-role-pack-contracts";

describe("GRACE role replication contracts", () => {
  it.each([
    ["wealth-manager", runWealthRolePackContractChecks, WEALTH_EVAL_SUITE_VERSION],
    ["insurance-advisor", runInsuranceRolePackContractChecks, INSURANCE_EVAL_SUITE_VERSION],
  ] as const)("validates the %s Reference Role Pack", (roleTemplate, runner, version) => {
    const report = runner();
    expect(report.status, report.errors.join("\n")).toBe("PASS");
    expect(report.roleTemplate).toBe(roleTemplate);
    expect(report.taskCount).toBe(6);
    expect(report.caseCount).toBeGreaterThanOrEqual(20);
    expect(report.capabilityEvidence.every((item) => item.status === "PASS")).toBe(true);
    expect(report.scenarioExecution).toBe(false);
    expect(report.releaseCandidateId.endsWith(`:${version}`)).toBe(true);
  });

  it("does not silently accept an assertion without a proof category", () => {
    expect(classifyBenchmarkAssertion("some_future_unclassified_claim")).toBeNull();
  });
});
