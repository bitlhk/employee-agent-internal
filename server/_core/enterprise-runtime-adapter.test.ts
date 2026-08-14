import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentBinding } from "../../drizzle/schema";
import {
  buildEnterpriseChatParams,
  buildEnterprisePermissionAnswerParams,
  resolveEnterpriseRuntimeRoute,
  type EnterpriseRuntimeRoute,
} from "./enterprise-runtime-adapter";

const previous = { ...process.env };

function binding(overrides: Partial<RuntimeAgentBinding> = {}): RuntimeAgentBinding {
  return {
    id: 1,
    bindingId: "rtb_test",
    adoptionId: "lgj-test",
    runtimeProfile: "enterprise_canary",
    fallbackProfile: "standalone",
    gatewayTarget: "shanghai_enterprise",
    runtimeGroupId: "ea_s3",
    runtimeBotId: "insurance-advisor",
    runtimeUserId: "ea_user_abc",
    serviceId: "service-1",
    runtimeAgentId: "ea_user_abc",
    workspaceKey: "workspace_abc",
    assetSetFingerprint: null,
    status: "ready",
    version: 1,
    validatedAt: new Date("2026-08-14T00:00:00Z"),
    lastError: null,
    createdAt: new Date("2026-08-14T00:00:00Z"),
    updatedAt: new Date("2026-08-14T00:00:00Z"),
    ...overrides,
  };
}

function route(value = binding()): EnterpriseRuntimeRoute {
  return {
    profile: "enterprise_canary",
    gatewayTarget: "shanghai_enterprise",
    wsUrl: "wss://runtime.example.test/ws",
    binding: value,
  };
}

afterEach(() => {
  process.env = { ...previous };
});

describe("enterprise runtime adapter", () => {
  it("keeps all traffic on standalone unless the feature is enabled", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "false";
    const getBinding = vi.fn();

    await expect(resolveEnterpriseRuntimeRoute("lgj-test", { getBinding })).resolves.toEqual({
      target: "standalone",
      reason: "enterprise_runtime_disabled",
    });
    expect(getBinding).not.toHaveBeenCalled();
  });

  it("selects only a ready enterprise binding with a valid gateway", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "true";
    process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL = "wss://runtime.example.test/ws";
    const selected = await resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(binding()),
    });

    expect(selected.target).toBe("enterprise");
    if (selected.target === "enterprise") {
      expect(selected.route.binding.runtimeUserId).toBe("ea_user_abc");
      expect(selected.route.wsUrl).toBe("wss://runtime.example.test/ws");
    }
  });

  it("fails back before execution for a pending binding", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "true";
    process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL = "ws://192.168.0.114:30005/ws";

    await expect(resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(binding({ status: "pending" })),
    })).resolves.toEqual({
      target: "standalone",
      reason: "enterprise_binding_pending",
    });
  });

  it("builds the native enterprise identity payload without local paths or model overrides", () => {
    const params = buildEnterpriseChatParams({
      route: route(),
      sessionId: "sess-1",
      message: "准备保险客户访前材料",
      runtimeMode: "agent.fast",
    });

    expect(params).toEqual({
      session_id: "sess-1",
      content: "准备保险客户访前材料",
      query: "准备保险客户访前材料",
      mode: "agent.fast",
      group_id: "ea_s3",
      bot_id: "insurance-advisor",
      user_id: "ea_user_abc",
    });
    expect(params).not.toHaveProperty("project_dir");
    expect(params).not.toHaveProperty("model_name");
    expect(params).not.toHaveProperty("selected_skills");
  });

  it("keeps permission continuation on the same runtime identity", () => {
    const params = buildEnterprisePermissionAnswerParams({
      route: route(),
      sessionId: "sess-1",
      permissionRequestId: "permission-1",
      selectedOption: "allow",
    });

    expect(params).toMatchObject({
      session_id: "sess-1",
      group_id: "ea_s3",
      bot_id: "insurance-advisor",
      user_id: "ea_user_abc",
      request_id: "permission-1",
      source: "permission_interrupt",
    });
  });
});
