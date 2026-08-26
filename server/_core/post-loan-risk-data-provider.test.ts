import { describe, expect, it } from "vitest";

import {
  buildPostLoanRiskSnapshot,
  executePostLoanRiskDataTool,
  POST_LOAN_RISK_DATA_TOOLS,
} from "./post-loan-risk-data-provider";
import { POST_LOAN_RISK_DEMO_ENTERPRISES } from "./post-loan-risk-demo-fixtures";

describe("post-loan risk data provider", () => {
  it("exposes enterprise discovery and immutable snapshot tools", () => {
    const names = POST_LOAN_RISK_DATA_TOOLS.map((tool) => tool.name);
    expect(names).toContain("list_risk_enterprises");
    expect(names).toContain("search_risk_enterprises");
    expect(names).toContain("get_post_loan_risk_snapshot");
  });

  it("searches only the governed demo enterprise directory", () => {
    const response = executePostLoanRiskDataTool("search_risk_enterprises", { query: "德信" });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: "READY",
      data: {
        total: 1,
        items: [{
          enterpriseId: "91440100MA5C00000B",
          enterpriseName: "德信商业地产开发有限公司",
        }],
      },
    });
  });

  it("builds the same fingerprint for the same immutable risk facts", () => {
    const enterprise = POST_LOAN_RISK_DEMO_ENTERPRISES[1];
    const first = buildPostLoanRiskSnapshot(enterprise);
    const second = buildPostLoanRiskSnapshot(enterprise);
    expect(first).toMatchObject({
      schema: "ea.post-loan-risk-snapshot.v1",
      status: "READY",
      snapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      data: {
        completeness: { criticalComplete: true, missingCriticalDomains: [] },
        constraints: {
          regulatoryClassificationAllowed: false,
          automaticCreditActionAllowed: false,
          humanReviewRequired: true,
        },
      },
    });
    expect(first.snapshotFingerprint).toBe(second.snapshotFingerprint);
  });

  it("fails closed when an enterprise is missing instead of constructing an optimistic skeleton", () => {
    const response = executePostLoanRiskDataTool("get_repayment_history", {
      unified_social_code: "911111111111111111",
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: "NOT_FOUND",
      reasonCode: "ENTERPRISE_NOT_FOUND_OR_NOT_AUTHORIZED",
    });
    expect(JSON.stringify(response)).not.toContain("无逾期");
  });

  it("does not expose risk data to another role", () => {
    const response = executePostLoanRiskDataTool(
      "list_risk_enterprises",
      {},
      "wealth-manager",
    );
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: "BLOCKED",
      reasonCode: "ROLE_NOT_AUTHORIZED",
    });
  });
});
