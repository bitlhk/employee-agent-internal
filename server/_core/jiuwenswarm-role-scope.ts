import { createHash } from "crypto";
import path from "path";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { AgentRoleTemplate } from "./role-templates";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import { projectEffectiveAssetsToMcpSelection } from "./agent-mcp-selection";
import { normalizeSkillRuntimePermissions } from "./skills/skill-runtime-permissions";

export const JIUWENSWARM_ROLE_SCOPE_MANIFEST = ".linggan-role-scope.json";
export const JIUWENSWARM_MANAGED_SKILLS_MANIFEST = ".linggan-managed-skills.json";
export const JIUWENSWARM_PLATFORM_MCP_SERVER_IDS = ["platform_tools", "custom_mcp_gateway"];

export type JiuwenSwarmRoleScopeManifest = {
  version: 1;
  runtime: "jiuwenswarm";
  role: {
    id: string;
    name: string;
    industry: string;
    status: string;
  };
  effectiveAssets: EffectiveRoleAssets;
  enforcement: {
    skills: "per-agent-workspace";
    mcp: "service-side-agent-context";
  };
};

export type JiuwenSwarmRoleScopeWriteResult = {
  manifestPath: string;
  changed: boolean;
  identityChanged: boolean;
  userChanged: boolean;
  linkedSharedSkills: string[];
  removedSharedSkills: string[];
};

type JiuwenSwarmManagedSkillsManifest = {
  version: 1;
  skills: Record<string, { digest: string }>;
};

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function readManagedSkillsManifest(workspaceDir: string): JiuwenSwarmManagedSkillsManifest {
  const manifestPath = path.join(workspaceDir, JIUWENSWARM_MANAGED_SKILLS_MANIFEST);
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    const skills = parsed?.skills && typeof parsed.skills === "object" ? parsed.skills : {};
    return { version: 1, skills };
  } catch {
    return { version: 1, skills: {} };
  }
}

