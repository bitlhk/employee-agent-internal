import { describe, expect, it } from "vitest";
import { resolveSkillEvaluationRuntimeControl } from "./claw-chat";

const fingerprint = "a".repeat(64);

describe("Skill evaluation Runtime control", () => {
  it("is absent for ordinary chat requests", () => {
    expect(
      resolveSkillEvaluationRuntimeControl({
        raw: undefined,
        adoptId: "lgj-business-user",
        internalRequest: false,
      })
    ).toEqual({ ok: true, value: null });
  });

  it("accepts only an internal dedicated evaluation adoption", () => {
    expect(
      resolveSkillEvaluationRuntimeControl({
        raw: {
          profileFingerprint: fingerprint,
          disableAutomaticSkillSelection: true,
        },
        adoptId: "lgj-eval-wealth-target",
        internalRequest: true,
      })
    ).toEqual({
      ok: true,
      value: {
        profileFingerprint: fingerprint,
        disableAutomaticSkillSelection: true,
      },
    });
  });

  it("rejects public, ordinary-adoption and ambiguous controls", () => {
    const raw = {
      profileFingerprint: fingerprint,
      disableAutomaticSkillSelection: true,
    };
    expect(
      resolveSkillEvaluationRuntimeControl({
        raw,
        adoptId: "lgj-eval-wealth-target",
        internalRequest: false,
      })
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      resolveSkillEvaluationRuntimeControl({
        raw,
        adoptId: "lgj-business-user",
        internalRequest: true,
      })
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      resolveSkillEvaluationRuntimeControl({
        raw: { ...raw, hiddenOverride: true },
        adoptId: "lgj-eval-wealth-target",
        internalRequest: true,
      })
    ).toMatchObject({ ok: false, status: 400 });
  });
});
