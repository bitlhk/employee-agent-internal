import { describe, expect, it } from "vitest";
import {
  diffSortedRoleAssets,
  resolveSelectableAdoptRoleTemplate,
} from "./admin-role-reset";

describe("admin role reset helpers", () => {
  it("returns deterministic role asset differences", () => {
    expect(
      diffSortedRoleAssets(
        ["skill-b", "skill-a", "skill-b", ""],
        ["skill-c", "skill-b", "skill-c"],
      ),
    ).toEqual({
      added: ["skill-c"],
      removed: ["skill-a"],
    });
  });

  it("accepts selectable roles and rejects unknown roles", () => {
    expect(resolveSelectableAdoptRoleTemplate("general-assistant").id).toBe(
      "general-assistant",
    );

    expect(() => resolveSelectableAdoptRoleTemplate("unknown-role")).toThrow(
      "Unknown role template",
    );
  });
});
