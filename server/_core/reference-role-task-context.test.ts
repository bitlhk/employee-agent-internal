import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePlan: vi.fn(),
  resolveBinding: vi.fn(),
  bindingEvidence: vi.fn(),
  resolutionEvidence: vi.fn(),
  observeShadow: vi.fn(),
}));

vi.mock("./context-resolution/wealth-source-resolution", () => ({
  resolveWealthContextPlan: mocks.resolvePlan,
  resolvedContextBinding: mocks.resolveBinding,
  contextBindingEvidence: mocks.bindingEvidence,
  contextResolutionEvidence: mocks.resolutionEvidence,
  observeWealthContextResolutionShadow: mocks.observeShadow,
}));

import {
  observeReferenceRoleTaskContextShadow,
  prepareReferenceRoleTaskContext,
} from "./reference-role-task-context";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePlan.mockResolvedValue({ mode: "legacy", plan: null });
  mocks.bindingEvidence.mockReturnValue({ bindingId: "binding-1" });
  mocks.resolutionEvidence.mockReturnValue({ schema: "ea.context-resolution-evidence.v1" });
});

describe("reference role task context adapter", () => {
  it("keeps non-wealth follow-up tools out of the wealth context resolver", async () => {
    const result = await prepareReferenceRoleTaskContext({
      roleTemplate: "insurance-advisor",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_followup_task",
      organizationId: "org-1",
    });

    expect(result).toEqual({ sourceBinding: null });
    expect(mocks.resolvePlan).not.toHaveBeenCalled();
  });

  it("prepares governed binding evidence for the wealth follow-up task", async () => {
    const plan = { taskId: "WM-GT-05" };
    const binding = { providerType: "api" };
    mocks.resolvePlan.mockResolvedValue({ mode: "binding", plan });
    mocks.resolveBinding.mockReturnValue(binding);

    const result = await prepareReferenceRoleTaskContext({
      roleTemplate: "wealth-manager",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_followup_task",
      organizationId: "org-1",
    });

    expect(mocks.resolvePlan).toHaveBeenCalledWith({
      taskId: "WM-GT-05",
      organizationId: "org-1",
      contextType: "business_data",
    });
    expect(mocks.resolveBinding).toHaveBeenCalledWith(plan, "governed_followup_payload");
    expect(result).toEqual({
      sourceBinding: { bindingId: "binding-1" },
      contextResolution: { schema: "ea.context-resolution-evidence.v1" },
      shadowTaskId: "WM-GT-05",
    });
  });

  it("fails closed when the governed wealth binding is missing", async () => {
    mocks.resolvePlan.mockResolvedValue({ mode: "binding", plan: { taskId: "WM-GT-05" } });
    mocks.resolveBinding.mockReturnValue(null);

    const result = await prepareReferenceRoleTaskContext({
      roleTemplate: "wealth-manager",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_followup_task",
      organizationId: "org-1",
    });

    expect(result.rejection).toEqual({
      reason: "必需跟进任务上下文来源尚未完成受治理绑定。",
      errorCode: "REQUIRED_CONTEXT_BINDING_MISSING",
    });
  });

  it("delegates shadow observation only for prepared role context", async () => {
    await observeReferenceRoleTaskContextShadow({
      preparation: { sourceBinding: null, shadowTaskId: "WM-GT-05" },
      organizationId: "org-1",
      adoptionId: "lgj-wealth",
      agentId: "agent-wealth",
    });

    expect(mocks.observeShadow).toHaveBeenCalledWith({
      taskId: "WM-GT-05",
      principal: {
        organizationId: "org-1",
        adoptionId: "lgj-wealth",
        agentId: "agent-wealth",
      },
      observed: [{
        logicalAssetId: "governed_followup_payload",
        providerType: "api",
        resourceRef: "api://employee-agent/enterprise-mcp/governed-followup-intent",
      }],
    });
  });
});
