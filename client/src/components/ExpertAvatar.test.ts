import { describe, expect, it } from "vitest";

import { expertVisualKind } from "./ExpertAvatar";

describe("expertVisualKind", () => {
  it("uses the dedicated TCM expert avatar", () => {
    expect(expertVisualKind("tcm-expert", "中医专家")).toBe("tcm");
    expect(expertVisualKind("nihaixia", "经方知识")).toBe("tcm");
  });

  it("uses the six-member avatar for the investment committee", () => {
    expect(expertVisualKind("a-share-research-committee", "股票多策略投研团")).toBe("investment-team");
  });
});
