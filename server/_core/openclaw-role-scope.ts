import path from "path";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import type { EffectiveRoleAssets } from "./role-asset-grants";

export type OpenClawRoleScopeResult = {
  agentFound: boolean;
  skillAllowlistChanged: boolean;
  mcpProjectionChanged: boolean;
  linkedSharedSkills: string[];
  removedSharedSkills: string[];
};

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function ensureObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function defaultRoleSkillIds(effectiveAssets: EffectiveRoleAssets): string[] {
  return uniqueSorted(effectiveAssets.skills.default);
}

export function activeRoleSkillIds(
  effectiveAssets: EffectiveRoleAssets,
  activeSkillIds: string[] = [],
  disabledDefaultSkillIds: string[] = [],
): string[] {
  const disabled = new Set(uniqueSorted(disabledDefaultSkillIds));
  return uniqueSorted([
    ...effectiveAssets.skills.default.filter((skillId) => !disabled.has(skillId)),
    ...activeSkillIds,
  ]);
}

export function defaultRoleMcpServerIds(effectiveAssets: EffectiveRoleAssets): string[] {
  return uniqueSorted(effectiveAssets.mcpServers.default);
}

export function applyOpenClawRoleScopeToConfig(
  config: Record<string, any>,
  agentId: string,
  effectiveAssets: EffectiveRoleAssets,
  activeSkillIds: string[] = [],
  disabledDefaultSkillIds: string[] = [],
): Pick<OpenClawRoleScopeResult, "agentFound" | "skillAllowlistChanged" | "mcpProjectionChanged"> {
  const desiredSkills = activeRoleSkillIds(effectiveAssets, activeSkillIds, disabledDefaultSkillIds);
  const desiredMcpServers = new Set(defaultRoleMcpServerIds(effectiveAssets));

  const agents = ensureObject(config.agents);
  const list = Array.isArray(agents.list) ? agents.list : [];
  let agentFound = false;
  let skillAllowlistChanged = false;
  for (const agent of list) {
    if (!agent || typeof agent !== "object" || agent.id !== agentId) continue;
    agentFound = true;
    const current = Array.isArray(agent.skills) ? uniqueSorted(agent.skills) : [];
    if (!arraysEqual(current, desiredSkills)) {
      agent.skills = desiredSkills;
      skillAllowlistChanged = true;
    }
    break;
  }

  const mcp = ensureObject(config.mcp);
  const servers = ensureObject(mcp.servers);
  let mcpProjectionChanged = false;
  for (const [serverId, serverConfigValue] of Object.entries(servers)) {
    const serverConfig = ensureObject(serverConfigValue);
    if (servers[serverId] !== serverConfig) servers[serverId] = serverConfig;
    const codex = ensureObject(serverConfig.codex);
    if (serverConfig.codex !== codex) serverConfig.codex = codex;
    const currentAgents = Array.isArray(codex.agents) ? uniqueSorted(codex.agents) : [];
    const hasAgent = currentAgents.includes(agentId);
    const shouldHaveAgent = desiredMcpServers.has(serverId);
    let nextAgents = currentAgents;
    if (shouldHaveAgent && !hasAgent) nextAgents = uniqueSorted([...currentAgents, agentId]);
    if (!shouldHaveAgent && hasAgent) nextAgents = currentAgents.filter((id) => id !== agentId);
    if (!arraysEqual(currentAgents, nextAgents)) {
      codex.agents = nextAgents;
      mcpProjectionChanged = true;
    }
  }

  return { agentFound, skillAllowlistChanged, mcpProjectionChanged };
}

export function findOpenClawAgentWorkspace(config: Record<string, any>, agentId: string): string | null {
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agent = list.find((item: any) => item && typeof item === "object" && item.id === agentId);
  const workspace = String(agent?.workspace || "").trim();
  return workspace || null;
}

