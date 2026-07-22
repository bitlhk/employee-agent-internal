import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { FileSystemSkillInstaller } from "./skill-installer";

describe("FileSystemSkillInstaller", () => {
  it("copies a physical skill directory into a physical runtime directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-installer-copy-"));
    try {
      const source = path.join(root, "source");
      const runtime = path.join(root, "runtime", "skill");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Skill\n", "utf8");

      new FileSystemSkillInstaller().installFromSource(source, runtime);

      expect(lstatSync(runtime).isSymbolicLink()).toBe(false);
      expect(existsSync(path.join(runtime, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes runtime permissions while preserving executable scripts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-installer-mode-"));
    try {
      const source = path.join(root, "source");
      const runtime = path.join(root, "runtime", "skill");
      mkdirSync(path.join(source, "scripts"), { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Skill\n", "utf8");
      const executable = path.join(source, "scripts", "run.sh");
      writeFileSync(executable, "#!/bin/sh\n", "utf8");
      chmodSync(source, 0o700);
      chmodSync(path.join(source, "SKILL.md"), 0o600);
      chmodSync(executable, 0o700);

      new FileSystemSkillInstaller().installFromSource(source, runtime);

      expect(lstatSync(runtime).mode & 0o777).toBe(0o750);
      expect(lstatSync(path.join(runtime, "SKILL.md")).mode & 0o777).toBe(0o640);
      expect(lstatSync(path.join(runtime, "scripts", "run.sh")).mode & 0o777).toBe(0o750);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects root and nested symbolic links", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-installer-links-"));
    try {
      const source = path.join(root, "source");
      const linkedSource = path.join(root, "linked-source");
      const external = path.join(root, "external.txt");
      const runtime = path.join(root, "runtime", "skill");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Skill\n", "utf8");
      writeFileSync(external, "external\n", "utf8");
      symlinkSync(source, linkedSource, "dir");

      const installer = new FileSystemSkillInstaller();
      expect(installer.canInstall(linkedSource)).toBe(false);
      expect(() => installer.installFromSource(linkedSource, runtime)).toThrow("must not be a symbolic link");

      symlinkSync(external, path.join(source, "reference.txt"));
      expect(() => installer.installFromSource(source, runtime)).toThrow("must not contain symbolic links");
      expect(existsSync(runtime)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
