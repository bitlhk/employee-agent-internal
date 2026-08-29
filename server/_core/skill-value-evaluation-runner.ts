import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  evaluate,
  type ApiProvider,
  type CallApiContextParams,
  type ProviderResponse,
} from "promptfoo";
import { z } from "zod";
import {
  createClawAdoption,
  createUser,
  deleteAgentMcpPreference,
  getClawByAdoptId,
  getUserByEmail,
  resolveEffectiveRoleAssets,
  setAgentMcpPreference,
} from "../db";
import { governanceFingerprint } from "./governance/contracts";
import { callEaAssistantModelWithConfig } from "./ea-assistant-model";
import { resolveRuntimeWorkspaceByIds } from "./helpers";
import {
  nativeLoadedSkills,
  parseRuntimeSse,
  streamGate,
} from "./skill-quality-evaluation-runtime";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";
import { roleSkillPreferences } from "./skills/role-skill-preferences";
import { skillInstaller } from "./skills/skill-installer";
import { skillRegistry } from "./skills/skill-registry";
import { resolveSkillValueModelConfig } from "./skill-value-evaluation";
import {
  JIUWENSWARM_PLATFORM_MCP_SERVER_IDS,
  writeJiuwenSwarmRoleScopeManifest,
} from "./jiuwenswarm-role-scope";
import { refreshJiuwenRuntimeCapabilities } from "./jiuwenswarm-runtime-refresh";
import {
  getSkillMcpRequirement,
  resolveAgentRoleTemplate,
  type SkillMcpRequirement,
} from "./role-templates";

type EvaluationSide = "left" | "right";

const RUNTIME_TURN_TIMEOUT_MS = 300_000;
const PROMPTFOO_TURN_TIMEOUT_MS = 310_000;
const EVALUATION_MCP_TRANSPORT_SERVER_IDS = [
  "enterprise_mcp_gateway",
  "role_mcp_gateway",
];

export type SkillValueEvaluationArtifact = {
  versionId: string;
  version: string;
  artifactSha256: string;
  artifactPath: string;
} | null;

export type SkillValueEvaluationRunPrompt = {
  promptId: string;
  name: string;
  prompt: string;
  evaluationGoal: string;
};

export type SkillValueEvaluationSideConfig = {
  modelId: string;
  artifact: SkillValueEvaluationArtifact;
};

export type SkillValueEvaluationTurnResult = {
  side: EvaluationSide;
  status: "completed" | "failed";
  modelId: string;
  skillVersion: string | null;
  assistantText: string;
  elapsedMs: number;
  toolCalls: Array<{ name: string; status: "completed" | "failed" }>;
  loadedSkills: Array<{ skillId: string; version: string }>;
  usage: Record<string, unknown> | null;
  runtimeIdentityVerified: boolean;
  streamCompleted: boolean;
  error: string | null;
};

export type SkillValueEvaluationCaseResult = {
  promptId: string;
  name: string;
  prompt: string;
  evaluationGoal: string;
  left: SkillValueEvaluationTurnResult | null;
  right: SkillValueEvaluationTurnResult | null;
  judge: SkillValueEvaluationJudgeResult | null;
  judgeError: string | null;
};

export type SkillValueEvaluationJudgeResult = {
  winner: "left" | "right" | "tie";
  confidence: "low" | "medium" | "high";
  summary: string;
  dimensions: Array<{
    id: "professional_fit" | "business_completeness" | "clarity" | "actionability";
    label: string;
    leftScore: number;
    rightScore: number;
    reason: string;
  }>;
  reviewerLabel: string;
};

export type SkillValueEvaluationEnvironment = {
  mode: "skill_declared";
  isolation: "target_skill_only";
  sameForBothSides: true;
  mcpServers: Array<{
    serverId: string;
    requiredTools: string[];
  }>;
  declaredToolCount: number;
};

