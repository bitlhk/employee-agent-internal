import { describe, expect, it } from "vitest";

import { expertVisualKind, investmentTeamMember, isInvestmentTeamMember } from "./ExpertAvatar";

describe("expertVisualKind", () => {
  it("uses the dedicated TCM expert avatar", () => {
    expect(expertVisualKind("tcm-expert", "中医专家")).toBe("tcm");
    expect(expertVisualKind("nihaixia", "经方知识")).toBe("tcm");
  });

  it("uses the six-member avatar for the investment committee", () => {
    expect(expertVisualKind("a-share-research-committee", "A股多策略投研团")).toBe("investment-team");
    expect(isInvestmentTeamMember("warren_buffett")).toBe(true);
    expect(isInvestmentTeamMember("risk_manager")).toBe(false);
    expect(investmentTeamMember("warren_buffett")?.name).toBe("巴菲特视角");
    expect(investmentTeamMember("warren_buffett")?.summary).toContain("长期回报");
  });
});
