import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { governanceFingerprint } from "./governance/contracts";
import {
  loadSkillQualityPilotContracts,
  resolveSkillStoreRoot,
} from "./skill-quality-evaluation-contracts";
import {
  buildSkillEvaluationRuntimeProfile,
  executeSkillEvaluationRuntimeTurn,
  nativeLoadedSkills,
  parseRuntimeSse,
  skillEvaluationRuntimeProfileV1Schema,
} from "./skill-quality-evaluation-runtime";

const originalInternalKey = process.env.INTERNAL_API_KEY;

function pythonString(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/'/gu, "\\'")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .replace(/\t/gu, "\\t");
}

function skillToolEvents(input: {
  skillId: string;
  skillContent: string;
  includeResult?: boolean;
}): string[] {
  const callId = `call-${input.skillId}`;
  return [
    "event: tool_call",
    `data: ${JSON.stringify({ id: callId, name: "skill_tool", arguments: JSON.stringify({ skill_name: input.skillId }) })}`,
    ...(input.includeResult === false
      ? []
      : [
          "event: tool_result",
          `data: ${JSON.stringify({
            tool_call_id: callId,
            name: "skill_tool",
            result: `success=True data={'skill_directory': 'workspace/skills/${input.skillId}', 'skill_content': '${pythonString(input.skillContent)}'}`,
            is_error: false,
          })}`,
        ]),
  ];
}

function frozenSkillContent(versionId: string): string {
  const contracts = loadSkillQualityPilotContracts({ skillId: "wealth-manager-assistant" });
  const record = contracts.inventory.records.find(item => item.skillVersionId === versionId);
  if (!record) throw new Error(`Missing frozen Skill ${versionId}`);
  return readFileSync(
    path.join(resolveSkillStoreRoot(), record.artifactRelativePath, "SKILL.md"),
    "utf8"
  );
}

