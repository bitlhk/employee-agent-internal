import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SKILL_VALUE_EVALUATION_TOOL_SCOPE_FILE = ".linggan-skill-evaluation-tools.json";

type EvaluationToolScope = {
  version: 1;
  mcpTools: Record<string, string[]>;
};

function normalize(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map(value => String(value || "").trim())
    .filter(value => /^[A-Za-z0-9._-]{1,128}$/u.test(value))))
    .sort();
}

export function writeSkillValueEvaluationToolScope(input: {
  workspaceDir: string;
  mcpServers: Array<{ serverId: string; requiredTools: string[] }>;
}): string {
  const workspaceDir = path.resolve(input.workspaceDir);
  const filePath = path.join(workspaceDir, SKILL_VALUE_EVALUATION_TOOL_SCOPE_FILE);
  const mcpTools = Object.fromEntries(input.mcpServers
    .map(server => [String(server.serverId || "").trim(), normalize(server.requiredTools)] as const)
    .filter(([serverId]) => /^[A-Za-z0-9._-]{1,128}$/u.test(serverId))
    .sort(([left], [right]) => left.localeCompare(right)));
  const scope: EvaluationToolScope = { version: 1, mcpTools };
  const content = `${JSON.stringify(scope, null, 2)}\n`;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(workspaceDir, { recursive: true });
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return filePath;
}

export function readSkillValueEvaluationAllowedTools(
  workspaceDir: string,
  serverId: string,
): Set<string> | null {
  const filePath = path.join(path.resolve(workspaceDir), SKILL_VALUE_EVALUATION_TOOL_SCOPE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<EvaluationToolScope>;
    if (parsed.version !== 1 || !parsed.mcpTools || typeof parsed.mcpTools !== "object") return null;
    if (!Object.prototype.hasOwnProperty.call(parsed.mcpTools, serverId)) return null;
    return new Set(normalize(parsed.mcpTools[serverId]));
  } catch {
    return null;
  }
}
