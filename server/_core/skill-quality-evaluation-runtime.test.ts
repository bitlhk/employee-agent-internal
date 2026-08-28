import { afterEach, describe, expect, it } from "vitest";
import { governanceFingerprint } from "./governance/contracts";
import {
  buildSkillEvaluationRuntimeProfile,
  executeSkillEvaluationRuntimeTurn,
} from "./skill-quality-evaluation-runtime";

const originalInternalKey = process.env.INTERNAL_API_KEY;

afterEach(() => {
  if (originalInternalKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = originalInternalKey;
});

describe("Skill Quality Phase 1B EA Runtime integration", () => {
  it("builds a three-adoption local Runtime profile", () => {
    const profile = buildSkillEvaluationRuntimeProfile({
      env: {
        ...process.env,
        EA_SKILL_EVAL_RUNTIME_BASE_URL: "http://127.0.0.1:5180",
      },
    });
    expect(profile.arms.map(arm => arm.executionArm)).toEqual([
      "target_skill",
      "without_skill",
      "previous_version",
    ]);
    expect(new Set(profile.arms.map(arm => arm.adoptionId)).size).toBe(3);
    expect(profile.arms.map(arm => arm.expectedAgentId)).toEqual(
      profile.arms.map(arm => `jiuwen_${arm.adoptionId}`)
    );
    expect(profile.profileFingerprint).toMatch(/^[a-f0-9]{64}$/u);
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
    const runtimeIdentity = {
      profileFingerprint: profile.profileFingerprint,
      adoptId: arm.adoptionId,
      agentId: arm.expectedAgentId,
      roleTemplate: "wealth-manager",
      runtimeSkills: [
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
        `data: ${JSON.stringify({ choices: [{ delta: { content: "真实运行输出" }, index: 0 }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(raw, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-EA-Skill-Evaluation-Runtime-Identity": Buffer.from(
            JSON.stringify(runtimeIdentity),
            "utf8"
          ).toString("base64url"),
          "X-EA-Skill-Evaluation-Runtime-Fingerprint": governanceFingerprint(
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
    expect(turn.runtimeIdentityStatus).toBe("VERIFIED");
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
      /executionArm|target_skill|previous_version|without_skill/u
    );
  });
});
