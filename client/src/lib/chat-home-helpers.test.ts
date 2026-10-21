import { describe, expect, it } from "vitest";
import {
  flattenComposerSkills,
  chatRequestError,
  localizedComposerSkillLabel,
  prioritizeRoleConfiguredSkills,
} from "./chat-home-helpers";

describe("chat availability errors", () => {
  it("explains a sanitized unavailable runtime without displaying internal details", () => {
    expect(chatRequestError(503, { error: "内部服务器错误" })).toContain("智能体服务暂时不可用");
    expect(chatRequestError(503, { error: "connect ECONNREFUSED private-host:19000" })).not.toContain("private-host");
  });
  it("preserves actionable validation errors and handles empty responses", () => {
    expect(chatRequestError(400, { error: "请先输入问题" })).toBe("请先输入问题");
    expect(chatRequestError(502, null)).toBe("请求失败 (502)");
  });
});

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

  it("puts role-configured skills first without removing other skills", () => {
    const skills = flattenComposerSkills({
      private: [
        { id: "optional-report", label: "报告助手", sourceKind: "marketplace", state: "ready" },
        { id: "wealth-manager-assistant", label: "客户经理财富助手", sourceKind: "role_default", state: "ready" },
        { id: "personal-note", label: "记录助手", sourceKind: "uploaded", state: "ready" },
      ],
    });

    expect(prioritizeRoleConfiguredSkills(skills).map((skill) => skill.id)).toEqual([
      "wealth-manager-assistant",
      "optional-report",
      "personal-note",
    ]);
  });
});
