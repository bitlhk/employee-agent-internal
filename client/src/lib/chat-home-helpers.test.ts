import { describe, expect, it } from "vitest";
import { flattenComposerSkills, localizedComposerSkillLabel } from "./chat-home-helpers";

describe("flattenComposerSkills", () => {
  it("preserves the registry source kind carried by the skill DTO", () => {
    const result = flattenComposerSkills({
      private: [
        {
          id: "wealth-manager-assistant",
          label: "客户经理财富助手",
          source: "private",
          sourceKind: "role_default",
          scope: "private",
          state: "ready",
          enabled: true,
          runnable: true,
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: "wealth-manager-assistant",
        source: "role_default",
      }),
    ]);
  });

  it("removes English qualifiers from Chinese role skill labels", () => {
    expect(localizedComposerSkillLabel({
      label: "财富目标测算（Wealth Goal Calculator）",
      desc: "测算财富目标。",
    })).toBe("财富目标测算");
    expect(localizedComposerSkillLabel({
      label: "组合诊断师（Portfolio Doctor）",
      desc: "分析投资组合。",
    })).toBe("组合诊断师");
  });
});
