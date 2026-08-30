import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SkillEvaluationExecutionArm } from "../../shared/skill-quality-evaluation";
import { getClawByAdoptId } from "../db/claw";
import { governanceFingerprint } from "./governance/contracts";
import { loadWealthSkill21CandidateComparison } from "./skill-quality-evaluation-candidate";
import { loadSkillQualityPilotContracts } from "./skill-quality-evaluation-contracts";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";
import { listSkillsWithRoleDefaults } from "./skills/role-default-skills";
import { parseSkillMarkdown } from "./skills/skill-source";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const runtimeSkillIdentitySchema = z.strictObject({
  skillId: z.string().min(1),
  skillVersionId: z.string().min(1),
  version: z.string().min(1),
  artifactSha256: sha256Schema,
  entrypointSha256: sha256Schema,
});

const runtimeArmSchema = z.strictObject({
  executionArm: z.enum(["target_skill", "without_target_skill", "previous_version"]),
  adoptionId: z.string().regex(/^lgj-eval-[a-z0-9-]{3,48}$/u),
  expectedAgentId: z.string().regex(/^jiuwen_lgj-eval-[a-z0-9-]{3,48}$/u),
  roleTemplate: z.literal("wealth-manager"),
  expectedSkill: runtimeSkillIdentitySchema.nullable(),
});

export const skillEvaluationRuntimeProfileV1Schema = z
  .strictObject({
    schema: z.literal("ea.skill-quality-runtime-profile.v1"),
    profileId: z.string().min(1),
    evaluatedSkillId: z.string().min(1),
    baseUrl: z.string().url(),
    chatEndpoint: z.literal("/api/claw/chat-stream"),
    internalAuthEnv: z.literal("INTERNAL_API_KEY"),
    arms: z.array(runtimeArmSchema).length(3),
    profileFingerprint: sha256Schema,
  })
  .superRefine((profile, context) => {
    const arms = new Set(profile.arms.map(arm => arm.executionArm));
    const adoptions = new Set(profile.arms.map(arm => arm.adoptionId));
    if (arms.size !== 3) {
      context.addIssue({ code: "custom", path: ["arms"], message: "all three execution arms are required" });
    }
    if (adoptions.size !== 3) {
      context.addIssue({ code: "custom", path: ["arms"], message: "each execution arm requires a distinct evaluation adoption" });
    }
    const { profileFingerprint: stored, ...body } = profile;
    if (profileFingerprint(body) !== stored) {
      context.addIssue({
        code: "custom",
        path: ["profileFingerprint"],
        message: "Runtime Profile fingerprint does not match its content",
      });
    }
  });

export type SkillEvaluationRuntimeProfileV1 = z.infer<
  typeof skillEvaluationRuntimeProfileV1Schema
>;
export type SkillEvaluationRuntimeArmV1 = z.infer<typeof runtimeArmSchema>;

type SkillEvaluationRuntimeArtifact = {
  skillId: string;
  skillVersionId: string;
  version: string;
  artifactSha256: string;
  artifactRelativePath: string;
};

export type SkillEvaluationRuntimeArtifactSet = {
  sourceIdentityMode: "approved_inventory" | "candidate_repository";
  comparisonFingerprint: string | null;
  skillId: string;
  skillStoreRoot: string;
  target: SkillEvaluationRuntimeArtifact;
  previousVersion: SkillEvaluationRuntimeArtifact;
  suiteId: string;
  suiteFingerprint: string;
  smokePrompt: string;
};

