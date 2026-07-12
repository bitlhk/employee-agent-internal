import { describe, expect, it } from "vitest";
import type { AgentRoleTemplate } from "./role-templates";
import { resolveRoleRuntimeProvisionPlan } from "./role-runtime-adapter";

const baseRole: AgentRoleTemplate = {
  id: "wealth-manager",
  industry: "banking",
  industryName: "银行",
  name: "客户经理/财富经理",
  description: "",
  status: "mvp",
  displayOrder: 10,
  permissionProfile: "internal",
  defaultVisibleZones: ["squad"],
  defaultSkills: [],
  optionalSkills: [],
  mcpServers: [],
  mcpTools: [],
  defaultModel: "openai/gpt-5.5",
  runtime: "jiuwenswarm",
  dataScope: "",
};

describe("resolveRoleRuntimeProvisionPlan", () => {
  it("does not silently fall back to OpenClaw when JiuwenSwarm is disabled", () => {
    const plan = resolveRoleRuntimeProvisionPlan(baseRole, { jiuwenswarmProvisionEnabled: false });

    expect(plan).toEqual({
      requestedRuntime: "jiuwenswarm",
      runtime: "jiuwenswarm",
      fallbackApplied: false,
    });
  });

  it("uses jiuwenswarm when provisioning is enabled", () => {
    const plan = resolveRoleRuntimeProvisionPlan(baseRole, { jiuwenswarmProvisionEnabled: true });

    expect(plan).toEqual({
      requestedRuntime: "jiuwenswarm",
      runtime: "jiuwenswarm",
      fallbackApplied: false,
    });
  });

  it("honors an admin/runtime override", () => {
    const plan = resolveRoleRuntimeProvisionPlan(baseRole, {
      jiuwenswarmProvisionEnabled: true,
      forceRuntime: "openclaw",
    });

    expect(plan).toEqual({
      requestedRuntime: "openclaw",
      runtime: "openclaw",
      fallbackApplied: false,
    });
  });
});
