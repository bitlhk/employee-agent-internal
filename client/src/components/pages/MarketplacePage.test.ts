import { describe, expect, it } from "vitest";

import { skillRoleMarkOf } from "./MarketplacePage";

describe("skillRoleMarkOf", () => {
  it.each([
    ["post-loan-risk-control", "finance", "post-loan-risk-control", "智能风控", "控"],
    ["insurance-advisor", "insurance", "policy-advisor", "保险顾问", "保"],
    ["credential-compliance", "credential_audit", "credential-review", "凭证审核", "审"],
    ["wealth-manager", "finance", "portfolio-plan", "财富配置", "财"],
    ["investment-researcher", "finance", "stock-research", "个股研究", "投"],
    ["bond-trading", "bond_trading", "bond-quote-parse", "债券报价", "债"],
  ])("maps %s to the expected role mark", (roleTag, category, skillId, title, expected) => {
    expect(skillRoleMarkOf({ roleTag, category, skillId, title }).label).toBe(expected);
  });

  it("uses a general mark when no role signal exists", () => {
    expect(skillRoleMarkOf({ roleTag: "", category: "general", skillId: "hello", title: "问候" }).label).toBe("通");
  });
});