export function resolveSkillEvaluationRuntimeArtifactSet(input: {
  root?: string;
  skillStoreRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): SkillEvaluationRuntimeArtifactSet {
  const env = input.env || process.env;
  const requestedComparison = String(
    env.EA_SKILL_EVAL_CANDIDATE_COMPARISON || ""
  ).trim();
  if (requestedComparison) {
    const comparison = loadWealthSkill21CandidateComparison(
      input.root || process.cwd(),
      requestedComparison
    );
    const smokeCase = comparison.suite.cases.find(
      item => item.caseId === "WM-SKILL-EVAL-001"
    );
    if (!smokeCase) throw new Error("Candidate Runtime smoke case is missing");
    return {
      sourceIdentityMode: "candidate_repository",
      comparisonFingerprint: comparison.comparisonFingerprint,
      skillId: comparison.target.skillId,
      skillStoreRoot: comparison.skillStoreRoot,
      target: comparison.target,
      previousVersion: comparison.previousVersion,
      suiteId: comparison.suite.suiteId,
      suiteFingerprint: comparison.suite.suiteFingerprint,
      smokePrompt: smokeCase.prompt,
    };
  }

  const contracts = loadSkillQualityPilotContracts({
    root: input.root,
    skillId: "wealth-manager-assistant",
    skillStoreRoot: input.skillStoreRoot,
  });
  const byVersionId = new Map(
    contracts.inventory.records.map(record => [record.skillVersionId, record])
  );
  const target = byVersionId.get(contracts.pilot.target.skillVersionId);
  const previousRef = contracts.pilot.baselines.find(
    baseline => baseline.mode === "previous_version"
  );
  const previous = previousRef?.skillVersionId
    ? byVersionId.get(previousRef.skillVersionId)
    : null;
  const smokeCase = contracts.suite.cases.find(
    item => item.caseId === "WM-SKILL-EVAL-001"
  );
  if (!target || !previous || !smokeCase) {
    throw new Error(
      "Target, previous Skill artifact or Runtime smoke case is missing from the approved evaluation contracts"
    );
  }
  return {
    sourceIdentityMode: "approved_inventory",
    comparisonFingerprint: null,
    skillId: contracts.pilot.skillId,
    skillStoreRoot: contracts.skillStoreRoot,
    target,
    previousVersion: previous,
    suiteId: contracts.suite.suiteId,
    suiteFingerprint: contracts.suite.suiteFingerprint,
    smokePrompt: smokeCase.prompt,
  };
}

export function skillEvaluationRuntimeProfileFingerprint(
  profile: Omit<SkillEvaluationRuntimeProfileV1, "profileFingerprint">
): string {
  return governanceFingerprint(profile);
}

function profileFingerprint(
  profile: Omit<SkillEvaluationRuntimeProfileV1, "profileFingerprint">
): string {
  return skillEvaluationRuntimeProfileFingerprint(profile);
}

export function assertSkillEvaluationRuntimeProfileFingerprint(
  profile: SkillEvaluationRuntimeProfileV1
): void {
  const { profileFingerprint: stored, ...body } = profile;
  if (skillEvaluationRuntimeProfileFingerprint(body) !== stored) {
    throw new Error("Skill evaluation Runtime Profile fingerprint is invalid");
  }
}

function defaultAdoptionId(arm: SkillEvaluationExecutionArm): string {
  if (arm === "target_skill") return "lgj-eval-wealth-target";
  if (arm === "previous_version") return "lgj-eval-wealth-previous";
  return "lgj-eval-wealth-without";
}

export function skillEvaluationAgentId(adoptionId: string): string {
  return `jiuwen_${adoptionId}`;
}

export function buildSkillEvaluationRuntimeProfile(input: {
  root?: string;
  skillStoreRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): SkillEvaluationRuntimeProfileV1 {
  const env = input.env || process.env;
  const artifacts = resolveSkillEvaluationRuntimeArtifactSet({
    root: input.root,
    skillStoreRoot: input.skillStoreRoot,
    env,
  });
  const baseUrl = String(
    env.EA_SKILL_EVAL_RUNTIME_BASE_URL || "http://127.0.0.1:5180"
  ).replace(/\/$/u, "");
  const url = new URL(baseUrl);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!localHosts.has(url.hostname) && env.EA_SKILL_EVAL_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing remote Skill evaluation Runtime ${url.hostname}; set EA_SKILL_EVAL_ALLOW_REMOTE=1 explicitly`
    );
  }
  const expected = (record: SkillEvaluationRuntimeArtifact) => ({
    skillId: artifacts.skillId,
    skillVersionId: record.skillVersionId,
    version: record.version,
    artifactSha256: record.artifactSha256,
    entrypointSha256: createHash("sha256")
      .update(
        readFileSync(
          path.join(
            artifacts.skillStoreRoot,
            record.artifactRelativePath,
            "SKILL.md"
          ),
          "utf8"
        ),
        "utf8"
      )
      .digest("hex"),
  });
  const body = {
    schema: "ea.skill-quality-runtime-profile.v1" as const,
    profileId: String(
      env.EA_SKILL_EVAL_RUNTIME_PROFILE_ID ||
        (artifacts.sourceIdentityMode === "candidate_repository"
          ? "wealth-manager-2.1-candidate-runtime-v1"
          : "wealth-manager-phase1b-local-v1")
    ),
    evaluatedSkillId: artifacts.skillId,
    baseUrl,
    chatEndpoint: "/api/claw/chat-stream" as const,
    internalAuthEnv: "INTERNAL_API_KEY" as const,
    arms: [
      {
        executionArm: "target_skill" as const,
        adoptionId: String(env.EA_SKILL_EVAL_TARGET_ADOPTION_ID || defaultAdoptionId("target_skill")),
        expectedAgentId: skillEvaluationAgentId(
          String(env.EA_SKILL_EVAL_TARGET_ADOPTION_ID || defaultAdoptionId("target_skill"))
        ),
        roleTemplate: "wealth-manager" as const,
        expectedSkill: expected(artifacts.target),
      },
      {
        executionArm: "without_target_skill" as const,
        adoptionId: String(env.EA_SKILL_EVAL_WITHOUT_ADOPTION_ID || defaultAdoptionId("without_target_skill")),
        expectedAgentId: skillEvaluationAgentId(
          String(env.EA_SKILL_EVAL_WITHOUT_ADOPTION_ID || defaultAdoptionId("without_target_skill"))
        ),
        roleTemplate: "wealth-manager" as const,
        expectedSkill: null,
      },
      {
        executionArm: "previous_version" as const,
        adoptionId: String(env.EA_SKILL_EVAL_PREVIOUS_ADOPTION_ID || defaultAdoptionId("previous_version")),
        expectedAgentId: skillEvaluationAgentId(
          String(env.EA_SKILL_EVAL_PREVIOUS_ADOPTION_ID || defaultAdoptionId("previous_version"))
        ),
        roleTemplate: "wealth-manager" as const,
        expectedSkill: expected(artifacts.previousVersion),
      },
    ],
  };
  return skillEvaluationRuntimeProfileV1Schema.parse({
    ...body,
    profileFingerprint: profileFingerprint(body),
  });
}

export type SkillEvaluationRuntimeProfileCheck = {
  executionArm: SkillEvaluationExecutionArm;
  adoptionId: string;
  status: "PASS" | "FAIL";
  checks: Array<{ code: string; passed: boolean; detail: string }>;
  runtimeSkill: {
    skillId: string;
    version: string;
    artifactSha256: string;
    runtimePathFingerprint: string;
  } | null;
};

export async function verifySkillEvaluationRuntimeProfile(
  profile: SkillEvaluationRuntimeProfileV1
): Promise<{
  status: "PASS" | "FAIL";
  profileFingerprint: string;
  arms: SkillEvaluationRuntimeProfileCheck[];
}> {
  assertSkillEvaluationRuntimeProfileFingerprint(profile);
  const arms: SkillEvaluationRuntimeProfileCheck[] = [];
  for (const arm of profile.arms) {
    const checks: SkillEvaluationRuntimeProfileCheck["checks"] = [];
    const adoption = await getClawByAdoptId(arm.adoptionId);
    checks.push({
      code: "DEDICATED_ADOPTION_EXISTS",
      passed: Boolean(adoption),
      detail: adoption ? arm.adoptionId : "adoption not found",
    });
    checks.push({
      code: "ADOPTION_ACTIVE",
      passed: adoption?.status === "active",
      detail: String(adoption?.status || "missing"),
    });
    checks.push({
      code: "ROLE_TEMPLATE_MATCH",
      passed: adoption?.roleTemplate === arm.roleTemplate,
      detail: String(adoption?.roleTemplate || "missing"),
    });
    checks.push({
      code: "RUNTIME_AGENT_ID_MATCH",
      passed: adoption?.agentId === arm.expectedAgentId,
      detail: String(adoption?.agentId || "missing"),
    });
    let runtimeSkill: SkillEvaluationRuntimeProfileCheck["runtimeSkill"] = null;
    if (adoption) {
      const listed = await listSkillsWithRoleDefaults({
        adoptId: arm.adoptionId,
        agentId: String(adoption.agentId),
        roleTemplate: String(adoption.roleTemplate),
      });
      const skill = listed.ok
        ? listed.value.find(item => item.id === "wealth-manager-assistant")
        : undefined;
      if (!arm.expectedSkill) {
        const absent = !skill || !skill.enabled || skill.state !== "ready";
        checks.push({
          code: "WITHOUT_TARGET_SKILL_BASELINE_CLEAN",
          passed: absent,
          detail: skill ? `state=${skill.state}, enabled=${skill.enabled}` : "Skill absent",
        });
      } else {
        const runtimePath = String(skill?.sync.runtimePath || "").trim();
        const runtimeExists = Boolean(
          runtimePath && existsSync(path.join(runtimePath, "SKILL.md"))
        );
        const digest = runtimeExists ? digestSkillSourceTree(runtimePath) : null;
        runtimeSkill = digest
          ? {
              skillId: arm.expectedSkill.skillId,
              version: String(skill?.source.version || ""),
              artifactSha256: digest.sha256,
              runtimePathFingerprint: governanceFingerprint(path.resolve(runtimePath)),
            }
          : null;
        checks.push({
          code: "RUNTIME_SKILL_READY",
          passed: Boolean(skill?.enabled && skill.state === "ready" && runtimeExists),
          detail: skill
            ? `state=${skill.state}, enabled=${skill.enabled}, runtime=${runtimeExists}`
            : "Skill not listed",
        });
        checks.push({
          code: "RUNTIME_ARTIFACT_SHA_MATCH",
          passed: digest?.sha256 === arm.expectedSkill.artifactSha256,
          detail: digest?.sha256 || "runtime artifact missing",
        });
        checks.push({
          code: "RUNTIME_VERSION_MATCH",
          passed: String(skill?.source.version || "") === arm.expectedSkill.version,
          detail: String(skill?.source.version || "missing"),
        });
      }
    }
    arms.push({
      executionArm: arm.executionArm,
      adoptionId: arm.adoptionId,
      status: checks.every(check => check.passed) ? "PASS" : "FAIL",
      checks,
      runtimeSkill,
    });
  }
  return {
    status: arms.every(arm => arm.status === "PASS") ? "PASS" : "FAIL",
    profileFingerprint: profile.profileFingerprint,
    arms,
  };
}

type RuntimeSseEvent = { event: string; data: Record<string, unknown> };

export type NativeLoadedSkillEvidence = {
  toolCallId: string;
  requestedSkillId: string;
  skillId: string;
  version: string;
  skillDirectory: string;
  entrypointSha256: string;
};

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function pythonStringField(
  value: string,
  field: string,
  options: { allowTruncated?: boolean } = {},
): string | null {
  const marker = `'${field}': '`;
  const start = value.indexOf(marker);
  if (start < 0) return null;
  let output = "";
  for (let index = start + marker.length; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") return output;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) return options.allowTruncated && output ? output : null;
    index += 1;
    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "\\" || escaped === "'" || escaped === '"') output += escaped;
    else if (escaped === "u" && /^[a-f0-9]{4}$/iu.test(value.slice(index + 1, index + 5))) {
      output += String.fromCodePoint(Number.parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
    } else if (escaped === "x" && /^[a-f0-9]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      output += String.fromCodePoint(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else output += escaped;
  }
  return options.allowTruncated && output ? output : null;
}

export function nativeLoadedSkills(events: RuntimeSseEvent[]): NativeLoadedSkillEvidence[] {
  const calls = new Map<string, { skillId: string }>();
  for (const event of events) {
    if (event.event !== "tool_call" || event.data.name !== "skill_tool") continue;
    const toolCallId = String(event.data.id || "").trim();
    const argumentsValue = parseRecord(event.data.arguments);
    const skillId = String(argumentsValue?.skill_name || "").trim();
    if (toolCallId && skillId) calls.set(toolCallId, { skillId });
  }
  const loaded: NativeLoadedSkillEvidence[] = [];
  for (const event of events) {
    if (event.event !== "tool_result" || event.data.name !== "skill_tool") continue;
    const toolCallId = String(event.data.tool_call_id || "").trim();
    const call = calls.get(toolCallId);
    if (!call || event.data.is_error === true) continue;
    const structured = parseRecord(event.data.result);
    const structuredData = parseRecord(structured?.data) || structured;
    const rawResult = typeof event.data.result === "string" ? event.data.result : "";
    const skillContent = String(
      structuredData?.skill_content
      || pythonStringField(rawResult, "skill_content", { allowTruncated: true })
      || ""
    );
    if (!skillContent) continue;
    const metadata = parseSkillMarkdown(skillContent);
    loaded.push({
      toolCallId,
      requestedSkillId: call.skillId,
      skillId: metadata.name || call.skillId,
      version: metadata.version,
      skillDirectory: String(
        structuredData?.skill_directory || pythonStringField(rawResult, "skill_directory") || ""
      ),
      entrypointSha256: createHash("sha256").update(skillContent, "utf8").digest("hex"),
    });
  }
  return loaded;
}

export function streamGate(events: RuntimeSseEvent[]): {
  completed: boolean;
  streamEndCount: number;
  unpairedToolCallIds: string[];
} {
  const streamEndCount = events.filter(event => event.data.__stream_end === true).length;
  const toolCallIds = events
    .filter(event => event.event === "tool_call")
    .map(event => String(event.data.id || "").trim())
    .filter(Boolean);
  const toolResultIds = new Set(
    events
      .filter(event => event.event === "tool_result")
      .map(event => String(event.data.tool_call_id || "").trim())
      .filter(Boolean)
  );
  const unpairedToolCallIds = [...new Set(toolCallIds.filter(id => !toolResultIds.has(id)))];
  return {
    completed: streamEndCount === 1 && unpairedToolCallIds.length === 0,
    streamEndCount,
    unpairedToolCallIds,
  };
}

export function parseRuntimeSse(raw: string): {
  events: RuntimeSseEvent[];
  assistantText: string;
  run: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
} {
  const events: RuntimeSseEvent[] = [];
  let eventName = "message";
  let assistantText = "";
  let finalText: string | null = null;
  let run: Record<string, unknown> | null = null;
  let usage: Record<string, unknown> | null = null;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      eventName = "message";
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      events.push({ event: eventName, data: { unparsedSha256: governanceFingerprint(payload) } });
      eventName = "message";
      continue;
    }
    events.push({ event: eventName, data });
    if (data.__run && typeof data.__run === "object") run = data.__run as Record<string, unknown>;
    if (data.__perf && typeof data.__perf === "object") {
      usage = (data.__perf as Record<string, unknown>).usage as Record<string, unknown> || null;
    }
    if (typeof data.__final_text === "string") finalText = data.__final_text;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const delta = first?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") assistantText += delta.content;
    eventName = "message";
  }
  return { events, assistantText: finalText ?? assistantText, run, usage };
}

export type SkillEvaluationRuntimeTurn = {
  executionArm: SkillEvaluationExecutionArm;
  adoptionId: string;
  conversationId: string;
  status: "PASS" | "FAIL";
  httpStatus: number;
  elapsedMs: number;
  assistantText: string;
  assistantTextSha256: string;
  rawSseSha256: string;
  preDispatchIdentityStatus: "VERIFIED" | "UNVERIFIED";
  preDispatchIdentity: Record<string, unknown> | null;
  preDispatchIdentityFingerprint: string | null;
  nativeSkillIdentityStatus: "VERIFIED" | "UNVERIFIED";
  nativeLoadedSkills: NativeLoadedSkillEvidence[];
  streamCompletionStatus: "VERIFIED" | "UNVERIFIED";
  streamEndCount: number;
  unpairedToolCallIds: string[];
  run: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  events: RuntimeSseEvent[];
  error: string | null;
};

export async function executeSkillEvaluationRuntimeTurn(input: {
  profile: SkillEvaluationRuntimeProfileV1;
  arm: SkillEvaluationRuntimeArmV1;
  message: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<SkillEvaluationRuntimeTurn> {
  assertSkillEvaluationRuntimeProfileFingerprint(input.profile);
  const internalKey = String(process.env[input.profile.internalAuthEnv] || "").trim();
  if (!internalKey) throw new Error(`${input.profile.internalAuthEnv} is unavailable`);
  const conversationId = `skill-eval-${randomUUID()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs || 180_000);
  const started = Date.now();
  try {
    const response = await (input.fetchImpl || fetch)(
      `${input.profile.baseUrl}${input.profile.chatEndpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": internalKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          adoptId: input.arm.adoptionId,
          message: input.message,
          conversationId,
          channel: "skill_evaluation",
          runtimeMode: "fast",
          selectedSkillIds: input.arm.expectedSkill
            ? [input.arm.expectedSkill.skillId]
            : [],
          skillEvaluation: {
            profileFingerprint: input.profile.profileFingerprint,
            disableAutomaticSkillSelection: true,
          },
        }),
      }
    );
    const raw = await response.text();
    const parsed = parseRuntimeSse(raw);
    const identityHeader = response.headers.get(
      "x-ea-skill-evaluation-pre-dispatch-identity"
    );
    const identityFingerprint = response.headers.get(
      "x-ea-skill-evaluation-pre-dispatch-fingerprint"
    );
    let runtimeIdentity: Record<string, unknown> | null = null;
    try {
      runtimeIdentity = identityHeader
        ? (JSON.parse(Buffer.from(identityHeader, "base64url").toString("utf8")) as Record<string, unknown>)
        : null;
    } catch {
      runtimeIdentity = null;
    }
    const returnedSkills = Array.isArray(runtimeIdentity?.injectedSkills)
      ? runtimeIdentity.injectedSkills as Array<Record<string, unknown>>
      : [];
    const expectedRuntimeIdentity = input.arm.expectedSkill
      ? returnedSkills.length === 1 &&
        returnedSkills[0]?.skillId === input.arm.expectedSkill.skillId &&
        returnedSkills[0]?.version === input.arm.expectedSkill.version &&
        returnedSkills[0]?.artifactSha256 === input.arm.expectedSkill.artifactSha256
      : returnedSkills.length === 0;
    const preDispatchIdentityVerified = Boolean(
      runtimeIdentity &&
        identityFingerprint &&
        governanceFingerprint(runtimeIdentity) === identityFingerprint &&
        runtimeIdentity.profileFingerprint === input.profile.profileFingerprint &&
        runtimeIdentity.adoptId === input.arm.adoptionId &&
        expectedRuntimeIdentity &&
        parsed.run
    );
    const loadedSkills = nativeLoadedSkills(parsed.events);
    const nativeSkillIdentityVerified = input.arm.expectedSkill
      ? loadedSkills.some(skill =>
          skill.skillId === input.arm.expectedSkill?.skillId &&
          skill.version === input.arm.expectedSkill.version &&
          skill.entrypointSha256 === input.arm.expectedSkill.entrypointSha256
        )
      : loadedSkills.every(skill => skill.skillId !== input.profile.evaluatedSkillId);
    const completion = streamGate(parsed.events);
    const streamError = parsed.events.find(event => event.data.__stream_error === true);
    const error = response.ok
      ? streamError
        ? String(streamError.data.error || "EA Runtime stream failed")
        : null
      : String((() => {
          try {
            return (JSON.parse(raw) as Record<string, unknown>).error;
          } catch {
            return `HTTP ${response.status}`;
          }
        })() || `HTTP ${response.status}`);
    return {
      executionArm: input.arm.executionArm,
      adoptionId: input.arm.adoptionId,
      conversationId,
      status:
        response.ok &&
        !error &&
        preDispatchIdentityVerified &&
        nativeSkillIdentityVerified &&
        completion.completed
          ? "PASS"
          : "FAIL",
      httpStatus: response.status,
      elapsedMs: Date.now() - started,
      assistantText: parsed.assistantText,
      assistantTextSha256: governanceFingerprint(parsed.assistantText),
      rawSseSha256: governanceFingerprint(raw),
      preDispatchIdentityStatus: preDispatchIdentityVerified ? "VERIFIED" : "UNVERIFIED",
      preDispatchIdentity: runtimeIdentity,
      preDispatchIdentityFingerprint: identityFingerprint,
      nativeSkillIdentityStatus: nativeSkillIdentityVerified ? "VERIFIED" : "UNVERIFIED",
      nativeLoadedSkills: loadedSkills,
      streamCompletionStatus: completion.completed ? "VERIFIED" : "UNVERIFIED",
      streamEndCount: completion.streamEndCount,
      unpairedToolCallIds: completion.unpairedToolCallIds,
      run: parsed.run,
      usage: parsed.usage,
      events: parsed.events,
      error,
    };
  } finally {
    clearTimeout(timeout);
  }
}
