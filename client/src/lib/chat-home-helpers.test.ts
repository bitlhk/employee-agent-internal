import { describe, expect, it } from "vitest";
import { flattenComposerSkills } from "./chat-home-helpers";

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
});