export type SkillValueEvaluationJob = {
  jobId: string;
  skillId: string;
  skillName: string;
  roleTemplate: string;
  status: "preparing" | "running" | "judging" | "completed" | "failed";
  stageLabel: string;
  createdAt: string;
  updatedAt: string;
  completedRuns: number;
  totalRuns: number;
  left: {
    modelId: string;
    skillVersion: string | null;
    adoptionId: string;
  };
  right: {
    modelId: string;
    skillVersion: string | null;
    adoptionId: string;
  };
  cases: SkillValueEvaluationCaseResult[];
  promptfoo: {
    version: "0.122.2";
    completed: boolean;
  };
  judge: {
    modelId: string;
    completedCases: number;
  };
  environment: SkillValueEvaluationEnvironment;
  summary: {
    leftWins: number;
    rightWins: number;
    ties: number;
    headline: string;
  } | null;
  configurationFingerprint: string;
  error: string | null;
};

type StartJobInput = {
  skillId: string;
  skillName: string;
  roleTemplate: string;
  left: SkillValueEvaluationSideConfig;
  right: SkillValueEvaluationSideConfig;
  prompts: SkillValueEvaluationRunPrompt[];
};

export function summarizeSkillValueEvaluationCases(
  cases: SkillValueEvaluationCaseResult[],
): NonNullable<SkillValueEvaluationJob["summary"]> {
  const leftWins = cases.filter(item => item.judge?.winner === "left").length;
  const rightWins = cases.filter(item => item.judge?.winner === "right").length;
  const ties = cases.filter(item => item.judge?.winner === "tie").length;
  const unavailable = cases.length - leftWins - rightWins - ties;
  const headline = unavailable === cases.length
    ? "左右输出已完成，专业 Judge 暂未形成可用结论"
    : leftWins === rightWins
      ? `本轮对比持平：A、B 各胜 ${leftWins} 题${ties ? `，${ties} 题持平` : ""}`
      : rightWins > leftWins
        ? `B 在 ${rightWins}/${cases.length} 个任务中表现更优`
        : `A 在 ${leftWins}/${cases.length} 个任务中表现更优`;
  return { leftWins, rightWins, ties, headline };
}

const jobs = new Map<string, SkillValueEvaluationJob>();
const jobPromises = new Map<string, Promise<void>>();
const JOB_TTL_MS = 2 * 60 * 60 * 1_000;

function cloneJob(job: SkillValueEvaluationJob): SkillValueEvaluationJob {
  return structuredClone(job);
}

function cleanupJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [jobId, job] of jobs) {
    if (Date.parse(job.updatedAt) < cutoff) jobs.delete(jobId);
  }
}

function adoptionIds(skillId: string, roleTemplate: string): {
  left: string;
  right: string;
} {
  const digest = createHash("sha256")
    .update(`${skillId}:${roleTemplate}`, "utf8")
    .digest("hex")
    .slice(0, 10);
  return {
    left: `lgj-eval-ui-${digest}-a`,
    right: `lgj-eval-ui-${digest}-b`,
  };
}

async function ensureEvaluationUser() {
  const email = "skill-value-eval@local.linggan.invalid";
  let user = await getUserByEmail(email);
  if (!user) {
    await createUser({
      name: "Skill Value Evaluator",
      email,
      loginMethod: "internal_evaluation",
      role: "user",
      accessLevel: "all",
      organization: "EA Isolated Skill Evaluation",
    });
    user = await getUserByEmail(email);
  }
  if (!user) throw new Error("无法创建 Skill 评测用户");
  return user;
}

async function ensureEvaluationAdoption(input: {
  adoptionId: string;
  userId: number;
  roleTemplate: string;
}) {
  const agentId = `jiuwen_${input.adoptionId}`;
  let adoption = await getClawByAdoptId(input.adoptionId);
  if (!adoption) {
    await createClawAdoption({
      userId: input.userId,
      adoptId: input.adoptionId,
      agentId,
      status: "active",
      permissionProfile: "internal",
      roleTemplate: input.roleTemplate,
      industry: input.roleTemplate.includes("insurance") ? "insurance" : "financial",
      runtime: "jiuwenswarm",
      ttlDays: 3650,
      entryUrl: `/workspace?adoptId=${encodeURIComponent(input.adoptionId)}`,
      expiresAt: null,
    });
    adoption = await getClawByAdoptId(input.adoptionId);
  }
  if (
    !adoption
    || Number(adoption.userId) !== input.userId
    || String(adoption.agentId) !== agentId
    || String(adoption.roleTemplate) !== input.roleTemplate
    || adoption.status !== "active"
  ) {
    throw new Error(`隔离评测实例 ${input.adoptionId} 状态不兼容`);
  }
  return adoption;
}

