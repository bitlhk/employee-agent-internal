import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  FINANCE_SKILL_EVAL_VERSION,
  fingerprint as financeEvalFingerprint,
  ModelPairwiseJudge,
  runEvaluation,
  type EvalCase as FinanceEvalCase,
  type EvalPack as FinanceEvalPack,
  type ModelAdapter as FinanceModelAdapter,
  type RuntimeAdapter as FinanceRuntimeAdapter,
  type RuntimeExecutionEvidence,
} from "finance-skill-eval";
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
  evaluationEngine: {
    id: "finance-skill-eval";
    version: string;
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
    unavailable: number;
    headline: string;
  } | null;
  configurationFingerprint: string;
  error: string | null;
};

type StartJobInput = {
  skillId: string;
  skillName: string;
  roleTemplate: string;
  organization: string;
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
      ? `本轮对比持平：A、B 各胜 ${leftWins} 题${ties ? `，${ties} 题持平` : ""}${unavailable ? `，${unavailable} 题未判定` : ""}`
      : rightWins > leftWins
        ? `B 在 ${rightWins}/${cases.length} 个任务中表现更优${unavailable ? `，${unavailable} 题未判定` : ""}`
        : `A 在 ${leftWins}/${cases.length} 个任务中表现更优${unavailable ? `，${unavailable} 题未判定` : ""}`;
  return { leftWins, rightWins, ties, unavailable, headline };
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

function evaluationOrganizationKey(organization: string): string {
  return createHash("sha256")
    .update(organization.trim() || "default", "utf8")
    .digest("hex")
    .slice(0, 10);
}

function adoptionIds(skillId: string, roleTemplate: string, organization: string): {
  left: string;
  right: string;
} {
  const digest = createHash("sha256")
    .update(`${skillId}:${roleTemplate}:${organization}`, "utf8")
    .digest("hex")
    .slice(0, 10);
  return {
    left: `lgj-eval-ui-${digest}-a`,
    right: `lgj-eval-ui-${digest}-b`,
  };
}

async function ensureEvaluationUser(organization: string) {
  const organizationName = organization.trim() || "EA Skill Evaluation";
  const email = `skill-value-eval+${evaluationOrganizationKey(organizationName)}@local.linggan.invalid`;
  let user = await getUserByEmail(email);
  if (!user) {
    await createUser({
      name: "Skill Value Evaluator",
      email,
      loginMethod: "internal_evaluation",
      role: "user",
      accessLevel: "all",
      organization: organizationName,
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

export function remapAnonymousJudgeSideLabels(text: string, swapped: boolean): string {
  if (!swapped) return text;
  return text
    .replace(/(?<![A-Za-z0-9])A(?![A-Za-z0-9])/g, "__EA_JUDGE_SIDE_A__")
    .replace(/(?<![A-Za-z0-9])B(?![A-Za-z0-9])/g, "A")
    .replace(/__EA_JUDGE_SIDE_A__/g, "B");
}

function financeUsageFromRuntime(
  usage: Record<string, unknown> | null,
): RuntimeExecutionEvidence["usage"] {
  if (!usage) return null;
  const numberValue = (...keys: string[]) => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  return {
    inputTokens: numberValue("input", "prompt_tokens", "input_tokens"),
    outputTokens: numberValue("output", "completion_tokens", "output_tokens"),
    totalTokens: numberValue("total", "total_tokens"),
  };
}

function runtimeTurnFromFinanceEvidence(
  evidence: RuntimeExecutionEvidence,
): SkillValueEvaluationTurnResult {
  return {
    side: evidence.side,
    status: evidence.status,
    modelId: evidence.modelId,
    skillVersion: evidence.skillVersion,
    assistantText: evidence.output,
    elapsedMs: evidence.elapsedMs,
    toolCalls: evidence.toolCalls,
    loadedSkills: evidence.loadedSkills,
    usage: evidence.usage ? {
      input: evidence.usage.inputTokens,
      output: evidence.usage.outputTokens,
      total: evidence.usage.totalTokens,
    } : null,
    runtimeIdentityVerified: evidence.runtimeIdentityVerified,
    streamCompleted: evidence.streamCompleted,
    error: evidence.error,
  };
}

function financeEvalCase(prompt: SkillValueEvaluationRunPrompt): FinanceEvalCase {
  const rubric = [
    ["professional_fit", "专业匹配度", "是否作出符合岗位任务的专业判断，而不是只复述资料。"],
    ["business_completeness", "业务完整性", "是否覆盖完成当前任务所需的关键业务环节和证据。"],
    ["clarity", "结构与表达清晰度", "是否结论清楚、结构易用，并区分事实、判断和缺口。"],
    ["actionability", "可执行性", "是否形成业务人员可以采用的下一步、验证条件或工作产物。"],
  ] as const;
  return {
    caseId: prompt.promptId,
    name: prompt.name,
    taskMode: "single_turn",
    prompt: prompt.prompt,
    evaluationGoal: prompt.evaluationGoal,
    requiredTools: [],
    rubric: rubric.map(([dimension, label, description]) => ({
      criterionId: `${prompt.promptId}-${dimension}`,
      label,
      description,
      dimension,
      weight: 1,
      required: false,
      allOf: [],
      anyOf: [],
      noneOf: [],
    })),
  };
}

function financeSkillVariant(
  skillId: string,
  artifact: SkillValueEvaluationArtifact,
): FinanceEvalPack["variants"]["left"] {
  return artifact ? {
    mode: "skill_version",
    skillId,
    version: artifact.version,
    artifactSha256: artifact.artifactSha256,
  } : {
    mode: "without_target_skill",
    skillId,
  };
}

function buildFinanceEvalPack(
  input: StartJobInput,
  job: SkillValueEvaluationJob,
): FinanceEvalPack {
  const variants: FinanceEvalPack["variants"] = {
    left: financeSkillVariant(input.skillId, input.left.artifact),
    right: financeSkillVariant(input.skillId, input.right.artifact),
  };
  const models: FinanceEvalPack["models"] = {
    analyzer: { providerId: "ea", modelId: "glm-5.2", parameters: {} },
    execution: {
      left: { providerId: "ea-runtime", modelId: input.left.modelId, parameters: {} },
      right: { providerId: "ea-runtime", modelId: input.right.modelId, parameters: {} },
    },
    judge: { providerId: "ea", modelId: "glm-5.2", parameters: {} },
  };
  const cases = input.prompts.map(financeEvalCase);
  const wealthJudgeInstructions = input.roleTemplate === "wealth-manager" ? [
    "财富业务口径：客户风险、层级等原始业务码只有存在机构映射时才能翻译；保留原始码并说明待确认优于自行解释。",
    "正式配置工具返回 BLOCKED 时，额外搜索和罗列原始在售产品不构成业务完整性或推荐价值，也不能替代 eligibleProducts。",
    "正式配置工具返回的 eligibleProducts 和企业 salesEligibility 决定本机构产品是否可售。第三方基金数据中的未代销或不可认购只代表该数据源或渠道，不得自动推翻本机构销售资格；同一企业销售资格明确停售或到期时才应剔除。",
    "固定期限、封闭期或赎回受限产品不能满足高流动性底线；例如 131 天或 323 天期限产品不能因为相对较短或风险较低就称为高流动性。没有当前可购的合格流动性工具时，说明产品缺口优于强行凑出完整方案。",
    "不得仅凭回答中产品编号陌生就断言它不在正式候选；只有 Runtime 证据或回答自身明确显示它来自原始搜索而非 eligibleProducts 时，才按绕过候选处理。判断流动性时应查看方案中承担流动性角色的具体产品，不得把同表中的固定收益产品误判为流动性承载工具。",
    "持仓或到期数组为空只代表当前数据时点未返回记录，不等于客户确定没有持仓或到期事项。",
    "访前和亏损修复应优先识别会改变决策的事实与问题；未核验客户前提前列产品应降低评分。",
  ] : [];
  const judgeProfile: FinanceEvalPack["judgeProfile"] = {
    schemaVersion: "finance.skill-eval.judge-profile.v1",
    profileId: `${input.skillId}-business-quality-v1`,
    version: "1.0.0",
    reviewerLabel: "GLM-5.2 匿名业务 Judge",
    domainInstructions: [
      `你正在评估 ${job.skillName}（${input.skillId}）的实际业务价值。`,
      "具体或有冲击力不等于专业；无法由任务或输出证明的假设应降低评分。",
      "回答更长、字段更多、技术术语更多或限制更多都不自动构成优势。",
      "实时 Runtime 和正式业务工具返回的就绪、候选或阻断结果，优先于题面中未经工具核验的系统状态描述。正式客户推荐应优先使用官方配置上下文工具；不得奖励绕过该工具直接拼接原始产品的答案。",
      ...wealthJudgeInstructions,
    ].join("\n"),
    dimensions: [
      { id: "professional_fit", label: "专业匹配度", description: "岗位专业判断质量" },
      { id: "business_completeness", label: "业务完整性", description: "关键业务环节覆盖" },
      { id: "clarity", label: "结构与表达清晰度", description: "业务人员理解与使用成本" },
      { id: "actionability", label: "可执行性", description: "产物能否支持下一步工作" },
    ],
  };
  const base = {
    schemaVersion: "finance.skill-eval.pack.v1" as const,
    packId: `ea-${input.skillId}-live-evaluation`,
    version: "1.0.0",
    domain: input.roleTemplate,
    targetSkillId: input.skillId,
    targetSkillVersion: input.right.artifact?.version || input.left.artifact?.version || "unversioned",
    description: `EA 技能市场 ${job.skillName} 左右对照评测`,
    models,
    variants,
    metadata: {
      host: "employee-agent",
      roleTemplate: input.roleTemplate,
      environmentFingerprint: governanceFingerprint(job.environment),
    },
    sourceFile: "ea://skill-value-evaluation",
    cases,
    judgeProfile,
  };
  return {
    ...base,
    packFingerprint: financeEvalFingerprint(base),
  };
}

function buildEaFinanceRuntimeAdapter(
  input: StartJobInput,
  job: SkillValueEvaluationJob,
): FinanceRuntimeAdapter {
  return {
    adapterId: "ea-jiuwen-native-runtime-v1",
    async execute(request) {
      const config = input[request.side];
      const adoptionId = job[request.side].adoptionId;
      const result = await executeRuntimeTurn({
        side: request.side,
        adoptionId,
        skillId: input.skillId,
        modelId: config.modelId,
        artifact: config.artifact,
        prompt: request.evalCase.prompt,
        configurationFingerprint: job.configurationFingerprint,
      });
      return {
        runId: request.runId,
        side: request.side,
        caseId: request.evalCase.caseId,
        status: result.status,
        modelId: result.modelId,
        skillVersion: result.skillVersion,
        output: result.assistantText,
        elapsedMs: result.elapsedMs,
        toolCalls: result.toolCalls,
        loadedSkills: result.loadedSkills,
        usage: financeUsageFromRuntime(result.usage),
        runtimeIdentityVerified: result.runtimeIdentityVerified,
        streamCompleted: result.streamCompleted,
        error: result.error,
        traceFingerprint: financeEvalFingerprint(result),
        metadata: { adoptionId },
      };
    },
  };
}

const eaFinanceJudgeModelAdapter: FinanceModelAdapter = {
  adapterId: "ea-assistant-model-v1",
  async complete(request) {
    const modelConfig = await resolveSkillValueModelConfig(request.model.modelId);
    const response = await callEaAssistantModelWithConfig(modelConfig, {
      maxTokens: 2_000,
      temperature: 0.1,
      timeoutMs: 90_000,
      responseFormat: request.responseFormat === "json" ? { type: "json_object" } : undefined,
      messages: request.messages,
    });
    const usage = response.usage && typeof response.usage === "object"
      ? response.usage as Record<string, unknown>
      : null;
    return {
      content: response.content,
      modelId: response.model,
      usage: financeUsageFromRuntime(usage) || undefined,
      metadata: { elapsedMs: response.elapsedMs },
    };
  },
};

async function runJob(input: StartJobInput, job: SkillValueEvaluationJob): Promise<void> {
  try {
    const user = await ensureEvaluationUser(input.organization);
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
    const pack = buildFinanceEvalPack(input, job);
    const report = await runEvaluation({
      pack,
      runtime: buildEaFinanceRuntimeAdapter(input, job),
      judge: new ModelPairwiseJudge(eaFinanceJudgeModelAdapter, pack.models.judge),
      timeoutMs: PROMPTFOO_TURN_TIMEOUT_MS,
      onProgress: progress => {
        job.completedRuns = progress.completedRuns;
        if (progress.stage === "judging") {
          job.status = "judging";
          job.stageLabel = "专业 Judge 正在匿名比较";
        }
        if (progress.evidence) {
          const caseResult = job.cases.find(item => item.promptId === progress.evidence?.caseId);
          if (caseResult) {
            caseResult[progress.evidence.side] = runtimeTurnFromFinanceEvidence(progress.evidence);
          }
        }
        job.updatedAt = new Date().toISOString();
      },
    });
    for (const result of report.cases) {
      const caseResult = job.cases.find(item => item.promptId === result.caseId);
      if (!caseResult) continue;
      caseResult.left = runtimeTurnFromFinanceEvidence(result.left);
      caseResult.right = runtimeTurnFromFinanceEvidence(result.right);
      caseResult.judge = result.judge;
      caseResult.judgeError = result.judgeError;
    }
    job.promptfoo.completed = report.promptfoo.completed;
    job.judge.completedCases = report.cases.length;
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
  const ids = adoptionIds(input.skillId, input.roleTemplate, input.organization);
  const environment = buildSkillValueEvaluationEnvironment(input.skillId);
  const configurationFingerprint = governanceFingerprint({
    skillId: input.skillId,
    roleTemplate: input.roleTemplate,
    organization: input.organization,
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
    evaluationEngine: {
      id: "finance-skill-eval",
      version: FINANCE_SKILL_EVAL_VERSION,
    },
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
