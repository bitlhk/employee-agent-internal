import { describe, expect, it } from "vitest";
import { isRetiredSkillMarketRoute, toPublicSkillMarketItem } from "./skill-market-policy";

describe("legacy skill marketplace routes", () => {
  it("retires cross-user legacy publishing and installation routes", () => {
    expect(isRetiredSkillMarketRoute("GET", "/api/claw/shared-packages")).toBe(true);
    expect(isRetiredSkillMarketRoute("POST", "/api/claw/skill-package/publish")).toBe(true);
    expect(isRetiredSkillMarketRoute("POST", "/api/claw/skill-market/install")).toBe(true);
  });

  it("keeps personal upload and the reviewed marketplace flow available", () => {
    expect(isRetiredSkillMarketRoute("POST", "/api/claw/skill-package/upload")).toBe(false);
    expect(isRetiredSkillMarketRoute("POST", "/api/claw/skill-market/submit")).toBe(false);
    expect(isRetiredSkillMarketRoute("POST", "/api/claw/skill-package/install")).toBe(false);
  });
});

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
