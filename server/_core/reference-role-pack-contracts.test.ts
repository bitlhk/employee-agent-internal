import { describe, expect, it } from "vitest";
import {
  classifyBenchmarkAssertion,
  runWealthRolePackContractChecks,
  WEALTH_EVAL_SUITE_VERSION,
} from "./reference-role-pack-contracts";

describe("wealth reference role pack contract runner", () => {
  it("validates all six benchmark task contracts and their code evidence", () => {
    const report = runWealthRolePackContractChecks();
    expect(report.status).toBe("PASS");
    expect(report.taskCount).toBe(6);
    expect(report.caseCount).toBeGreaterThanOrEqual(20);
    expect(report.capabilityEvidence.every((item) => item.status === "PASS")).toBe(true);
    expect(report.scenarioExecution).toBe(false);
    expect(report.releaseCandidateId.endsWith(`:${WEALTH_EVAL_SUITE_VERSION}`)).toBe(true);
  });

  it("does not silently accept an assertion without a proof category", () => {
    expect(classifyBenchmarkAssertion("some_future_unclassified_claim")).toBeNull();
  });
});
