import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeJiuwenSwarmWorkspaceRuntimePermissions } from "./jiuwenswarm-permissions";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("normalizeJiuwenSwarmWorkspaceRuntimePermissions", () => {
  it("makes newly provisioned workspace paths readable by the runtime group", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-permissions-"));
    roots.push(root);
    const agentRoot = path.join(root, "agent_jiuwen_lgj-test");
    const agentDir = path.join(agentRoot, "agent");
    const workspaceDir = path.join(agentDir, "jiuwenclaw_workspace");
    const skillsDir = path.join(workspaceDir, "skills");
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(identityPath, "# Identity\n", { mode: 0o600 });
    for (const dir of [agentRoot, agentDir, workspaceDir, skillsDir]) chmodSync(dir, 0o750);

    const runtimeGid = process.getgid();
    expect(normalizeJiuwenSwarmWorkspaceRuntimePermissions(workspaceDir, { runtimeGid })).toBe(true);

    for (const dir of [agentRoot, agentDir, workspaceDir, skillsDir]) {
      expect(lstatSync(dir).gid).toBe(runtimeGid);
      expect(lstatSync(dir).mode & 0o777).toBe(0o750);
    }
    expect(lstatSync(identityPath).gid).toBe(runtimeGid);
    expect(lstatSync(identityPath).mode & 0o777).toBe(0o640);
    expect(normalizeJiuwenSwarmWorkspaceRuntimePermissions(workspaceDir, { runtimeGid })).toBe(false);
  });

  it("does not follow workspace symlinks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-permissions-link-"));
    roots.push(root);
    const workspaceDir = path.join(root, "agent_jiuwen_lgj-test", "agent", "jiuwenclaw_workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "private\n", { mode: 0o600 });
    symlinkSync(outside, path.join(workspaceDir, "outside-link"));

    normalizeJiuwenSwarmWorkspaceRuntimePermissions(workspaceDir, { runtimeGid: process.getgid() });

    expect(lstatSync(outside).mode & 0o777).toBe(0o600);
  });
});
