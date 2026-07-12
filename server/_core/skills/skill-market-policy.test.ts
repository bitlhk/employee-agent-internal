import { describe, expect, it } from "vitest";
import { toPublicSkillMarketItem } from "./skill-market-policy";

describe("public skill marketplace DTO", () => {
  it("does not expose reviewer, tenant, or server filesystem fields", () => {
    const item = toPublicSkillMarketItem({
      id: 7,
      skillId: "market-skill",
      name: "Market Skill",
      authorUserId: 42,
      reviewNote: "internal review",
      packagePath: "/srv/private/market-skill",
    });
    expect(item).toMatchObject({ id: 7, skillId: "market-skill", name: "Market Skill" });
    expect(item).not.toHaveProperty("authorUserId");
    expect(item).not.toHaveProperty("reviewNote");
    expect(item).not.toHaveProperty("packagePath");
  });
});
