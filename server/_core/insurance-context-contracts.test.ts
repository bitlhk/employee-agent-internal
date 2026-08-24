import { describe, expect, it } from "vitest";
import { runInsuranceContextContractChecks } from "./insurance-context-contracts";

describe("Insurance Context Contract V1", () => {
  it("freezes the expert-confirmed semantic baseline without claiming runtime reuse", () => {
    const report = runInsuranceContextContractChecks(process.cwd(), { requireExpertConfirmed: true });

    expect(report.status).toBe("PASS");
    expect(report.uniqueContextNeedCount).toBe(10);
    expect(report.expertConfirmedNeedCount).toBe(10);
    expect(report.goldenCaseCount).toBe(15);
    expect(report.expertConfirmedCaseCount).toBe(15);
    expect(report.existingLogicalContextReuseRatio).toBe(0.6);
    expect(report.sharedContextBindingIdentityRate).toBe(0);
    expect(report.runtimeReuseStatus).toBe("NEEDS_RESOLUTION");
    expect(report.contractFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
