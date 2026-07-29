import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  delete process.env.APP_ROOT;
});
describe("skill package index", () => {
  it("removes only the requested Agent package", async () => {
    process.env.APP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ea-skill-index-"));
    const index = await import("./skill-package-index");
    index.writeSkillPackageIndex([
      { adoptId: "lgj-a", filename: "alpha.zip", installedSkillId: "alpha" },
      { adoptId: "lgj-b", filename: "alpha.zip", installedSkillId: "alpha" },
    ]);

    expect(index.removeSkillPackageIndexRows("lgj-a", { skillId: "alpha" })).toHaveLength(1);
    expect(index.readSkillPackageIndex()).toEqual([
      { adoptId: "lgj-b", filename: "alpha.zip", installedSkillId: "alpha" },
    ]);
  });
});
