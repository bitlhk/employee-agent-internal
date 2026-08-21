import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../../../shared/types/skill";
import { buildSkillSecuritySubject } from "./skill-security-package";

const roots: string[] = [];

function skill(sourcePath: string): Skill {
  return {
    id: "security-test",
    adoptId: "lgj-security-test",
    source: { kind: "uploaded", skillId: "security-test", displayName: "Security Test", sourcePath },
    state: "ready",
    enabled: true,
    review: { state: "none" },
    sync: {},
    capabilities: [],
    examples: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-security-package-"));
  roots.push(root);
  writeFileSync(path.join(root, "SKILL.md"), "# Security Test\n");
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts", "run.py"), "print('ok')\n");
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("buildSkillSecuritySubject", () => {
  it("produces a stable package fingerprint for unchanged source", () => {
    const root = fixture();
    const first = buildSkillSecuritySubject(skill(root));
    const second = buildSkillSecuritySubject(skill(root));
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.file.equals(first.file)).toBe(true);
  });

  it("changes the fingerprint when source content changes", () => {
    const root = fixture();
    const first = buildSkillSecuritySubject(skill(root));
    writeFileSync(path.join(root, "scripts", "run.py"), "print('changed')\n");
    const second = buildSkillSecuritySubject(skill(root));
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("does not follow symbolic links", () => {
    const root = fixture();
    const secret = path.join(root, "..", `secret-${Date.now()}.txt`);
    writeFileSync(secret, "secret");
    roots.push(secret);
    symlinkSync(secret, path.join(root, "external-secret"));
    expect(() => buildSkillSecuritySubject(skill(root))).not.toThrow();
  });

  it("rejects directories without a root SKILL.md", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-security-package-missing-"));
    roots.push(root);
    writeFileSync(path.join(root, "README.md"), "missing\n");
    expect(() => buildSkillSecuritySubject(skill(root))).toThrow(/SKILL\.md/u);
  });
});
