import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { digestSkillSourceTree } from "./skill-artifact-digest";
it("hashes nested entries using portable paths and exact file bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ea-digest-"));
  try {
    mkdirSync(path.join(root, "references"));
    writeFileSync(path.join(root, "references", "a.md"), "test");
    const expected = createHash("sha256")
      .update("D\0\0D\0references\0F\0references/a.md\x004\0test\0")
      .digest("hex");
    expect(digestSkillSourceTree(root)).toEqual({ sha256: expected, size: 4 });
    writeFileSync(path.join(root, "references", "a.md"), "edit");
    expect(digestSkillSourceTree(root).sha256).not.toBe(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
