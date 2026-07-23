import { describe, expect, it } from "vitest";

import { expertVisualKind } from "./ExpertAvatar";

describe("expertVisualKind", () => {
  it("uses the dedicated TCM expert avatar", () => {
    expect(expertVisualKind("tcm-expert", "中医专家")).toBe("tcm");
    expect(expertVisualKind("nihaixia", "经方知识")).toBe("tcm");
  });
});
