import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEnterpriseRuntimeAssetBundle,
  enterpriseRuntimeAssetsDirty,
} from "./enterprise-runtime-assets";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ea-runtime-assets-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(): { workspaceDir: string; outputRoot: string } {
  const root = temporaryDirectory();
  const workspaceDir = path.join(root, "workspace");
  const outputRoot = path.join(root, "bundles");
  mkdirSync(path.join(workspaceDir, "skills", "insurance-advisor"), { recursive: true });
  writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "# 保险顾问\n", "utf8");
  writeFileSync(path.join(workspaceDir, "USER.md"), "# 用户\n", "utf8");
  writeFileSync(path.join(workspaceDir, ".linggan-role-scope.json"), '{"version":1}\n', "utf8");
  writeFileSync(path.join(workspaceDir, "skills", "insurance-advisor", "SKILL.md"), "# Skill\n", "utf8");
  return { workspaceDir, outputRoot };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("enterprise runtime asset bundles", () => {
  it("treats only a newer desired revision as dirty", () => {
    expect(enterpriseRuntimeAssetsDirty({ desiredAssetRevision: 1, publishedAssetRevision: 1 })).toBe(false);
    expect(enterpriseRuntimeAssetsDirty({ desiredAssetRevision: 2, publishedAssetRevision: 1 })).toBe(true);
    expect(enterpriseRuntimeAssetsDirty({ desiredAssetRevision: 2, publishedAssetRevision: 2 })).toBe(false);
  });

  it("builds an immutable per-adoption bundle with checksums and no MCP credentials", () => {
    const { workspaceDir, outputRoot } = fixture();
    const first = buildEnterpriseRuntimeAssetBundle({
      adoptionId: "lgj-test",
      agentId: "agent-test",
      roleTemplate: "insurance-advisor",
      workspaceDir,
      binding: { bindingId: "rtb-test", workspaceKey: "workspace-test" },
      outputRoot,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    const second = buildEnterpriseRuntimeAssetBundle({
      adoptionId: "lgj-test",
      agentId: "agent-test",
      roleTemplate: "insurance-advisor",
      workspaceDir,
      binding: { bindingId: "rtb-test", workspaceKey: "workspace-test" },
      outputRoot,
      now: new Date("2026-08-15T01:00:00.000Z"),
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.manifest.files.map((file) => file.path)).toContain("skills/insurance-advisor/SKILL.md");
    const zip = new AdmZip(first.bundlePath);
    const manifest = JSON.parse(zip.readAsText("asset-set.json"));
    expect(manifest.fingerprint).toBe(first.fingerprint);
    expect(manifest.workspaceKey).toBe("workspace-test");
    expect(zip.getEntries().map((entry) => entry.entryName)).not.toContain("mcp.json");
    expect(readFileSync(first.bundlePath).length).toBeGreaterThan(0);
  });

  it("changes the fingerprint when a Skill changes", () => {
    const { workspaceDir, outputRoot } = fixture();
    const input = {
      adoptionId: "lgj-test",
      agentId: "agent-test",
      roleTemplate: "insurance-advisor",
      workspaceDir,
      binding: { bindingId: "rtb-test", workspaceKey: "workspace-test" },
      outputRoot,
    };
    const first = buildEnterpriseRuntimeAssetBundle(input);
    writeFileSync(path.join(workspaceDir, "skills", "insurance-advisor", "SKILL.md"), "# Changed\n", "utf8");
    const second = buildEnterpriseRuntimeAssetBundle(input);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("rejects symlinks and credential-like files", () => {
    const first = fixture();
    symlinkSync("/tmp", path.join(first.workspaceDir, "skills", "insurance-advisor", "linked"));
    expect(() => buildEnterpriseRuntimeAssetBundle({
      adoptionId: "lgj-test",
      agentId: "agent-test",
      roleTemplate: "insurance-advisor",
      workspaceDir: first.workspaceDir,
      binding: { bindingId: "rtb-test", workspaceKey: "workspace-test" },
      outputRoot: first.outputRoot,
    })).toThrow(/symlink/u);

    const second = fixture();
    writeFileSync(path.join(second.workspaceDir, "skills", "insurance-advisor", ".env"), "SECRET=1\n", "utf8");
    expect(() => buildEnterpriseRuntimeAssetBundle({
      adoptionId: "lgj-test",
      agentId: "agent-test",
      roleTemplate: "insurance-advisor",
      workspaceDir: second.workspaceDir,
      binding: { bindingId: "rtb-test", workspaceKey: "workspace-test" },
      outputRoot: second.outputRoot,
    })).toThrow(/credential-like/u);
  });
});
