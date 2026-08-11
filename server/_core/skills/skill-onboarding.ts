import path from "path";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import type { Skill, SkillSource } from "../../../shared/types/skill";
import { APP_ROOT, OPENCLAW_HOME, resolveRuntimeAgentId } from "../helpers";
import { writeJsonFileAtomicSync } from "../atomic-json-file";
import { withSerializedFileMutation } from "../serialized-file-mutation";
import { skillRegistry } from "./skill-registry";

type OnboardResult = {
  adoptId: string;
  created: number;
  ready: number;
  skipped: number;
  failed: number;
};

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = String(readFileSync(filePath, "utf-8") || "").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFileAtomicSync(filePath, value);
}

function registryPath(): string {
  return path.join(APP_ROOT, "data", "skill-registry.json");
}

function openclawRoot(): string {
  return path.basename(OPENCLAW_HOME) === ".openclaw" ? OPENCLAW_HOME : path.join(OPENCLAW_HOME, ".openclaw");
}

function readBuiltinAllowlist(): Set<string> {
  const raw = readJson<unknown>(path.join(APP_ROOT, "data", "skill-builtin-allowlist.json"), []);
  return new Set((Array.isArray(raw) ? raw : []).map((x) => String(x || "").trim()).filter(Boolean));
}

function readSkillMarkdown(skillPath: string): string {
  for (const fileName of ["SKILL.md", "README.md", "skill.md"]) {
    const p = path.join(skillPath, fileName);
    if (existsSync(p)) return String(readFileSync(p, "utf-8") || "");
  }
  return "";
}

function firstMeaningfulLine(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^#+\s*/, "").trim();
    if (!line || line === "---" || line.startsWith("name:") || line.startsWith("description:")) continue;
    return line.slice(0, 160);
  }
  return "";
}

function parseSkillMetadata(skillPath: string, skillId: string): { displayName: string; description: string } {
  const text = readSkillMarkdown(skillPath);
  const nameMatch = text.match(/(?:^|\n)\s*name\s*:\s*['"]?([^'"\n]+)['"]?/i);
  const descriptionMatch = text.match(/(?:^|\n)\s*description\s*:\s*['"]?([^'"\n]+)['"]?/i);
  const headingMatch = text.match(/(?:^|\n)#\s+(.+)/);
  return {
    displayName: (nameMatch?.[1] || headingMatch?.[1] || skillId).trim(),
    description: (descriptionMatch?.[1] || firstMeaningfulLine(text)).trim(),
  };
}

function safeStat(filePath: string): { mtimeMs?: number; size?: number } {
  try {
    if (!existsSync(filePath)) return {};
    const st = statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return {};
  }
}

function runtimeSkillsDir(runtimeAgentId: string): string | null {
  const candidates = [
    path.join(openclawRoot(), "workspace-" + runtimeAgentId, "skills"),
    path.join(openclawRoot(), "workspace-lingganclaw", runtimeAgentId, "skills"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export async function onboardBuiltinSkillsForAdopt(adoptId: string, agentId?: string): Promise<OnboardResult> {
  const allowlist = readBuiltinAllowlist();
  const runtimeAgentId = resolveRuntimeAgentId(adoptId, agentId || `trial_${adoptId}`);
  const skillsDir = runtimeSkillsDir(runtimeAgentId);
  const now = new Date().toISOString();
  let created: Skill[] = [];
  let skipped = 0;

  if (!skillsDir) {
    return { adoptId, created: 0, ready: 0, skipped: 0, failed: 0 };
  }

  const targetRegistryPath = registryPath();
  await withSerializedFileMutation(targetRegistryPath, () => {
    const registry = readJson<Skill[]>(targetRegistryPath, []);
    const existing = new Set(registry.map((skill) => `${skill.adoptId}:${skill.id}`));
    const discovered: Skill[] = [];
    let skippedWithinLock = 0;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillId = entry.name;
      if (!allowlist.has(skillId) || existing.has(`${adoptId}:${skillId}`)) {
        skippedWithinLock++;
        continue;
      }
      const sourcePath = path.join(skillsDir, skillId);
      const { displayName, description } = parseSkillMetadata(sourcePath, skillId);
      const stats = safeStat(sourcePath);
      const source: SkillSource = { kind: "builtin", skillId, displayName, description, sourcePath };
      discovered.push({
        id: skillId,
        adoptId,
        source,
        state: "ready",
        enabled: true,
        review: { state: "none" },
        sync: {
          runtimePath: sourcePath,
          sourceMtimeMs: stats.mtimeMs,
          sourceSizeBytes: stats.size,
          runtimeMtimeMs: stats.mtimeMs,
          runtimeSizeBytes: stats.size,
          lastSyncedAt: now,
          reason: "new adopt builtin allowlist onboarding",
        },
        capabilities: [],
        examples: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    created = discovered;
    skipped = skippedWithinLock;
    if (discovered.length > 0) writeJson(targetRegistryPath, [...registry, ...discovered]);
  });

  const reconcile = await skillRegistry.reconcile(adoptId);
  const failed = reconcile.ok ? reconcile.value.failed : created.length;
  const ready = reconcile.ok ? reconcile.value.scanned - reconcile.value.failed : 0;
  console.log("[SKILL-ONBOARD]", { adoptId, runtimeAgentId, created: created.length, ready, skipped, failed });
  return { adoptId, created: created.length, ready, skipped, failed };
}
