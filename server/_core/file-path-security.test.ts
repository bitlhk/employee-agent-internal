import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExistingRegularFile,
  resolveExistingWorkspacePath,
  resolveWorkspaceDeletePath,
  resolveWorkspaceWritePath,
} from "./file-path-security";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ea-path-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const approved = path.join(root, "approved-skills");
  const secret = path.join(root, "secret");
  mkdirSync(workspace); mkdirSync(approved); mkdirSync(secret);
  writeFileSync(path.join(approved, "SKILL.md"), "approved");
  writeFileSync(path.join(secret, "secret.txt"), "secret");
  return { workspace, approved, secret };
}

describe("workspace path boundaries", () => {
  it("allows normal workspace files and approved managed skill links", () => {
    const { workspace, approved } = fixture();
    writeFileSync(path.join(workspace, "note.txt"), "ok");
    mkdirSync(path.join(workspace, "skills"));
    symlinkSync(approved, path.join(workspace, "skills", "approved"), "dir");
    expect(resolveExistingWorkspacePath(workspace, "note.txt")).toBe(path.join(workspace, "note.txt"));
    expect(resolveExistingWorkspacePath(workspace, "skills/approved/SKILL.md", [approved])).toBe(path.join(approved, "SKILL.md"));
  });

  it("rejects unapproved symlink escapes for reads and writes", () => {
    const { workspace, secret } = fixture();
    symlinkSync(secret, path.join(workspace, "escape"), "dir");
    expect(resolveExistingWorkspacePath(workspace, "escape/secret.txt")).toBeNull();
    expect(resolveWorkspaceWritePath(workspace, "escape/new.txt")).toBeNull();
    expect(resolveWorkspaceDeletePath(workspace, "escape/secret.txt")).toBeNull();
    expect(resolveWorkspaceDeletePath(workspace, "escape")).toBe(path.join(workspace, "escape"));
  });

  it("does not allow a managed skill link into another agent's private store", () => {
    const { workspace } = fixture();
    const store = path.join(path.dirname(workspace), "skill-store", "agents");
    const currentAgent = path.join(store, "lgc-current");
    const otherAgent = path.join(store, "lgc-other", "uploaded", "private-skill");
    mkdirSync(currentAgent, { recursive: true });
    mkdirSync(otherAgent, { recursive: true });
    writeFileSync(path.join(otherAgent, "SKILL.md"), "private");
    mkdirSync(path.join(workspace, "skills"));
    symlinkSync(otherAgent, path.join(workspace, "skills", "private-skill"), "dir");

    expect(resolveExistingWorkspacePath(
      workspace,
      "skills/private-skill/SKILL.md",
      [currentAgent],
    )).toBeNull();
  });

  it("accepts only non-symlink regular files inside the requested root", () => {
    const { workspace, secret } = fixture();
    const regularFile = path.join(workspace, "result.txt");
    writeFileSync(regularFile, "safe");
    mkdirSync(path.join(workspace, "folder"));
    symlinkSync(path.join(secret, "secret.txt"), path.join(workspace, "external-link.txt"));
    symlinkSync(regularFile, path.join(workspace, "internal-link.txt"));

    expect(resolveExistingRegularFile(workspace, "result.txt")).toBe(regularFile);
    expect(resolveExistingRegularFile(workspace, "folder")).toBeNull();
    expect(resolveExistingRegularFile(workspace, "external-link.txt")).toBeNull();
    expect(resolveExistingRegularFile(workspace, "internal-link.txt")).toBeNull();
    expect(resolveExistingRegularFile(workspace, "../secret/secret.txt")).toBeNull();
  });
});
