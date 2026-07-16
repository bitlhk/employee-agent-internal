import { existsSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { roleAdoptionVisual } from "./RoleAdoptionDialog";

describe("role adoption visuals", () => {
  it("maps every supported role to its digital employee asset", () => {
    const expected = [
      ["general-assistant", "灵犀"],
      ["wealth-manager", "知衡"],
      ["post-loan-risk-control", "察微"],
      ["credential-compliance", "明鉴"],
      ["insurance-advisor", "安护"],
      ["investment-researcher", "观澜"],
    ] as const;

    for (const [roleId, persona] of expected) {
      const visual = roleAdoptionVisual(roleId);
      expect(visual.persona).toBe(persona);
      expect(visual.capabilities).toHaveLength(3);
      expect(existsSync(path.join(process.cwd(), "client/public", visual.image.replace(/^\//, "")))).toBe(true);
    }
  });

  it("uses the neutral employee visual for future roles without custom art", () => {
    expect(roleAdoptionVisual("future-role").persona).toBe("灵犀");
  });
});
