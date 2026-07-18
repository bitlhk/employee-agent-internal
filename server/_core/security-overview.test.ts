import { describe, expect, it } from "vitest";
import {
  deriveSecurityOverviewStatus,
  ratioPercent,
  traceabilityCoverage,
} from "./security-overview";

const healthyInput = {
  ledgerAvailable: true,
  ledgerHealthy: true,
  hasLedgerEvents: true,
  failedEvents24h: 0,
  deniedEvents24h: 0,
  highRiskEvents24h: 0,
  activeFindings: 0,
  highRiskFindings: 0,
  dlqEvents: 0,
  nativeExecutions7d: 0,
  traceabilityPercents: [100, 100, null],
};

describe("security overview", () => {
  it("calculates bounded traceability percentages", () => {
    expect(ratioPercent(19, 20)).toBe(95);
    expect(ratioPercent(20, 20)).toBe(100);
    expect(ratioPercent(25, 20)).toBe(100);
    expect(ratioPercent(0, 0)).toBeNull();
    expect(traceabilityCoverage(19, 20)).toBe("covered");
    expect(traceabilityCoverage(18, 20)).toBe("partial");
    expect(traceabilityCoverage(0, 0)).toBe("unverified");
  });

  it("reports normal only when the ledger and recent signals are healthy", () => {
    expect(deriveSecurityOverviewStatus(healthyInput)).toEqual({
      status: "normal",
      reasons: ["审计链路正常，近24小时未发现高危或失败事件"],
    });
  });

  it("prioritizes active risks over warnings", () => {
    const result = deriveSecurityOverviewStatus({
      ...healthyInput,
      ledgerHealthy: false,
      failedEvents24h: 2,
      nativeExecutions7d: 1,
    });
    expect(result.status).toBe("risk");
    expect(result.reasons[0]).toContain("宿主机工具执行");
  });

  it("reports incomplete evidence without claiming the platform is safe", () => {
    expect(deriveSecurityOverviewStatus({ ...healthyInput, hasLedgerEvents: false }).status).toBe("unverified");
    expect(deriveSecurityOverviewStatus({ ...healthyInput, traceabilityPercents: [90, 100] }).status).toBe("attention");
  });
});
