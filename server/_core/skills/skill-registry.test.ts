import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { Skill } from "../../../shared/types/skill";
import { FileSkillRegistry } from "./skill-registry";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "lingxia-skill-registry-"));
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function makeSkill(root: string, id: string, state: Skill["state"] = "ready"): Skill {
  return {
    id,
    adoptId: "lgc-test",
    source: {
      kind: "uploaded",
      skillId: id,
      displayName: id,
      sourcePath: path.join(root, "workspace", "lgc-test", "skills", id),
    },
    state,
    enabled: true,
    review: { state: "none" },
    sync: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function registry(root: string): FileSkillRegistry {
  return new FileSkillRegistry({
    appRoot: root,
    openclawHome: path.join(root, ".openclaw"),
    resolveRuntimeAgentId: async (adoptId) => `trial_${adoptId}`,
    now: () => new Date("2026-05-01T01:00:00.000Z"),
  });
}

function cachedRegistry(root: string, options: {
  now?: () => Date;
  listCacheTtlMs?: number;
  resolveRuntimeAgentId?: (adoptId: string) => Promise<string>;
} = {}): FileSkillRegistry {
  return new FileSkillRegistry({
    appRoot: root,
    openclawHome: path.join(root, ".openclaw"),
    resolveRuntimeAgentId: options.resolveRuntimeAgentId || (async (adoptId) => `trial_${adoptId}`),
    now: options.now || (() => new Date()),
    listCacheTtlMs: options.listCacheTtlMs,
  });
}

function createSkillZip(zipPath: string, skillId: string, body = "# Skill\n"): void {
  mkdirSync(path.dirname(zipPath), { recursive: true });
  const script = `
import sys, zipfile
zip_path, skill_id, body = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zip_path, "w") as z:
    z.writestr(skill_id + "/SKILL.md", body)
    z.writestr(skill_id + "/scripts/run.py", "print('ok')\\n")
`;
  execFileSync("python3", ["-c", script, zipPath, skillId, body], { stdio: "pipe" });
}

describe("FileSkillRegistry.reconcile", () => {
  it("coalesces concurrent skill list scans and returns isolated cached values", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "workspace", "lgc-test", "skills", "cached-skill");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Cached Skill\n", "utf-8");
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "cached-skill")]);
      const resolveAgent = vi.fn(async (adoptId: string) => `trial_${adoptId}`);
      const reg = cachedRegistry(root, { resolveRuntimeAgentId: resolveAgent });

      const results = await Promise.all(Array.from({ length: 50 }, () => reg.listSkills("lgc-test")));

      expect(results.every((result) => result.ok && result.value.length === 1)).toBe(true);
      expect(resolveAgent).toHaveBeenCalledTimes(1);
      const first = results[0];
      if (first?.ok) first.value[0]!.source.displayName = "mutated-by-caller";
      const cached = await reg.listSkills("lgc-test");
      expect(cached.ok && cached.value[0]?.source.displayName).toBe("cached-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates the skill list cache immediately after a registry mutation", async () => {
    const root = tempRoot();
    try {
      const skill = makeSkill(root, "rename-me");
      writeJson(path.join(root, "data", "skill-registry.json"), [skill]);
      const reg = cachedRegistry(root, { listCacheTtlMs: 60_000 });
      const before = await reg.listSkills("lgc-test");
      expect(before.ok && before.value[0]?.source.displayName).toBe("rename-me");

      const renamed = await reg.rename("lgc-test", "rename-me", "Renamed Skill");
      expect(renamed.ok).toBe(true);
      const after = await reg.listSkills("lgc-test");
      expect(after.ok && after.value[0]?.source.displayName).toBe("Renamed Skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes only retired role-default skills and preserves user-installed skills", async () => {
    const root = tempRoot();
    try {
      const retired = makeSkill(root, "retired-default");
      retired.source.kind = "role_default";
      retired.sync.runtimePath = path.join(root, "runtime", "retired-default");
      const current = makeSkill(root, "current-default");
      current.source.kind = "role_default";
      current.sync.runtimePath = path.join(root, "runtime", "current-default");
      const userInstalled = makeSkill(root, "user-installed");
      userInstalled.sync.runtimePath = path.join(root, "runtime", "user-installed");
      for (const skill of [retired, current, userInstalled]) {
        mkdirSync(skill.sync.runtimePath!, { recursive: true });
        writeFileSync(path.join(skill.sync.runtimePath!, "SKILL.md"), `# ${skill.id}\n`, "utf8");
      }
      writeJson(path.join(root, "data", "skill-registry.json"), [retired, current, userInstalled]);
      const reg = registry(root);

      const result = await reg.pruneRetiredRoleDefaults("lgc-test", ["current-default"]);

      expect(result).toEqual({ ok: true, value: ["retired-default"] });
      expect(existsSync(retired.sync.runtimePath!)).toBe(false);
      expect(existsSync(current.sync.runtimePath!)).toBe(true);
      expect(existsSync(userInstalled.sync.runtimePath!)).toBe(true);
      const listed = await reg.listSkills("lgc-test");
      expect(listed.ok && listed.value.map((skill) => skill.id).sort()).toEqual(["current-default", "user-installed"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes the skill list from disk after the cache TTL expires", async () => {
    const root = tempRoot();
    let nowMs = Date.parse("2026-05-01T01:00:00.000Z");
    try {
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "alpha")]);
      const reg = cachedRegistry(root, {
        now: () => new Date(nowMs),
        listCacheTtlMs: 5_000,
      });

      const first = await reg.listSkills("lgc-test");
      expect(first.ok && first.value[0]?.id).toBe("alpha");
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "beta")]);
      const stillCached = await reg.listSkills("lgc-test");
      expect(stillCached.ok && stillCached.value[0]?.id).toBe("alpha");

      nowMs += 5_001;
      const refreshed = await reg.listSkills("lgc-test");
      expect(refreshed.ok && refreshed.value[0]?.id).toBe("beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves concurrent installs from separate Agent instances", async () => {
    const root = tempRoot();
    try {
      const sources = ["lgc-one", "lgc-two"].map((adoptId) => {
        const source = path.join(root, "sources", adoptId, "shared-skill");
        mkdirSync(source, { recursive: true });
        writeFileSync(path.join(source, "SKILL.md"), `# ${adoptId}\n`, "utf-8");
        return { adoptId, source };
      });

      const results = await Promise.all(sources.map(({ adoptId, source }) => registry(root).install(adoptId, {
        kind: "uploaded",
        skillId: "shared-skill",
        displayName: `Skill ${adoptId}`,
        sourcePath: source,
      })));

      expect(results.every((result) => result.ok)).toBe(true);
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row: Skill) => row.adoptId))).toEqual(new Set(["lgc-one", "lgc-two"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies source to runtime when runtime copy is missing", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "workspace", "lgc-test", "skills", "alpha");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Alpha\n", "utf-8");
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "alpha")]);

      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items[0]?.action).toBe("copied_to_runtime");
      expect(existsSync(path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "alpha", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes runtime copy when source is newer", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "workspace", "lgc-test", "skills", "beta");
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "beta");
      mkdirSync(source, { recursive: true });
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(runtime, "SKILL.md"), "old\n", "utf-8");
      writeFileSync(path.join(source, "SKILL.md"), "new content\n", "utf-8");
      const future = new Date(Date.now() + 5000);
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(path.join(source, "extra.txt"), String(future.getTime()), "utf-8");
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "beta")]);

      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items[0]?.action).toBe("refreshed_runtime");
      expect(readFileSync(path.join(runtime, "SKILL.md"), "utf-8")).toBe("new content\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes runtime copy when source is missing", async () => {
    const root = tempRoot();
    try {
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "gamma");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(runtime, "SKILL.md"), "# Gamma\n", "utf-8");
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "gamma")]);

      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items[0]?.action).toBe("deleted_runtime_copy");
      expect(existsSync(runtime)).toBe(false);
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows[0].state).toBe("source_missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes registry entry when source and runtime are both missing", async () => {
    const root = tempRoot();
    try {
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "delta")]);
      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items[0]?.action).toBe("removed_registry_entry");
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts zip source to runtime when runtime copy is missing", async () => {
    const root = tempRoot();
    try {
      const sourceFile = path.join(root, "workspace", "lgc-test", "skills", "epsilon.zip");
      createSkillZip(sourceFile, "epsilon", "# Epsilon\n");
      const skill = makeSkill(root, "epsilon", "syncing");
      skill.source.sourcePath = sourceFile;
      writeJson(path.join(root, "data", "skill-registry.json"), [skill]);

      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.failed).toBe(0);
      expect(result.value.items[0]?.action).toBe("copied_to_runtime");
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "epsilon");
      expect(readFileSync(path.join(runtime, "SKILL.md"), "utf-8")).toBe("# Epsilon\n");
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows[0].state).toBe("ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports sync_failed when source is an unsupported file and runtime is missing", async () => {
    const root = tempRoot();
    try {
      const sourceFile = path.join(root, "workspace", "lgc-test", "skills", "epsilon.txt");
      mkdirSync(path.dirname(sourceFile), { recursive: true });
      writeFileSync(sourceFile, "not a skill package", "utf-8");
      const skill = makeSkill(root, "epsilon", "syncing");
      skill.source.sourcePath = sourceFile;
      writeJson(path.join(root, "data", "skill-registry.json"), [skill]);

      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.failed).toBe(1);
      expect(result.value.items[0]?.action).toBe("reported_error");
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows[0].state).toBe("sync_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes marketplace runtime copy when source version is newer", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "marketplace", "market-alpha");
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "market-alpha");
      mkdirSync(source, { recursive: true });
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Market Alpha v2\n", "utf-8");
      writeFileSync(path.join(runtime, "SKILL.md"), "# Market Alpha v1\n", "utf-8");

      const existing = makeSkill(root, "market-alpha");
      existing.source = {
        kind: "marketplace",
        skillId: "market-alpha",
        displayName: "Market Alpha",
        sourcePath: source,
        marketplaceId: "1",
        version: "1.0.0",
      };
      existing.sync.runtimePath = runtime;
      writeJson(path.join(root, "data", "skill-registry.json"), [existing]);

      const installed = await registry(root).install("lgc-test", {
        kind: "marketplace",
        skillId: "market-alpha",
        displayName: "Market Alpha",
        sourcePath: source,
        marketplaceId: "1",
        version: "2.0.0",
      });

      expect(installed.ok).toBe(true);
      expect(readFileSync(path.join(runtime, "SKILL.md"), "utf-8")).toBe("# Market Alpha v2\n");
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows[0].source.version).toBe("2.0.0");
      expect(rows[0].state).toBe("ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps installed marketplace copy when source version is older", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "marketplace", "market-beta");
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "market-beta");
      mkdirSync(source, { recursive: true });
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Market Beta old\n", "utf-8");
      writeFileSync(path.join(runtime, "SKILL.md"), "# Market Beta installed\n", "utf-8");

      const existing = makeSkill(root, "market-beta");
      existing.source = {
        kind: "marketplace",
        skillId: "market-beta",
        displayName: "Market Beta",
        sourcePath: source,
        marketplaceId: "2",
        version: "2.0.0",
      };
      existing.sync.runtimePath = runtime;
      writeJson(path.join(root, "data", "skill-registry.json"), [existing]);

      const installed = await registry(root).install("lgc-test", {
        kind: "marketplace",
        skillId: "market-beta",
        displayName: "Market Beta",
        sourcePath: source,
        marketplaceId: "2",
        version: "1.0.0",
      });

      expect(installed.ok).toBe(true);
      expect(readFileSync(path.join(runtime, "SKILL.md"), "utf-8")).toBe("# Market Beta installed\n");
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows).toHaveLength(1);
      expect(rows[0].source.version).toBe("2.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create duplicate registry entries on repeated marketplace install", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "marketplace", "market-gamma");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Market Gamma\n", "utf-8");
      const reg = registry(root);
      const sourceDef = {
        kind: "marketplace" as const,
        skillId: "market-gamma",
        displayName: "Market Gamma",
        sourcePath: source,
        marketplaceId: "3",
        version: "1.0.0",
      };

      expect((await reg.install("lgc-test", sourceDef)).ok).toBe(true);
      expect((await reg.install("lgc-test", sourceDef)).ok).toBe(true);
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("market-gamma");
      expect(rows[0].source.marketplaceId).toBe("3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes marketplace registry entry on uninstall so it disappears from my skills", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "marketplace", "market-delta");
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "market-delta");
      mkdirSync(source, { recursive: true });
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Market Delta\n", "utf-8");
      writeFileSync(path.join(runtime, "SKILL.md"), "# Runtime Delta\n", "utf-8");

      const existing = makeSkill(root, "market-delta");
      existing.source = {
        kind: "marketplace",
        skillId: "market-delta",
        displayName: "Market Delta",
        sourcePath: source,
        marketplaceId: "4",
        version: "1.0.0",
      };
      existing.sync.runtimePath = runtime;
      writeJson(path.join(root, "data", "skill-registry.json"), [existing]);

      const uninstalled = await registry(root).uninstall("lgc-test", "market-delta");
      expect(uninstalled.ok).toBe(true);
      expect(existsSync(runtime)).toBe(false);
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("destroys generated runtime aliases so discovery cannot recreate the registry entry", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "data", "generated-skills", "lgc-test", "skill-md");
      const runtime = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "skill-md");
      const alias = path.join(root, ".openclaw", "workspace-trial_lgc-test", "skills", "smoke-original");
      mkdirSync(source, { recursive: true });
      mkdirSync(runtime, { recursive: true });
      mkdirSync(alias, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Smoke Skill\n\nReturns SKILL_OK.\n", "utf-8");
      writeFileSync(path.join(runtime, "SKILL.md"), "# Smoke Skill\n\nReturns SKILL_OK.\n", "utf-8");
      writeFileSync(path.join(alias, "SKILL.md"), "# Smoke Skill\n\nReturns SKILL_OK.\n", "utf-8");

      const existing = makeSkill(root, "skill-md");
      existing.source = {
        kind: "generated",
        skillId: "skill-md",
        displayName: "Smoke Skill",
        sourcePath: source,
      };
      existing.sync.runtimePath = runtime;
      writeJson(path.join(root, "data", "skill-registry.json"), [existing]);

      const destroyed = await registry(root).destroy("lgc-test", "skill-md");
      expect(destroyed.ok).toBe(true);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(runtime)).toBe(false);
      expect(existsSync(alias)).toBe(false);
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses OpenClaw agent.workspace as runtime skills directory and syncs agent skill allowlist", async () => {
    const root = tempRoot();
    try {
      const source = path.join(root, "workspace", "lgc-test", "skills", "agent-alpha");
      const customWorkspace = path.join(root, ".openclaw", "custom-agent-workspace");
      mkdirSync(source, { recursive: true });
      mkdirSync(path.dirname(customWorkspace), { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# Agent Alpha\n", "utf-8");
      writeJson(path.join(root, ".openclaw", "openclaw.json"), {
        agents: { list: [{ id: "trial_lgc-test", workspace: customWorkspace }] },
      });
      writeJson(path.join(root, "data", "skill-registry.json"), [makeSkill(root, "agent-alpha")]);

      const result = await registry(root).reconcile("lgc-test");
      expect(result.ok).toBe(true);
      expect(existsSync(path.join(customWorkspace, "skills", "agent-alpha", "SKILL.md"))).toBe(true);
      const rows = JSON.parse(readFileSync(path.join(root, "data", "skill-registry.json"), "utf-8"));
      expect(rows[0].sync.runtimePath).toBe(path.join(customWorkspace, "skills", "agent-alpha"));
      const cfg = JSON.parse(readFileSync(path.join(root, ".openclaw", "openclaw.json"), "utf-8"));
      expect(cfg.agents.list[0].skills).toEqual(["agent-alpha"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
