import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../../../shared/types/skill";

const mocks = vi.hoisted(() => ({
  resolveEffectiveRoleAssets: vi.fn(),
  getRoleRuntimeAdapter: vi.fn(),
  isJiuwenClawAdoptId: vi.fn(),
  resolveRuntimeAgentId: vi.fn(),
  resolveAgentRoleTemplate: vi.fn(),
  listSkillsWithRoleDefaults: vi.fn(),
  getDisabledDefaultSkillIds: vi.fn(),
  setDefaultSkillEnabled: vi.fn(),
  listSkills: vi.fn(),
  setEnabled: vi.fn(),
  reconcileSkills: vi.fn(),
  refreshCapabilities: vi.fn(),
}));

vi.mock("../../db", () => ({
  resolveEffectiveRoleAssets: mocks.resolveEffectiveRoleAssets,
}));
vi.mock("../../routers/role-runtime-adapters", () => ({
  getRoleRuntimeAdapter: mocks.getRoleRuntimeAdapter,
}));
vi.mock("../helpers", () => ({
  isJiuwenClawAdoptId: mocks.isJiuwenClawAdoptId,
  resolveRuntimeAgentId: mocks.resolveRuntimeAgentId,
}));
vi.mock("../role-templates", () => ({
  resolveAgentRoleTemplate: mocks.resolveAgentRoleTemplate,
}));
vi.mock("./role-default-skills", () => ({
  listSkillsWithRoleDefaults: mocks.listSkillsWithRoleDefaults,
}));
vi.mock("./role-skill-preferences", () => ({
  roleSkillPreferences: {
    getDisabledDefaultSkillIds: mocks.getDisabledDefaultSkillIds,
    setDefaultSkillEnabled: mocks.setDefaultSkillEnabled,
  },
}));
vi.mock("./skill-registry", () => ({
  skillRegistry: {
    listSkills: mocks.listSkills,
    setEnabled: mocks.setEnabled,
  },
}));

import { setAgentSkillEnabled } from "./skill-enable-service";

function skill(id: string, enabled = true): Skill {
  const timestamp = "2026-07-30T00:00:00.000Z";
  return {
    id,
    adoptId: "lgj-test",
    source: { kind: "uploaded", skillId: id, displayName: id },
    state: enabled ? "ready" : "disabled",
    enabled,
    review: { state: "none" },
    sync: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const input = {
  adoptId: "lgj-test",
  agentId: "jiuwen_lgj-test",
  roleTemplate: "risk-manager",
  skillId: "risk-default",
  enabled: false,
};

describe("setAgentSkillEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isJiuwenClawAdoptId.mockReturnValue(true);
    mocks.resolveRuntimeAgentId.mockReturnValue("jiuwen_lgj-test");
    mocks.resolveAgentRoleTemplate.mockReturnValue({ id: "risk-manager" });
    mocks.resolveEffectiveRoleAssets.mockResolvedValue({
      skills: { default: ["risk-default"] },
    });
    mocks.getRoleRuntimeAdapter.mockReturnValue({
      reconcileSkills: mocks.reconcileSkills,
      refreshCapabilities: mocks.refreshCapabilities,
    });
    mocks.getDisabledDefaultSkillIds.mockReturnValue([]);
    mocks.setDefaultSkillEnabled.mockReturnValue(["risk-default"]);
    mocks.listSkills.mockResolvedValue({ ok: true, value: [skill("personal-skill")] });
    mocks.reconcileSkills.mockResolvedValue({ ok: true });
    mocks.refreshCapabilities.mockResolvedValue(7);
    mocks.listSkillsWithRoleDefaults.mockResolvedValue({
      ok: true,
      value: [skill("risk-default", false)],
    });
  });

  it("fails closed for a retired runtime", async () => {
    mocks.isJiuwenClawAdoptId.mockReturnValue(false);

    await expect(setAgentSkillEnabled({ ...input, adoptId: "lgc-test" })).resolves.toEqual({
      ok: false,
      kind: "runtime_retired",
      detail: "Legacy runtime has been archived",
    });
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("uses the registry for a non-default skill", async () => {
    const updated = skill("personal-skill", false);
    mocks.resolveEffectiveRoleAssets.mockResolvedValue({ skills: { default: [] } });
    mocks.setEnabled.mockResolvedValue({ ok: true, value: updated });

    await expect(setAgentSkillEnabled({
      ...input,
      skillId: "personal-skill",
    })).resolves.toEqual({ ok: true, item: updated });
    expect(mocks.setEnabled).toHaveBeenCalledWith("lgj-test", "personal-skill", false);
    expect(mocks.reconcileSkills).not.toHaveBeenCalled();
  });

  it("reconciles a role default and rolls the preference back on failure", async () => {
    mocks.reconcileSkills
      .mockResolvedValueOnce({ ok: false, reason: "runtime unavailable" })
      .mockResolvedValueOnce({ ok: true });

    await expect(setAgentSkillEnabled(input)).resolves.toEqual({
      ok: false,
      kind: "sync_failed",
      detail: "runtime unavailable",
    });
    expect(mocks.setDefaultSkillEnabled).toHaveBeenNthCalledWith(
      1,
      "lgj-test",
      "risk-default",
      false,
    );
    expect(mocks.setDefaultSkillEnabled).toHaveBeenNthCalledWith(
      2,
      "lgj-test",
      "risk-default",
      true,
    );
    expect(mocks.reconcileSkills).toHaveBeenCalledTimes(2);
    expect(mocks.refreshCapabilities).not.toHaveBeenCalled();
  });

  it("refreshes role skills without resetting the conversation session", async () => {
    await expect(setAgentSkillEnabled(input)).resolves.toEqual({
      ok: true,
      item: skill("risk-default", false),
    });
    expect(mocks.reconcileSkills).toHaveBeenCalledTimes(1);
    expect(mocks.refreshCapabilities).toHaveBeenCalledWith("lgj-test", "jiuwen_lgj-test");
  });
});