async function materializeSide(input: {
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  skillId: string;
  skillName: string;
  artifact: SkillValueEvaluationArtifact;
}) {
  const effectiveAssets = await resolveEffectiveRoleAssets(input.roleTemplate);
  for (const defaultSkillId of effectiveAssets.skills.default) {
    roleSkillPreferences.setDefaultSkillEnabled(input.adoptionId, defaultSkillId, false);
  }
  const listed = await skillRegistry.listSkills(input.adoptionId);
  if (listed.ok) {
    for (const skill of listed.value) {
      if (input.artifact && skill.id === input.skillId) continue;
      await skillRegistry.uninstall(input.adoptionId, skill.id).catch(() => undefined);
    }
  }
  if (!input.artifact) {
    roleSkillPreferences.setDefaultSkillEnabled(input.adoptionId, input.skillId, false);
    await skillRegistry.uninstall(input.adoptionId, input.skillId).catch(() => undefined);
    await skillRegistry.refreshRuntimeProjection(input.adoptionId);
    const runtimePath = path.join(
      resolveRuntimeWorkspaceByIds(input.adoptionId, input.agentId),
      "skills",
      input.skillId,
    );
    if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });
    return;
  }
  const digest = digestSkillSourceTree(input.artifact.artifactPath);
  if (digest.sha256 !== input.artifact.artifactSha256) {
    throw new Error(`${input.skillId}@${input.artifact.version} Artifact 已变化`);
  }
  roleSkillPreferences.setDefaultSkillEnabled(input.adoptionId, input.skillId, true);
  const installResult = await skillRegistry.install(
    input.adoptionId,
    {
      kind: "marketplace",
      skillId: input.skillId,
      displayName: input.skillName,
      description: "Skill 价值评测隔离版本",
      sourcePath: input.artifact.artifactPath,
      marketplaceId: input.artifact.versionId,
      version: input.artifact.version,
    },
    {
      allowVersionDowngrade: true,
      preserveImmutableSourcePath: true,
    },
  );
  if (!installResult.ok) throw new Error(installResult.error.detail);
  const runtimePath = String(installResult.value.sync.runtimePath || "").trim();
  if (!runtimePath) throw new Error("Skill 评测 Runtime 路径为空");
  await skillRegistry.refreshRuntimeProjection(input.adoptionId);

  // Role projection refreshes shared defaults. Re-apply the frozen evaluation
  // artifact last so an existing shared version cannot replace the selected one.
  await skillInstaller.installFromSource(input.artifact.artifactPath, runtimePath);
  const runtimeDigest = digestSkillSourceTree(runtimePath);
  if (runtimeDigest.sha256 !== input.artifact.artifactSha256) {
    throw new Error(`${input.skillId}@${input.artifact.version} Runtime Artifact 装配失败`);
  }
  await refreshJiuwenRuntimeCapabilities(input.adoptionId);
}

export function buildSkillValueEvaluationEnvironment(
  skillId: string,
  requirement: SkillMcpRequirement = getSkillMcpRequirement(skillId),
): SkillValueEvaluationEnvironment {
  const mcpServers = Object.entries(requirement.servers)
    .map(([serverId, tools]) => ({
      serverId,
      requiredTools: Array.from(new Set(tools)).sort(),
    }))
    .sort((left, right) => left.serverId.localeCompare(right.serverId));
  return {
    mode: "skill_declared",
    isolation: "target_skill_only",
    sameForBothSides: true,
    mcpServers,
    declaredToolCount: mcpServers.reduce((sum, server) => sum + server.requiredTools.length, 0),
  };
}

export function buildSkillValueEvaluationRuntimeMcpServerIds(
  environment: SkillValueEvaluationEnvironment,
): string[] {
  const requiredServerIds = environment.mcpServers.map(server => server.serverId);
  return Array.from(new Set([
    ...requiredServerIds,
    ...(requiredServerIds.length > 0 ? EVALUATION_MCP_TRANSPORT_SERVER_IDS : []),
  ])).sort();
}