export function reconcileSharedSkillLinks(params: {
  workspaceDir: string;
  sharedSkillsDir?: string;
  skillSourceDirs?: string[];
  allowedSkillIds: string[];
}): Pick<OpenClawRoleScopeResult, "linkedSharedSkills" | "removedSharedSkills"> {
  const allowed = new Set(uniqueSorted(params.allowedSkillIds));
  const sourceDirs = uniqueSorted([
    ...(params.skillSourceDirs || []),
    ...(params.sharedSkillsDir ? [params.sharedSkillsDir] : []),
  ]);
  const linkedSharedSkills: string[] = [];
  const removedSharedSkills: string[] = [];
  const workspaceSkillsDir = path.join(params.workspaceDir, "skills");
  const existingSourceDirs = sourceDirs.filter((dir) => existsSync(dir));
  if (existingSourceDirs.length === 0) return { linkedSharedSkills, removedSharedSkills };
  mkdirSync(workspaceSkillsDir, { recursive: true });

  for (const entry of readdirSync(workspaceSkillsDir, { withFileTypes: true })) {
    const skillId = entry.name;
    const skillPath = path.join(workspaceSkillsDir, skillId);
    if (!entry.isSymbolicLink()) continue;
    let target = "";
    try {
      target = lstatSync(skillPath).isSymbolicLink() ? readlinkSync(skillPath) : "";
    } catch {
      continue;
    }
    const resolvedTarget = path.resolve(path.dirname(skillPath), target);
    const managed = existingSourceDirs.some((sourceDir) => {
      const sourceRoot = path.resolve(sourceDir);
      return resolvedTarget.startsWith(sourceRoot + path.sep) || resolvedTarget === sourceRoot;
    });
    if (!managed) continue;
    if (!allowed.has(skillId)) {
      unlinkSync(skillPath);
      removedSharedSkills.push(skillId);
    }
  }

  for (const skillId of allowed) {
    const sharedPath = existingSourceDirs
      .map((sourceDir) => path.join(sourceDir, skillId))
      .find((candidate) => existsSync(candidate));
    if (!sharedPath) continue;
    const linkPath = path.join(workspaceSkillsDir, skillId);
    if (existsSync(linkPath)) continue;
    symlinkSync(sharedPath, linkPath, "dir");
    linkedSharedSkills.push(skillId);
  }

  return {
    linkedSharedSkills: linkedSharedSkills.sort(),
    removedSharedSkills: removedSharedSkills.sort(),
  };
}

export function applyOpenClawRoleScope(params: {
  configPath: string;
  agentId: string;
  effectiveAssets: EffectiveRoleAssets;
  workspaceDir?: string | null;
  sharedSkillsDir?: string | null;
  skillSourceDirs?: string[] | null;
  activeSkillIds?: string[] | null;
  disabledDefaultSkillIds?: string[] | null;
}): OpenClawRoleScopeResult {
  const config = existsSync(params.configPath)
    ? JSON.parse(String(readFileSync(params.configPath, "utf8") || "{}"))
    : {};
  const activeSkillIds = activeRoleSkillIds(
    params.effectiveAssets,
    params.activeSkillIds || [],
    params.disabledDefaultSkillIds || [],
  );
  const configResult = applyOpenClawRoleScopeToConfig(
    config,
    params.agentId,
    params.effectiveAssets,
    params.activeSkillIds || [],
    params.disabledDefaultSkillIds || [],
  );
  const workspaceDir = findOpenClawAgentWorkspace(config, params.agentId) || params.workspaceDir;
  if (configResult.agentFound && (configResult.skillAllowlistChanged || configResult.mcpProjectionChanged)) {
    writeFileSync(params.configPath, JSON.stringify(config, null, 2), "utf8");
  }
  const hasSkillSources = Boolean(params.sharedSkillsDir) || Boolean(params.skillSourceDirs?.length);
  const linkResult = workspaceDir && hasSkillSources
    ? reconcileSharedSkillLinks({
      workspaceDir,
      sharedSkillsDir: params.sharedSkillsDir || undefined,
      skillSourceDirs: params.skillSourceDirs || undefined,
      allowedSkillIds: activeSkillIds,
    })
    : { linkedSharedSkills: [], removedSharedSkills: [] };
  return { ...configResult, ...linkResult };
}
