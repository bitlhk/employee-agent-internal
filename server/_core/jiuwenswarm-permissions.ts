import path from "path";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { JIUWENCLAW_HOME } from "./helpers";

const DEFAULT_JIUWENBOX_RUNTIME_GROUP = "jiuwenswarm";

export type JiuwenSwarmWorkspacePermissionResult = {
  configPath: string;
  workspaceDir: string;
  changed: boolean;
  filesystemChanged: boolean;
};

function resolveRuntimeGid(): number | null {
  const configured = String(
    process.env.JIUWENBOX_RUNTIME_GROUP || DEFAULT_JIUWENBOX_RUNTIME_GROUP,
  ).trim();
  if (!configured) return null;
  if (/^\d+$/.test(configured)) return Number(configured);

  try {
    for (const line of readFileSync("/etc/group", "utf8").split(/\r?\n/)) {
      const fields = line.split(":");
      if (fields[0] === configured && /^\d+$/.test(fields[2] || "")) {
        return Number(fields[2]);
      }
    }
  } catch {}
  return null;
}

function runtimeReadableMode(mode: number, directory: boolean): number {
  if (directory) return 0o750;
  const owner = mode & 0o700;
  const groupReadExecute = (owner & 0o500) >> 3;
  return owner | groupReadExecute;
}

function normalizeRuntimePath(target: string, runtimeGid: number): boolean {
  if (!existsSync(target)) return false;
  const stats = lstatSync(target);
  if (stats.isSymbolicLink()) return false;
  let changed = false;
  if (stats.gid !== runtimeGid) {
    chownSync(target, stats.uid, runtimeGid);
    changed = true;
  }
  const currentMode = stats.mode & 0o777;
  const nextMode = runtimeReadableMode(currentMode, stats.isDirectory());
  if (currentMode !== nextMode) {
    chmodSync(target, nextMode);
    changed = true;
  }
  return changed;
}

function workspaceRuntimeAncestors(workspaceDir: string): string[] {
  const result = [workspaceDir];
  let current = path.dirname(workspaceDir);
  while (current !== path.dirname(current)) {
    result.push(current);
    if (path.basename(current).startsWith("agent_jiuwen_")) return result.reverse();
    current = path.dirname(current);
  }
  return [workspaceDir];
}

/** Make a JiuwenBox workspace traversable without granting world access. */
export function normalizeJiuwenSwarmWorkspaceRuntimePermissions(
  workspaceDirRaw: string,
  options: { runtimeGid?: number | null } = {},
): boolean {
  const workspaceDir = path.resolve(workspaceDirRaw);
  const runtimeGid = options.runtimeGid === undefined ? resolveRuntimeGid() : options.runtimeGid;
  if (runtimeGid === null || !existsSync(workspaceDir)) return false;

  let changed = false;
  for (const target of workspaceRuntimeAncestors(workspaceDir)) {
    changed = normalizeRuntimePath(target, runtimeGid) || changed;
  }
  for (const entry of readdirSync(workspaceDir)) {
    changed = normalizeRuntimePath(path.join(workspaceDir, entry), runtimeGid) || changed;
  }
  return changed;
}

function jiuwenSwarmConfigPath(): string {
  return path.resolve(
    process.env.JIUWENSWARM_CONFIG_PATH
      || process.env.JIUWENCLAW_CONFIG_PATH
      || path.join(JIUWENCLAW_HOME, "config", "config.yaml"),
  );
}

function normalizeYamlPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

function quoteYamlKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

function parseExternalDirectoryEntries(block: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s{4}(.+?):\s*([A-Za-z_][\w-]*)\s*$/);
    if (!match) continue;
    const rawKey = match[1].trim();
    const key = rawKey.startsWith("'") && rawKey.endsWith("'")
      ? rawKey.slice(1, -1).replace(/''/g, "'")
      : rawKey;
    entries.set(key, match[2].trim());
  }
  return entries;
}

function renderExternalDirectoryBlock(entries: Map<string, string>): string {
  const paths = Array.from(entries.keys())
    .filter((key) => key !== "*")
    .sort();
  const lines = [
    "  external_directory:",
    "    '*': deny",
    ...paths.map((key) => `    ${quoteYamlKey(key)}: ${entries.get(key) || "allow"}`),
  ];
  return lines.join("\n");
}

function permissionsBlockRange(text: string): { start: number; end: number } | null {
  const match = /^permissions:\n/m.exec(text);
  if (!match) return null;
  const start = match.index;
  const restStart = start + match[0].length;
  const nextTop = text.slice(restStart).search(/^[A-Za-z_][\w-]*:\n/m);
  const end = nextTop >= 0 ? restStart + nextTop : text.length;
  return { start, end };
}

function externalDirectoryRange(permissionsBlock: string): { start: number; end: number } | null {
  const match = /^  external_directory:\n/m.exec(permissionsBlock);
  if (!match) return null;
  const start = match.index;
  const restStart = start + match[0].length;
  const nextSibling = permissionsBlock.slice(restStart).search(/^  [A-Za-z_][\w-]*:/m);
  const end = nextSibling >= 0 ? restStart + nextSibling : permissionsBlock.length;
  return { start, end };
}

export function ensureJiuwenSwarmWorkspacePermission(workspaceDirRaw: string): JiuwenSwarmWorkspacePermissionResult {
  const configPath = jiuwenSwarmConfigPath();
  const workspaceDir = normalizeYamlPath(workspaceDirRaw);
  const filesystemChanged = normalizeJiuwenSwarmWorkspaceRuntimePermissions(workspaceDir);
  if (!existsSync(configPath)) {
    return { configPath, workspaceDir, changed: filesystemChanged, filesystemChanged };
  }

  const current = readFileSync(configPath, "utf8");
  const permRange = permissionsBlockRange(current);
  if (!permRange) {
    const next = `${current.replace(/\s*$/, "\n")}permissions:\n  enabled: true\n  schema: tiered_policy\n${renderExternalDirectoryBlock(new Map([["*", "deny"], [workspaceDir, "allow"]]))}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, next, "utf8");
    return { configPath, workspaceDir, changed: true, filesystemChanged };
  }

  const beforePerm = current.slice(0, permRange.start);
  const permissionsBlock = current.slice(permRange.start, permRange.end);
  const afterPerm = current.slice(permRange.end);
  const extRange = externalDirectoryRange(permissionsBlock);
  const entries = extRange
    ? parseExternalDirectoryEntries(permissionsBlock.slice(extRange.start, extRange.end))
    : new Map<string, string>();
  entries.set("*", "deny");
  entries.set(workspaceDir, "allow");
  const nextExternal = `${renderExternalDirectoryBlock(entries)}\n`;
  const nextPermissionsBlock = extRange
    ? `${permissionsBlock.slice(0, extRange.start)}${nextExternal}${permissionsBlock.slice(extRange.end).replace(/^\n+/, "")}`
    : `${permissionsBlock.replace(/\s*$/, "\n")}${nextExternal}`;
  const next = `${beforePerm}${nextPermissionsBlock}${afterPerm}`;
  if (next === current) {
    return { configPath, workspaceDir, changed: filesystemChanged, filesystemChanged };
  }
  writeFileSync(configPath, next, "utf8");
  return { configPath, workspaceDir, changed: true, filesystemChanged };
}