async function applyEvaluationEnvironment(input: {
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  environment: SkillValueEvaluationEnvironment;
  skillIds: string[];
}): Promise<void> {
  const role = resolveAgentRoleTemplate(input.roleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  const platformServers = new Set(JIUWENSWARM_PLATFORM_MCP_SERVER_IDS);
  const authorizedServers = new Set([
    ...effectiveAssets.mcpServers.default,
    ...effectiveAssets.mcpServers.optional,
    ...JIUWENSWARM_PLATFORM_MCP_SERVER_IDS,
  ]);
  const requiredServerIds = input.environment.mcpServers.map(server => server.serverId);
  const unauthorized = requiredServerIds.filter(serverId => !authorizedServers.has(serverId));
  if (unauthorized.length > 0) {
    throw new Error(`Skill 声明的 MCP 未获岗位授权：${unauthorized.join("、")}`);
  }
  const requiredServerIdSet = new Set(requiredServerIds);
  await Promise.all(Array.from(authorizedServers)
    .filter(serverId => !platformServers.has(serverId))
    .map(async (serverId) => {
      if (requiredServerIdSet.has(serverId)) {
        await deleteAgentMcpPreference(input.adoptionId, serverId);
        return;
      }
      await setAgentMcpPreference({
        adoptId: input.adoptionId,
        serverId,
        enabled: false,
      });
    }));
  const selectedSkillIds = Array.from(new Set(input.skillIds.map(skillId => skillId.trim()).filter(Boolean)))
    .sort();
  const runtimeServerIds = buildSkillValueEvaluationRuntimeMcpServerIds(input.environment);
  const scopedAssets = {
    ...effectiveAssets,
    skills: {
      default: selectedSkillIds,
      optional: [],
    },
    mcpServers: {
      default: Array.from(new Set([
        ...effectiveAssets.mcpServers.default,
        ...runtimeServerIds.filter(serverId => platformServers.has(serverId)),
      ])).sort(),
      optional: [...effectiveAssets.mcpServers.optional],
    },
  };
  writeJiuwenSwarmRoleScopeManifest({
    workspaceDir: resolveRuntimeWorkspaceByIds(input.adoptionId, input.agentId),
    role,
    effectiveAssets: scopedAssets,
    activeMcpServerIds: runtimeServerIds,
    includePlatformMcp: false,
  });
  await refreshJiuwenRuntimeCapabilities(input.adoptionId);
}

function parseHeaderIdentity(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function buildSkillValueEvaluationRuntimePrompt(
  prompt: string,
  hasSelectedSkill: boolean,
): string {
  const controls = [
    "<skill_evaluation_budget>",
    "本轮为快速业务对比，最多调用 10 次业务工具。优先完成用户要求的核心结果；缺失项明确标注后停止，不为补充非核心细节继续扩展查询。",
    "</skill_evaluation_budget>",
  ];
  if (!hasSelectedSkill) {
    controls.push(
      "<skill_evaluation_control>",
      "本侧未装配任何 Skill。不要调用 skill_tool 搜索或加载技能；直接使用当前已授权的业务工具完成用户任务。业务工具返回文件路径时，可以使用 read_file 读取该结果。",
      "</skill_evaluation_control>",
    );
  }
  return [...controls, prompt].join("\n");
}

async function executeRuntimeTurn(input: {
  side: EvaluationSide;
  adoptionId: string;
  skillId: string;
  modelId: string;
  artifact: SkillValueEvaluationArtifact;
  prompt: string;
  configurationFingerprint: string;
}): Promise<SkillValueEvaluationTurnResult> {
  const internalKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (!internalKey) throw new Error("INTERNAL_API_KEY 未配置");
  const port = Number(process.env.PORT || 5180) || 5180;
  const baseUrl = String(process.env.EA_SELF_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/u, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TURN_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/claw/chat-stream`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": internalKey,
      },
      body: JSON.stringify({
        adoptId: input.adoptionId,
        message: buildSkillValueEvaluationRuntimePrompt(input.prompt, Boolean(input.artifact)),
        model: input.modelId,
        conversationId: `skill-eval-ui-${randomUUID()}`,
        channel: "skill_evaluation_ui",
        runtimeMode: "fast",
        selectedSkillIds: input.artifact ? [input.skillId] : [],
        skillEvaluation: {
          profileFingerprint: input.configurationFingerprint,
          disableAutomaticSkillSelection: true,
        },
      }),
    });
    const raw = await response.text();
    const parsed = parseRuntimeSse(raw);
    const completion = streamGate(parsed.events);
    const loadedSkills = nativeLoadedSkills(parsed.events);
    const headerIdentity = parseHeaderIdentity(
      response.headers.get("x-ea-skill-evaluation-pre-dispatch-identity"),
    );
    const headerFingerprint = response.headers.get(
      "x-ea-skill-evaluation-pre-dispatch-fingerprint",
    );
    const injectedSkills = Array.isArray(headerIdentity?.injectedSkills)
      ? headerIdentity.injectedSkills as Array<Record<string, unknown>>
      : [];
    const identityMatches = input.artifact
      ? injectedSkills.some(skill =>
          String(skill.skillId || "") === input.skillId
          && String(skill.version || "") === input.artifact?.version
          && String(skill.artifactSha256 || "") === input.artifact?.artifactSha256)
      : injectedSkills.every(skill => String(skill.skillId || "") !== input.skillId);
    const nativeIdentityMatches = input.artifact
      ? loadedSkills.some(skill => (
          skill.skillId === input.skillId
          && skill.version === input.artifact?.version
        )) && loadedSkills.every(skill => skill.skillId === input.skillId)
      : loadedSkills.length === 0;
    const runtimeIdentityVerified = Boolean(
      headerIdentity
      && headerFingerprint
      && governanceFingerprint(headerIdentity) === headerFingerprint
      && headerIdentity.profileFingerprint === input.configurationFingerprint
      && identityMatches
      && nativeIdentityMatches
    );
    const streamError = parsed.events.find(event => event.data.__stream_error === true);
    const toolResults = new Map(
      parsed.events
        .filter(event => event.event === "tool_result")
        .map(event => [String(event.data.tool_call_id || ""), event.data]),
    );
    const toolCalls = parsed.events
      .filter(event => event.event === "tool_call")
      .map(event => {
        const result = toolResults.get(String(event.data.id || ""));
        return {
          name: String(event.data.name || "未知工具"),
          status: result && result.is_error !== true
            ? "completed" as const
            : "failed" as const,
        };
      });
    const error = !response.ok
      ? `HTTP ${response.status}`
      : streamError
        ? String(streamError.data.error || "Runtime 流执行失败")
        : !completion.completed
          ? "Runtime 响应未完整结束"
          : !runtimeIdentityVerified
            ? "Runtime Skill 装配或隔离状态与所选配置不一致"
            : null;
    return {
      side: input.side,
      status: error ? "failed" : "completed",
      modelId: input.modelId,
      skillVersion: input.artifact?.version || null,
      assistantText: parsed.assistantText.slice(0, 30_000),
      elapsedMs: Date.now() - startedAt,
      toolCalls,
      loadedSkills: loadedSkills.map(skill => ({
        skillId: skill.skillId,
        version: skill.version,
      })),
      usage: parsed.usage,
      runtimeIdentityVerified,
      streamCompleted: completion.completed,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

class RuntimeComparisonProvider implements ApiProvider {
  constructor(
    private readonly input: {
      jobId: string;
      side: EvaluationSide;
      adoptionId: string;
      skillId: string;
      config: SkillValueEvaluationSideConfig;
    },
  ) {}

  id(): string {
    return `ea:skill-value:${this.input.side}`;
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    const promptId = String(context?.vars?.promptId || "");
    const prompt = String(context?.vars?.prompt || "");
    const job = jobs.get(this.input.jobId);
    if (!job) return { error: "Skill 评测任务不存在" };
    const caseResult = job.cases.find(item => item.promptId === promptId);
    if (!caseResult) return { error: `未知测试题 ${promptId}` };
    let result: SkillValueEvaluationTurnResult;
    try {
      result = await executeRuntimeTurn({
        side: this.input.side,
        adoptionId: this.input.adoptionId,
        skillId: this.input.skillId,
        modelId: this.input.config.modelId,
        artifact: this.input.config.artifact,
        prompt,
        configurationFingerprint: job.configurationFingerprint,
      });
    } catch (error) {
      result = {
        side: this.input.side,
        status: "failed",
        modelId: this.input.config.modelId,
        skillVersion: this.input.config.artifact?.version || null,
        assistantText: "",
        elapsedMs: 0,
        toolCalls: [],
        loadedSkills: [],
        usage: null,
        runtimeIdentityVerified: false,
        streamCompleted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    caseResult[this.input.side] = result;
    job.completedRuns += 1;
    job.updatedAt = new Date().toISOString();
    return result.error
      ? { output: result.assistantText || `执行失败：${result.error}` }
      : { output: result.assistantText };
  }
}

const judgeResponseSchema = z.strictObject({
  winner: z.preprocess(value => {
    const normalized = String(value || "").trim().toUpperCase();
    if (["平", "持平", "平局"].includes(String(value || "").trim())) return "TIE";
    return normalized;
  }, z.enum(["A", "B", "TIE"])),
  confidence: z.preprocess(value => {
    if (typeof value === "number") {
      return value >= 0.8 ? "high" : value >= 0.55 ? "medium" : "low";
    }
    const normalized = String(value || "").trim().toLowerCase();
    if (["高", "较高", "high"].includes(normalized)) return "high";
    if (["中", "中等", "medium"].includes(normalized)) return "medium";
    if (["低", "较低", "low"].includes(normalized)) return "low";
    return normalized;
  }, z.enum(["low", "medium", "high"])),
  summary: z.string().trim().min(1).max(600),
  dimensions: z.array(z.strictObject({
    id: z.enum([
      "professional_fit",
      "business_completeness",
      "clarity",
      "actionability",
    ]),
    label: z.string().trim().min(1).max(40),
    aScore: z.coerce.number().int().min(1).max(4),
    bScore: z.coerce.number().int().min(1).max(4),
    reason: z.string().trim().min(1).max(300),
  })).length(4),
});

function parseJudgeJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("专业 Judge 未返回 JSON");
}

export function remapAnonymousJudgeSideLabels(text: string, swapped: boolean): string {
  if (!swapped) return text;
  return text
    .replace(/(?<![A-Za-z0-9])A(?![A-Za-z0-9])/g, "__EA_JUDGE_SIDE_A__")
    .replace(/(?<![A-Za-z0-9])B(?![A-Za-z0-9])/g, "A")
    .replace(/__EA_JUDGE_SIDE_A__/g, "B");
}

function deterministicFailureJudge(
  result: SkillValueEvaluationCaseResult,
): SkillValueEvaluationJudgeResult | null {
  if (!result.left || !result.right) return null;
  if (result.left.status === "completed" && result.right.status === "completed") return null;
  const winner = result.left.status === result.right.status
    ? "tie" as const
    : result.left.status === "completed"
      ? "left" as const
      : "right" as const;
  return {
    winner,
    confidence: "high",
    summary: winner === "tie"
      ? "左右两组均未完成 Runtime 执行，本题无法比较专业质量。"
      : `${winner === "left" ? "左侧" : "右侧"}完成执行，另一侧发生 Runtime 失败。`,
    dimensions: [
      ["professional_fit", "专业匹配"],
      ["business_completeness", "业务完整"],
      ["clarity", "表达清晰"],
      ["actionability", "可执行性"],
    ].map(([id, label]) => ({
      id: id as SkillValueEvaluationJudgeResult["dimensions"][number]["id"],
      label,
      leftScore: result.left?.status === "completed" ? 1 : 0,
      rightScore: result.right?.status === "completed" ? 1 : 0,
      reason: "Runtime 未完成的一侧不进入专业内容比较。",
    })),
    reviewerLabel: "Runtime 完整性判断",
  };
}

async function judgeCase(
  result: SkillValueEvaluationCaseResult,
): Promise<SkillValueEvaluationJudgeResult> {
  const failureJudge = deterministicFailureJudge(result);
  if (failureJudge) return failureJudge;
  if (!result.left || !result.right) throw new Error("左右输出尚未完成");
  const swapped = Number.parseInt(
    governanceFingerprint({ promptId: result.promptId, prompt: result.prompt }).slice(-1),
    16,
  ) % 2 === 1;
  const outputA = swapped ? result.right.assistantText : result.left.assistantText;
  const outputB = swapped ? result.left.assistantText : result.right.assistantText;
  const modelConfig = await resolveSkillValueModelConfig("glm-5.2");
  const response = await callEaAssistantModelWithConfig(modelConfig, {
    maxTokens: 2_000,
    temperature: 0.1,
    timeoutMs: 90_000,
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是匿名 Agent Skill 业务质量评审。",
          "不知道 A/B 使用了什么 Skill 或版本，也不得猜测。",
          "只比较专业匹配度、业务完整性、结构与表达清晰度、可执行性。",
          "回答更长、字段更多或技术术语更多不构成优势。",
          "每个维度按 1-4 分评价，必须解释真正影响业务采用的差异。",
          "输出严格 JSON，包含 winner(A/B/TIE)、confidence、summary、dimensions。",
          "dimensions 必须恰好包含 professional_fit、business_completeness、clarity、actionability，字段为 id、label、aScore、bScore、reason。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: result.prompt,
          evaluationGoal: result.evaluationGoal,
          outputA,
          outputB,
        }),
      },
    ],
  });
  const judged = judgeResponseSchema.parse(parseJudgeJson(response.content));
  const mappedWinner = judged.winner === "TIE"
    ? "tie" as const
    : judged.winner === "A"
      ? swapped ? "right" as const : "left" as const
      : swapped ? "left" as const : "right" as const;
  return {
    winner: mappedWinner,
    confidence: judged.confidence,
    summary: remapAnonymousJudgeSideLabels(judged.summary, swapped),
    dimensions: judged.dimensions.map(dimension => ({
      id: dimension.id,
      label: dimension.label,
      leftScore: swapped ? dimension.bScore : dimension.aScore,
      rightScore: swapped ? dimension.aScore : dimension.bScore,
      reason: remapAnonymousJudgeSideLabels(dimension.reason, swapped),
    })),
    reviewerLabel: `GLM-5.2 匿名业务 Judge`,
  };
}

async function runJob(input: StartJobInput, job: SkillValueEvaluationJob): Promise<void> {
  try {
    const user = await ensureEvaluationUser();
    job.stageLabel = "准备隔离运行环境";
    job.updatedAt = new Date().toISOString();
    const leftAdoption = await ensureEvaluationAdoption({
      adoptionId: job.left.adoptionId,
      userId: user.id,
      roleTemplate: input.roleTemplate,
    });
    const rightAdoption = await ensureEvaluationAdoption({
      adoptionId: job.right.adoptionId,
      userId: user.id,
      roleTemplate: input.roleTemplate,
    });
    await materializeSide({
      adoptionId: job.left.adoptionId,
      agentId: String(leftAdoption.agentId),
      roleTemplate: input.roleTemplate,
      skillId: input.skillId,
      skillName: input.skillName,
      artifact: input.left.artifact,
    });
    await materializeSide({
      adoptionId: job.right.adoptionId,
      agentId: String(rightAdoption.agentId),
      roleTemplate: input.roleTemplate,
      skillId: input.skillId,
      skillName: input.skillName,
      artifact: input.right.artifact,
    });
    await applyEvaluationEnvironment({
      adoptionId: job.left.adoptionId,
      agentId: String(leftAdoption.agentId),
      roleTemplate: input.roleTemplate,
      environment: job.environment,
      skillIds: input.left.artifact ? [input.skillId] : [],
    });
    await applyEvaluationEnvironment({
      adoptionId: job.right.adoptionId,
      agentId: String(rightAdoption.agentId),
      roleTemplate: input.roleTemplate,
      environment: job.environment,
      skillIds: input.right.artifact ? [input.skillId] : [],
    });
    job.status = "running";
    job.stageLabel = "Promptfoo 正在执行左右对比";
    job.updatedAt = new Date().toISOString();
    process.env.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
    process.env.PROMPTFOO_DISABLE_TELEMETRY = "true";
    await evaluate(
      {
        description: `EA Skill Value ${input.skillId} ${job.jobId}`,
        prompts: ["{{prompt}}"],
        providers: [
          new RuntimeComparisonProvider({
            jobId: job.jobId,
            side: "left",
            adoptionId: job.left.adoptionId,
            skillId: input.skillId,
            config: input.left,
          }),
          new RuntimeComparisonProvider({
            jobId: job.jobId,
            side: "right",
            adoptionId: job.right.adoptionId,
            skillId: input.skillId,
            config: input.right,
          }),
        ],
        tests: input.prompts.map(item => ({
          description: `${item.promptId} ${item.name}`,
          vars: { promptId: item.promptId, prompt: item.prompt },
        })),
        writeLatestResults: false,
      },
      {
        cache: false,
        generateSuggestions: false,
        // Jiuwen's tool registry is process-global. Run the two isolated
        // workspaces sequentially so one side cannot replace the other's tools.
        maxConcurrency: 1,
        showProgressBar: false,
        silent: true,
        timeoutMs: PROMPTFOO_TURN_TIMEOUT_MS,
      },
    );
    job.promptfoo.completed = true;
    job.status = "judging";
    job.stageLabel = "专业 Judge 正在匿名比较";
    job.updatedAt = new Date().toISOString();
    await Promise.all(job.cases.map(async caseResult => {
      try {
        caseResult.judge = await judgeCase(caseResult);
        caseResult.judgeError = null;
      } catch (error) {
        caseResult.judge = null;
        caseResult.judgeError = error instanceof Error ? error.message : String(error);
      }
      job.judge.completedCases += 1;
      job.updatedAt = new Date().toISOString();
    }));
    job.summary = summarizeSkillValueEvaluationCases(job.cases);
    job.status = "completed";
    job.stageLabel = "对比与专业评审已完成";
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.stageLabel = "评测执行失败";
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = new Date().toISOString();
  }
}

export function startSkillValueEvaluationJob(input: StartJobInput): SkillValueEvaluationJob {
  cleanupJobs();
  if (input.prompts.length < 1 || input.prompts.length > 5) {
    throw new Error("每个评测批次需要 1 到 5 条测试题");
  }
  const ids = adoptionIds(input.skillId, input.roleTemplate);
  const environment = buildSkillValueEvaluationEnvironment(input.skillId);
  const configurationFingerprint = governanceFingerprint({
    skillId: input.skillId,
    roleTemplate: input.roleTemplate,
    left: input.left,
    right: input.right,
    prompts: input.prompts,
    environment,
  });
  const jobId = `skill-eval-${configurationFingerprint.slice(0, 12)}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const job: SkillValueEvaluationJob = {
    jobId,
    skillId: input.skillId,
    skillName: input.skillName,
    roleTemplate: input.roleTemplate,
    status: "preparing",
    stageLabel: "初始化评测",
    createdAt: now,
    updatedAt: now,
    completedRuns: 0,
    totalRuns: input.prompts.length * 2,
    left: {
      modelId: input.left.modelId,
      skillVersion: input.left.artifact?.version || null,
      adoptionId: ids.left,
    },
    right: {
      modelId: input.right.modelId,
      skillVersion: input.right.artifact?.version || null,
      adoptionId: ids.right,
    },
    cases: input.prompts.map(item => ({
      ...item,
      left: null,
      right: null,
      judge: null,
      judgeError: null,
    })),
    promptfoo: { version: "0.122.2", completed: false },
    judge: { modelId: "glm-5.2", completedCases: 0 },
    environment,
    summary: null,
    configurationFingerprint,
    error: null,
  };
  jobs.set(jobId, job);
  const promise = runJob(input, job).finally(() => jobPromises.delete(jobId));
  jobPromises.set(jobId, promise);
  void promise;
  return cloneJob(job);
}

export function getSkillValueEvaluationJob(jobId: string): SkillValueEvaluationJob | null {
  cleanupJobs();
  const job = jobs.get(jobId);
  return job ? cloneJob(job) : null;
}

export async function waitForSkillValueEvaluationJob(
  jobId: string,
): Promise<SkillValueEvaluationJob | null> {
  await jobPromises.get(jobId);
  return getSkillValueEvaluationJob(jobId);
}