function skillDirectoryDigest(rootDir: string): string {
  const rootStats = lstatSync(rootDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`托管技能源必须是实体目录: ${rootDir}`);
  }
  const hash = createHash("sha256");
  const walk = (dir: string, relativeDir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`托管技能不允许包含符号链接: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`F\0${relativePath}\0`);
      hash.update(readFileSync(absolutePath));
      hash.update("\0");
    }
  };
  walk(rootDir, "");
  return hash.digest("hex");
}

function materializeManagedSkill(sourcePath: string, targetPath: string, sourceDigest: string): boolean {
  let targetIsSymlink = false;
  let targetDigest = "";
  try {
    const stats = lstatSync(targetPath);
    targetIsSymlink = stats.isSymbolicLink();
    if (stats.isDirectory() && !targetIsSymlink) targetDigest = skillDirectoryDigest(targetPath);
  } catch {}
  if (!targetIsSymlink && targetDigest === sourceDigest) {
    normalizeSkillRuntimePermissions(targetPath);
    return false;
  }

  const temporaryPath = `${targetPath}.linggan-sync-${process.pid}-${Date.now()}`;
  rmSync(temporaryPath, { recursive: true, force: true });
  cpSync(sourcePath, temporaryPath, { recursive: true, force: false, errorOnExist: true });
  rmSync(targetPath, { recursive: true, force: true });
  renameSync(temporaryPath, targetPath);
  normalizeSkillRuntimePermissions(targetPath);
  return true;
}

function defaultRoleSkillIds(effectiveAssets: EffectiveRoleAssets): string[] {
  return uniqueSorted(effectiveAssets.skills.default);
}

function activeRoleSkillIds(
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

function withJiuwenSwarmPlatformMcp(effectiveAssets: EffectiveRoleAssets): EffectiveRoleAssets {
  return {
    ...effectiveAssets,
    mcpServers: {
      ...effectiveAssets.mcpServers,
      default: uniqueSorted([
        ...effectiveAssets.mcpServers.default,
        ...JIUWENSWARM_PLATFORM_MCP_SERVER_IDS,
      ]),
    },
  };
}

export function buildJiuwenSwarmRoleScopeManifest(
  role: AgentRoleTemplate,
  effectiveAssets: EffectiveRoleAssets,
  activeMcpServerIds?: string[],
): JiuwenSwarmRoleScopeManifest {
  const selectedAssets = activeMcpServerIds === undefined
    ? effectiveAssets
    : projectEffectiveAssetsToMcpSelection(effectiveAssets, activeMcpServerIds);
  const scopedAssets = withJiuwenSwarmPlatformMcp(selectedAssets);
  return {
    version: 1,
    runtime: "jiuwenswarm",
    role: {
      id: role.id,
      name: role.name,
      industry: role.industry,
      status: role.status,
    },
    effectiveAssets: scopedAssets,
    enforcement: {
      skills: "per-agent-workspace",
      mcp: "service-side-agent-context",
    },
  };
}

export function writeJiuwenSwarmRoleScopeManifest(args: {
  workspaceDir: string;
  role: AgentRoleTemplate;
  effectiveAssets: EffectiveRoleAssets;
  sharedSkillsDir?: string | null;
  skillSourceDirs?: string[];
  activeSkillIds?: string[];
  disabledDefaultSkillIds?: string[];
  activeMcpServerIds?: string[];
}): JiuwenSwarmRoleScopeWriteResult {
  const workspaceDir = path.resolve(args.workspaceDir);
  const manifestPath = path.join(workspaceDir, JIUWENSWARM_ROLE_SCOPE_MANIFEST);
  const current = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  const activeMcpServerIds = args.activeMcpServerIds === undefined
    ? readPreservedMcpSelection(current, args.effectiveAssets)
    : args.activeMcpServerIds;
  const manifest = buildJiuwenSwarmRoleScopeManifest(args.role, args.effectiveAssets, activeMcpServerIds);
  const next = `${JSON.stringify(manifest, null, 2)}\n`;

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });
  const identityChanged = writeJiuwenSwarmIdentityFilesIfMissing(workspaceDir, args.role, args.effectiveAssets).identityChanged;
  const userChanged = writeJiuwenSwarmUserFileIfMissing(workspaceDir, args.role).userChanged;

  const skillSourceDirs = uniqueSorted([
    ...(args.skillSourceDirs || []),
    ...(args.sharedSkillsDir ? [args.sharedSkillsDir] : []),
  ]);

  const linkResult = skillSourceDirs.length > 0
    ? reconcileJiuwenSwarmSharedSkillLinks({
      workspaceDir,
      sharedSkillsDirs: skillSourceDirs,
      allowedSkillIds: activeRoleSkillIds(
        args.effectiveAssets,
        args.activeSkillIds || [],
        args.disabledDefaultSkillIds || [],
      ),
    })
    : { linkedSharedSkills: [], removedSharedSkills: [] };

  if (current === next) return { manifestPath, changed: false, identityChanged, userChanged, ...linkResult };

  writeTextFileAtomic(manifestPath, next);
  return { manifestPath, changed: true, identityChanged, userChanged, ...linkResult };
}

function readPreservedMcpSelection(
  current: string,
  effectiveAssets: EffectiveRoleAssets,
): string[] | undefined {
  if (!current.trim()) return undefined;
  try {
    const parsed = JSON.parse(current);
    if (parsed?.version !== 1 || parsed?.runtime !== "jiuwenswarm") return undefined;
    const currentMcp = parsed?.effectiveAssets?.mcpServers;
    if (!currentMcp || !Array.isArray(currentMcp.default) || !Array.isArray(currentMcp.optional)) {
      return undefined;
    }
    const authorized = new Set([
      ...effectiveAssets.mcpServers.default,
      ...effectiveAssets.mcpServers.optional,
    ]);
    return uniqueSorted([...currentMcp.default, ...currentMcp.optional])
      .filter((serverId) => authorized.has(serverId));
  } catch {
    return undefined;
  }
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function roleGuidance(role: AgentRoleTemplate): string {
  switch (role.id) {
    case "wealth-manager":
      return "重点支持客户经营、资产配置、产品匹配、客户沟通和财富管理材料整理。涉及投资建议时保持审慎，避免承诺收益。";
    case "business-review":
    case "post-loan-risk-control":
      return [
        "重点支持风险识别、持续监控、异常线索归因、评估报告和处置建议。输出应区分事实、判断和待核验信息。",
        "工具选择规则：轻量数据查询、字段核验、单项指标解释，优先使用本地已安装的岗位技能和已授权 MCP。",
        "完整评估、批量处理、生成正式报告、预计耗时较长或用户明确要求调用外部 Agent 时，优先使用平台工具提交远程 Agent 异步任务。",
        "如果外部 Agent 不可用，可基于本地技能/MCP 给出初步评估，并明确说明这是本地轻量版本。",
      ].join(" ");
    case "credential-compliance":
      return "重点支持材料审核、凭证识别、合规检查、审核意见生成和异常点提示。输出应明确依据、缺口和下一步补充材料。";
    case "insurance-advisor":
      return "重点支持保险需求分析、产品解释、销售陪练、话术推荐和异议处理。严格遵守合规边界，不承诺收益，不替代人工核保或理赔结论。";
    case "investment-researcher":
      return "重点支持投研分析、行情解读、基金/股票/债券资料整理、组合对比和投资备忘。输出应标注数据口径和不确定性。";
    default:
      return "重点支持通用办公、资料整理、信息检索、文本生成和任务协作。遇到专业金融、合规或投资判断时应提示限制并建议人工复核。";
  }
}

function formatAssetLine(label: string, values: string[]): string {
  return `- ${label}: ${values.length ? values.join(", ") : "无"}`;
}

export function buildJiuwenSwarmIdentityMarkdown(
  role: AgentRoleTemplate,
  effectiveAssets: EffectiveRoleAssets,
): string {
  return [
    "# 身份",
    "",
    `你是企业岗位智能体，当前岗位为「${role.name}」。`,
    "",
    "## 工作方式",
    "",
    `- ${roleGuidance(role)}`,
    "- 优先使用当前工作目录已安装的岗位技能和已授权 MCP；如果能力不可用，应明确说明不可用，不要编造结果。",
    "- 回答默认使用中文，面向业务用户，避免暴露底层 runtime、文件路径、调试日志等实现细节。",
    "- 对金融、保险、证券、风控、审核相关内容保持合规审慎；区分事实、推断和建议。",
    "",
    "## 当前岗位资产",
    "",
    formatAssetLine("默认技能", effectiveAssets.skills.default),
    formatAssetLine("默认 MCP", effectiveAssets.mcpServers.default),
    "",
  ].join("\n");
}

export function buildJiuwenSwarmUserMarkdown(role: AgentRoleTemplate): string {
  return [
    "# 用户偏好",
    "",
    `用户申请该智能体时选择的岗位是「${role.name}」。`,
    "用户希望智能体围绕岗位职责提供直接、可执行的业务协助；在信息不足时，先简短追问关键缺口。",
    "如用户提出与岗位无关的问题，可正常协助通用任务，但不要主动越权调用未授权工具或输出高风险结论。",
    "",
  ].join("\n");
}

export function writeJiuwenSwarmIdentityFilesIfMissing(
  workspaceDir: string,
  role: AgentRoleTemplate,
  effectiveAssets: EffectiveRoleAssets,
): { identityPath: string; identityChanged: boolean } {
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  if (existsSync(identityPath)) return { identityPath, identityChanged: false };
  writeFileSync(identityPath, buildJiuwenSwarmIdentityMarkdown(role, effectiveAssets), "utf8");
  return { identityPath, identityChanged: true };
}

export function writeJiuwenSwarmUserFileIfMissing(
  workspaceDir: string,
  role: AgentRoleTemplate,
): { userPath: string; userChanged: boolean } {
  const userPath = path.join(workspaceDir, "USER.md");
  if (existsSync(userPath)) return { userPath, userChanged: false };
  writeFileSync(userPath, buildJiuwenSwarmUserMarkdown(role), "utf8");
  return { userPath, userChanged: true };
}

export function reconcileJiuwenSwarmSharedSkillLinks(params: {
  workspaceDir: string;
  sharedSkillsDir?: string;
  sharedSkillsDirs?: string[];
  allowedSkillIds: string[];
}): { linkedSharedSkills: string[]; removedSharedSkills: string[] } {
  const allowed = new Set(uniqueSorted(params.allowedSkillIds));
  const linkedSharedSkills: string[] = [];
  const removedSharedSkills: string[] = [];
  const workspaceSkillsDir = path.join(params.workspaceDir, "skills");
  const managedManifestPath = path.join(params.workspaceDir, JIUWENSWARM_MANAGED_SKILLS_MANIFEST);
  const previousManaged = readManagedSkillsManifest(params.workspaceDir);
  const nextManaged: JiuwenSwarmManagedSkillsManifest = { version: 1, skills: {} };
  const sharedSkillsDirs = uniqueSorted([
    ...(params.sharedSkillsDirs || []),
    ...(params.sharedSkillsDir ? [params.sharedSkillsDir] : []),
  ]).filter((dir) => existsSync(dir));
  if (sharedSkillsDirs.length === 0) return { linkedSharedSkills, removedSharedSkills };
  mkdirSync(workspaceSkillsDir, { recursive: true });
  const sharedRoots = sharedSkillsDirs.map((dir) => path.resolve(dir));

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
    const isManagedLink = sharedRoots.some((sharedRoot) =>
      resolvedTarget.startsWith(sharedRoot + path.sep) || resolvedTarget === sharedRoot
    );
    if (!isManagedLink) continue;
    if (!allowed.has(skillId)) {
      unlinkSync(skillPath);
      removedSharedSkills.push(skillId);
    }
  }

  for (const skillId of Object.keys(previousManaged.skills)) {
    if (allowed.has(skillId)) continue;
    const managedPath = path.join(workspaceSkillsDir, skillId);
    rmSync(managedPath, { recursive: true, force: true });
    removedSharedSkills.push(skillId);
  }

  for (const skillId of allowed) {
    const sharedRoot = sharedSkillsDirs.find((dir) => existsSync(path.join(dir, skillId)));
    if (!sharedRoot) continue;
    const sharedPath = path.join(sharedRoot, skillId);
    const linkPath = path.join(workspaceSkillsDir, skillId);
    if (!existsSync(sharedPath)) continue;
    const digest = skillDirectoryDigest(sharedPath);
    const materialized = materializeManagedSkill(sharedPath, linkPath, digest);
    nextManaged.skills[skillId] = { digest };
    if (materialized || previousManaged.skills[skillId]?.digest !== digest) linkedSharedSkills.push(skillId);
  }

  const nextManagedText = `${JSON.stringify(nextManaged, null, 2)}\n`;
  const previousManagedText = existsSync(managedManifestPath) ? readFileSync(managedManifestPath, "utf8") : "";
  if (previousManagedText !== nextManagedText) writeFileSync(managedManifestPath, nextManagedText, "utf8");

  return {
    linkedSharedSkills: uniqueSorted(linkedSharedSkills),
    removedSharedSkills: uniqueSorted(removedSharedSkills),
  };
}