afterEach(() => {
  if (originalInternalKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = originalInternalKey;
});

describe("Skill Quality Phase 1B EA Runtime integration", () => {
  it("reads Skill identity from an enterprise-truncated skill_tool result", () => {
    const skillId = "wealth-manager-assistant";
    const callId = `call-${skillId}`;
    const skillContent = [
      "---",
      `name: ${skillId}`,
      "version: 2.0.1",
      "---",
      "# 客户经理财富助手",
      "x".repeat(2_000),
    ].join("\n");
    const result = `success=True data={'skill_directory': 'workspace/skills/${skillId}', 'skill_content': '${pythonString(skillContent)}'}`
      .slice(0, 1_000);
    const raw = [
      "event: tool_call",
      `data: ${JSON.stringify({ id: callId, name: "skill_tool", arguments: JSON.stringify({ skill_name: skillId }) })}`,
      "",
      "event: tool_result",
      `data: ${JSON.stringify({ tool_call_id: callId, name: "skill_tool", result, is_error: false })}`,
      "",
      `data: ${JSON.stringify({ __stream_end: true })}`,
      "",
    ].join("\n");

    expect(nativeLoadedSkills(parseRuntimeSse(raw).events)).toMatchObject([
      { skillId, version: "2.0.1" },
    ]);
  });

  it("builds a three-adoption local Runtime profile", () => {
    const profile = buildSkillEvaluationRuntimeProfile({
      env: {
        ...process.env,
        EA_SKILL_EVAL_RUNTIME_BASE_URL: "http://127.0.0.1:5180",
      },
    });
    expect(profile.arms.map(arm => arm.executionArm)).toEqual([
      "target_skill",
      "without_target_skill",
      "previous_version",
    ]);
    expect(new Set(profile.arms.map(arm => arm.adoptionId)).size).toBe(3);
    expect(profile.arms.map(arm => arm.expectedAgentId)).toEqual(
      profile.arms.map(arm => `jiuwen_${arm.adoptionId}`)
    );
    expect(profile.profileFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      skillEvaluationRuntimeProfileV1Schema.safeParse({
        ...profile,
        profileId: "tampered-profile",
      }).success
    ).toBe(false);
  });

  it("binds the isolated Runtime profile to the frozen 2.1 candidate set", () => {
    const profile = buildSkillEvaluationRuntimeProfile({
      env: {
        ...process.env,
        EA_SKILL_EVAL_CANDIDATE_COMPARISON:
          "wealth-manager-assistant-2.1.0",
        EA_SKILL_EVAL_RUNTIME_BASE_URL: "http://127.0.0.1:5199",
      },
    });
    expect(profile.profileId).toBe("wealth-manager-2.1-candidate-runtime-v1");
    expect(profile.arms[0].expectedSkill).toMatchObject({
      version: "2.1.0",
      artifactSha256:
        "d36ac98aa2a137ba1e22dc43b5bb21e519dcfe855193b5bfb207222400c5e59b",
    });
    expect(profile.arms[2].expectedSkill).toMatchObject({ version: "2.0.2" });
  });

  it("binds the hardened Runtime profile to 2.1.1 and its 2.1.0 baseline", () => {
    const profile = buildSkillEvaluationRuntimeProfile({
      env: {
        ...process.env,
        EA_SKILL_EVAL_CANDIDATE_COMPARISON:
          "wealth-manager-assistant-2.1.1",
        EA_SKILL_EVAL_RUNTIME_BASE_URL: "http://127.0.0.1:5199",
      },
    });
    expect(profile.arms[0].expectedSkill).toMatchObject({
      version: "2.1.1",
      artifactSha256:
        "a9a38f60c4ee9b9918350c1cb27548fcc860ec586969cf24db3644b0e100513b",
    });
    expect(profile.arms[2].expectedSkill).toMatchObject({ version: "2.1.0" });
  });

  it("binds the runtime-hardened profile to 2.1.2 and its 2.1.1 baseline", () => {
    const profile = buildSkillEvaluationRuntimeProfile({
      env: {
        ...process.env,
        EA_SKILL_EVAL_CANDIDATE_COMPARISON:
          "wealth-manager-assistant-2.1.2",
        EA_SKILL_EVAL_RUNTIME_BASE_URL: "http://127.0.0.1:5199",
      },
    });
    expect(profile.arms[0].expectedSkill).toMatchObject({
      version: "2.1.2",
      artifactSha256:
        "b669dd2ad7e6f95a1b0945d2c43302f1d307d7b1d8c8b463424fbcd2fba2f606",
    });
    expect(profile.arms[2].expectedSkill).toMatchObject({ version: "2.1.1" });
  });

  it("binds a native SSE turn to the expected Runtime Skill identity", async () => {
    process.env.INTERNAL_API_KEY = "runtime-test-key";
    const profile = buildSkillEvaluationRuntimeProfile({
      env: {
        ...process.env,
        EA_SKILL_EVAL_RUNTIME_BASE_URL: "http://127.0.0.1:5180",
      },
    });
    const arm = profile.arms[0];
    const skillContent = frozenSkillContent(arm.expectedSkill!.skillVersionId);
    const runtimeIdentity = {
      profileFingerprint: profile.profileFingerprint,
      adoptId: arm.adoptionId,
      agentId: arm.expectedAgentId,
      roleTemplate: "wealth-manager",
      injectedSkills: [
        {
          skillId: arm.expectedSkill!.skillId,
          version: arm.expectedSkill!.version,
          artifactSha256: arm.expectedSkill!.artifactSha256,
        },
      ],
    };
    let posted: Record<string, unknown> | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      posted = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const raw = [
        `data: ${JSON.stringify({ __run: { requestId: "req-1", sessionId: "session-1" } })}`,
        ...skillToolEvents({ skillId: arm.expectedSkill!.skillId, skillContent }),
        `data: ${JSON.stringify({ choices: [{ delta: { content: "真实运行输出" }, index: 0 }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
        `data: ${JSON.stringify({ __stream_end: true })}`,
        "",
      ].join("\n\n");
      return new Response(raw, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-EA-Skill-Evaluation-Pre-Dispatch-Identity": Buffer.from(
            JSON.stringify(runtimeIdentity),
            "utf8"
          ).toString("base64url"),
          "X-EA-Skill-Evaluation-Pre-Dispatch-Fingerprint": governanceFingerprint(
            runtimeIdentity
          ),
        },
      });
    };
    const turn = await executeSkillEvaluationRuntimeTurn({
      profile,
      arm,
      message: "read-only test",
      fetchImpl,
    });
    expect(turn.status).toBe("PASS");
    expect(turn.preDispatchIdentityStatus).toBe("VERIFIED");
    expect(turn.nativeSkillIdentityStatus).toBe("VERIFIED");
    expect(turn.streamCompletionStatus).toBe("VERIFIED");
    expect(turn.streamEndCount).toBe(1);
    expect(turn.nativeLoadedSkills).toMatchObject([
      {
        skillId: arm.expectedSkill!.skillId,
        version: arm.expectedSkill!.version,
        entrypointSha256: arm.expectedSkill!.entrypointSha256,
      },
    ]);
    expect(turn.assistantText).toBe("真实运行输出");
    expect(posted).toMatchObject({
      adoptId: arm.adoptionId,
      selectedSkillIds: ["wealth-manager-assistant"],
      skillEvaluation: {
        profileFingerprint: profile.profileFingerprint,
        disableAutomaticSkillSelection: true,
      },
    });
    expect(JSON.stringify(posted)).not.toMatch(
      /executionArm|target_skill|previous_version|without_target_skill/u
    );
  });

  it("allows a substitute Skill in the without-target arm and records it", async () => {
    process.env.INTERNAL_API_KEY = "runtime-test-key";
    const profile = buildSkillEvaluationRuntimeProfile();
    const arm = profile.arms.find(item => item.executionArm === "without_target_skill")!;
    const substituteContent = readFileSync(
      path.join(
        process.cwd(),
        "examples/wealth-manager-reference-role-pack/skills/privbank-previsit/SKILL.md"
      ),
      "utf8"
    );
    const preDispatchIdentity = {
      profileFingerprint: profile.profileFingerprint,
      adoptId: arm.adoptionId,
      agentId: arm.expectedAgentId,
      roleTemplate: "wealth-manager",
      injectedSkills: [],
    };
    const raw = [
      `data: ${JSON.stringify({ __run: { requestId: "req-2", sessionId: "session-2" } })}`,
      ...skillToolEvents({ skillId: "privbank-previsit", skillContent: substituteContent }),
      `data: ${JSON.stringify({ choices: [{ delta: { content: "替代技能输出" }, index: 0 }] })}`,
      `data: ${JSON.stringify({ __stream_end: true })}`,
      "",
    ].join("\n\n");
    const turn = await executeSkillEvaluationRuntimeTurn({
      profile,
      arm,
      message: "read-only test",
      fetchImpl: async () => new Response(raw, {
        status: 200,
        headers: {
          "X-EA-Skill-Evaluation-Pre-Dispatch-Identity": Buffer.from(
            JSON.stringify(preDispatchIdentity),
            "utf8"
          ).toString("base64url"),
          "X-EA-Skill-Evaluation-Pre-Dispatch-Fingerprint": governanceFingerprint(
            preDispatchIdentity
          ),
        },
      }),
    });
    expect(turn.status).toBe("PASS");
    expect(turn.nativeLoadedSkills).toMatchObject([
      { skillId: "privbank-previsit", version: "1.3.0" },
    ]);
  });

  it("fails when SSE completion or tool-result pairing is missing", async () => {
    process.env.INTERNAL_API_KEY = "runtime-test-key";
    const profile = buildSkillEvaluationRuntimeProfile();
    const arm = profile.arms[0];
    const skillContent = frozenSkillContent(arm.expectedSkill!.skillVersionId);
    const preDispatchIdentity = {
      profileFingerprint: profile.profileFingerprint,
      adoptId: arm.adoptionId,
      agentId: arm.expectedAgentId,
      roleTemplate: "wealth-manager",
      injectedSkills: [{
        skillId: arm.expectedSkill!.skillId,
        version: arm.expectedSkill!.version,
        artifactSha256: arm.expectedSkill!.artifactSha256,
      }],
    };
    const raw = [
      `data: ${JSON.stringify({ __run: { requestId: "req-3", sessionId: "session-3" } })}`,
      ...skillToolEvents({
        skillId: arm.expectedSkill!.skillId,
        skillContent,
        includeResult: false,
      }),
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, index: 0 }] })}`,
      "",
    ].join("\n\n");
    const turn = await executeSkillEvaluationRuntimeTurn({
      profile,
      arm,
      message: "read-only test",
      fetchImpl: async () => new Response(raw, {
        status: 200,
        headers: {
          "X-EA-Skill-Evaluation-Pre-Dispatch-Identity": Buffer.from(
            JSON.stringify(preDispatchIdentity),
            "utf8"
          ).toString("base64url"),
          "X-EA-Skill-Evaluation-Pre-Dispatch-Fingerprint": governanceFingerprint(
            preDispatchIdentity
          ),
        },
      }),
    });
    expect(turn.status).toBe("FAIL");
    expect(turn.nativeSkillIdentityStatus).toBe("UNVERIFIED");
    expect(turn.streamCompletionStatus).toBe("UNVERIFIED");
    expect(turn.streamEndCount).toBe(0);
    expect(turn.unpairedToolCallIds).toEqual([`call-${arm.expectedSkill!.skillId}`]);
  });
});
