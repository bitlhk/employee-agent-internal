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

    await expect(index.removeSkillPackageIndexRows("lgj-a", { skillId: "alpha" })).resolves.toHaveLength(1);
    expect(index.readSkillPackageIndex()).toEqual([
      { adoptId: "lgj-b", filename: "alpha.zip", installedSkillId: "alpha" },
    ]);
  });

  it("preserves concurrent appends from different Agents", async () => {
    process.env.APP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ea-skill-index-"));
    const index = await import("./skill-package-index");

    await Promise.all(Array.from({ length: 25 }, (_, i) => index.appendSkillPackageIndexRow({
      adoptId: `lgj-${i}`,
      filename: `skill-${i}.zip`,
      installedSkillId: `skill-${i}`,
    })));

    const rows = index.readSkillPackageIndex();
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((row) => row.adoptId)).size).toBe(25);
  });
});
