import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestSkillSourceTree } from "./skill-artifact";

function fixture(): string {
  const root = path.join(
    os.tmpdir(),
    `ea-skill-artifact-${process.pid}-${Date.now()}-${Math.random()}`
  );
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "SKILL.md"),
    "---\nname: artifact-test\n---\n",
    "utf8"
  );
  writeFileSync(
    path.join(root, "scripts", "run.js"),
    "console.log('v1')\n",
    "utf8"
  );
  return root;
}

describe("immutable Skill artifacts", () => {
  it("produces a deterministic tree digest and changes it when bytes change", () => {
    const root = fixture();
    try {
      const first = digestSkillSourceTree(root);
      const second = digestSkillSourceTree(root);
      expect(second).toEqual(first);
      writeFileSync(
        path.join(root, "scripts", "run.js"),
        "console.log('v2')\n",
        "utf8"
      );
      expect(digestSkillSourceTree(root).sha256).not.toBe(first.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links from release artifacts", () => {
    const root = fixture();
    try {
      symlinkSync(path.join(root, "SKILL.md"), path.join(root, "linked.md"));
      expect(() => digestSkillSourceTree(root)).toThrow(/symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
