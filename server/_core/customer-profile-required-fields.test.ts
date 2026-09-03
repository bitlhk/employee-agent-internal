import { describe, expect, it } from "vitest";
import { customerProfileRequiredFieldIssue } from "./customer-profile-required-fields";

describe("customer profile required field errors", () => {
  it("maps governed profile field paths to business labels", () => {
    const issue = customerProfileRequiredFieldIssue({
      payload: {
        reasonCodes: ["CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"],
        missingRequiredFields: [
          "relationship.recentContactSummary",
          "preferences.investmentHorizon",
        ],
      },
    });

    expect(issue).toEqual({
      paths: [
        "relationship.recentContactSummary",
        "preferences.investmentHorizon",
      ],
      labels: ["最近联系摘要", "投资期限"],
    });
  });

  it("unwraps dependency errors and ignores unrelated failures", () => {
    expect(customerProfileRequiredFieldIssue({
      dependencyError: {
        payload: {
          reasonCodes: ["CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"],
          missingRequiredFields: ["risk.investmentRiskLevel"],
        },
      },
    })?.labels).toEqual(["风险等级"]);
    expect(customerProfileRequiredFieldIssue(new Error("upstream unavailable"))).toBeNull();
  });
});
