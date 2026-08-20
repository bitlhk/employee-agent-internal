import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeAgentBinding } from "../../drizzle/schema";
import {
  buildEnterpriseChatParams,
  buildEnterpriseHistoryParams,
  buildEnterpriseManagedMcpProvisioning,
  buildEnterprisePermissionAnswerParams,
  buildEnterpriseRuntimeAttachmentRefs,
  enterpriseRuntimeSupportsModel,
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
    assetSetFingerprint: "a".repeat(64),
    desiredAssetRevision: 1,
    publishedAssetRevision: 1,
    assetDirtyAt: null,
    bindingVersion: 1,
    status: "ready",
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
    const ensureCurrent = vi.fn().mockResolvedValue(binding());
    const selected = await resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(binding()),
      bundleExists: vi.fn().mockReturnValue(true),
      ensureCurrent,
    });

    expect(selected.target).toBe("enterprise");
    if (selected.target === "enterprise") {
      expect(selected.route.binding.runtimeUserId).toBe("ea_user_abc");
      expect(selected.route.wsUrl).toBe("wss://runtime.example.test/ws");
    }
    expect(ensureCurrent).not.toHaveBeenCalled();
  });

  it("publishes a dirty enterprise asset revision before routing", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "true";
    process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL = "wss://runtime.example.test/ws";
    const dirty = binding({
      desiredAssetRevision: 2,
      publishedAssetRevision: 1,
      assetDirtyAt: new Date("2026-08-14T01:00:00Z"),
    });
    const current = binding({ desiredAssetRevision: 2, publishedAssetRevision: 2 });
    const ensureCurrent = vi.fn().mockResolvedValue(current);

    const selected = await resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(dirty),
      bundleExists: vi.fn().mockReturnValue(true),
      ensureCurrent,
    });

    expect(ensureCurrent).toHaveBeenCalledWith("lgj-test");
    expect(selected).toMatchObject({
      target: "enterprise",
      route: { binding: { desiredAssetRevision: 2, publishedAssetRevision: 2 } },
    });
  });

  it("fails back before execution for a pending binding", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "true";
    process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL = "ws://192.168.0.114:30005/ws";
    const ensureBinding = vi.fn().mockResolvedValue(null);

    await expect(resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(binding({ status: "pending" })),
      ensureBinding,
    })).resolves.toEqual({
      target: "standalone",
      reason: "enterprise_binding_pending",
    });
    expect(ensureBinding).toHaveBeenCalledWith("lgj-test");
  });

  it("fails back before execution when the enterprise asset bundle is missing", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "true";
    process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL = "ws://192.168.0.114:30005/ws";

    await expect(resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(binding({ assetSetFingerprint: null })),
      ensureBinding: vi.fn().mockResolvedValue(null),
    })).resolves.toEqual({
      target: "standalone",
      reason: "enterprise_asset_bundle_missing",
    });
  });

  it("repairs a missing binding before the first enterprise request", async () => {
    process.env.EA_ENTERPRISE_RUNTIME_ENABLED = "true";
    process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL = "wss://runtime.example.test/ws";
    const repaired = binding({ runtimeProfile: "enterprise", status: "ready" });
    const ensureBinding = vi.fn().mockResolvedValue(repaired);

    const selected = await resolveEnterpriseRuntimeRoute("lgj-test", {
      getBinding: vi.fn().mockResolvedValue(null),
      ensureBinding,
      bundleExists: vi.fn().mockReturnValue(true),
    });

    expect(ensureBinding).toHaveBeenCalledWith("lgj-test");
    expect(selected).toMatchObject({
      target: "enterprise",
      route: { binding: { bindingId: "rtb_test", status: "ready" } },
    });
  });

  it("builds the native enterprise identity payload with a server-resolved model name", () => {
    const params = buildEnterpriseChatParams({
      route: route(),
      sessionId: "sess-1",
      message: "准备保险客户访前材料",
      adoptId: "lgj-test",
      agentId: "agent-insurance",
      runtimeMode: "agent.fast",
      modelName: "deepseek-v4-flash",
      selectedSkills: [{
        id: "insurance-customer-visit",
        name: "保险客户访前准备",
        description: "准备客户访前材料",
        skillFile: "/local/path/that-must-not-cross-the-runtime-boundary/SKILL.md",
      }],
    });

    expect(params).toEqual({
      session_id: "sess-1",
      content: "准备保险客户访前材料",
      query: "准备保险客户访前材料",
      mode: "agent.fast",
      group_id: "ea_s3",
      bot_id: "insurance-advisor",
      user_id: "ea_user_abc",
      interactive_ask: true,
      model_name: "deepseek-v4-flash",
      request_metadata: {
        source_channel: "lgj-test",
        ea_managed_runtime: true,
        ea_binding_id: "rtb_test",
        ea_source_agent_id: "agent-insurance",
        ea_asset_bundle: {
          binding_id: "rtb_test",
          fingerprint: "a".repeat(64),
          source_agent_id: "agent-insurance",
          workspace_key: "workspace_abc",
        },
        selected_skills: [{
          id: "insurance-customer-visit",
          name: "保险客户访前准备",
          description: "准备客户访前材料",
        }],
      },
    });
    expect(params).not.toHaveProperty("project_dir");
    expect(JSON.stringify(params)).not.toContain("/local/path");
  });

  it("binds history requests to the managed workspace identity", () => {
    expect(buildEnterpriseHistoryParams({
      route: route(),
      adoptId: "lgj-test",
      agentId: "agent-insurance",
      sessionId: "sess_lgj-test_web_conv_1_e1",
      pageIdx: 1,
      pageSize: 500,
      limit: 20,
    })).toMatchObject({
      group_id: "ea_s3",
      bot_id: "insurance-advisor",
      user_id: "ea_user_abc",
      session_id: "sess_lgj-test_web_conv_1_e1",
      page_idx: 1,
      page_size: 500,
      limit: 20,
      request_metadata: {
        source_channel: "lgj-test",
        ea_managed_runtime: true,
        ea_binding_id: "rtb_test",
        ea_asset_bundle: {
          workspace_key: "workspace_abc",
        },
      },
    });
  });

  it("projects only validated prompt attachments into enterprise request metadata", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ea-enterprise-attachment-"));
    try {
      mkdirSync(path.join(workspace, "prompt_attachment"));
      writeFileSync(path.join(workspace, "prompt_attachment", "policy.docx"), "policy");
      const runtimeAttachments = buildEnterpriseRuntimeAttachmentRefs([{
        name: "政策.docx",
        path: "prompt_attachment/policy.docx",
        size: 6,
      }], workspace);
      const params = buildEnterpriseChatParams({
        route: route(),
        sessionId: "sess-attachment",
        message: "请审核附件",
        adoptId: "lgj-test",
        agentId: "agent-insurance",
        runtimeAttachments,
      });

      expect(runtimeAttachments).toEqual([{
        name: "政策.docx",
        path: "prompt_attachment/policy.docx",
        size: 6,
      }]);
      expect(params).toMatchObject({
        request_metadata: { ea_runtime_attachments: runtimeAttachments },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("limits enterprise routing to the configured server-side model allowlist", () => {
    process.env.EA_ENTERPRISE_RUNTIME_MODEL_ALLOWLIST = "deepseek-v4-flash, hy3";

    expect(enterpriseRuntimeSupportsModel("deepseek-v4-flash")).toBe(true);
    expect(enterpriseRuntimeSupportsModel("HY3")).toBe(true);
    expect(enterpriseRuntimeSupportsModel("openpangu-2.0-flash")).toBe(false);
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

  it("provisions only EA gateways with dynamic identity headers and no long-lived credential", () => {
    process.env.EA_ENTERPRISE_RUNTIME_EA_BASE_URL = "https://ea.example.test";
    const provisioning = buildEnterpriseManagedMcpProvisioning({
      route: route(),
      adoptId: "lgj-test",
      agentId: "agent-insurance",
    });

    expect(provisioning).not.toBeNull();
    const root = JSON.parse(String(provisioning?.params.mcp_json));
    expect(Object.keys(root.mcpServers)).toEqual([
      "platform_tools",
      "custom_mcp_gateway",
      "enterprise_mcp_gateway",
      "role_mcp_gateway",
    ]);
    expect(root.mcpServers.enterprise_mcp_gateway).toMatchObject({
      url: "https://ea.example.test/api/internal/enterprise-mcp/mcp",
      auth_headers: {
        "x-ea-runtime-token-audience": "urn:ea:internal-mcp:enterprise-mcp",
        "x-linggan-agent-id": "agent-insurance",
        "x-jiuwen-channel-id": "lgj-test",
      },
    });
    const serverIds = Object.values(root.mcpServers).map((server: any) => server.server_id);
    expect(new Set(serverIds).size).toBe(4);
    expect(serverIds.every((serverId: string) => /^[a-z_]+_[a-f0-9]{12}$/.test(serverId))).toBe(true);
    expect(root.mcpServers.role_mcp_gateway).toMatchObject({
      name: "role_mcp_gateway",
      url: "https://ea.example.test/api/internal/role-mcp/mcp",
      auth_headers: {
        "x-ea-runtime-token-audience": "urn:ea:internal-mcp:role-mcp",
        "x-linggan-agent-id": "agent-insurance",
        "x-jiuwen-channel-id": "lgj-test",
      },
    });
    expect(JSON.stringify(root)).not.toContain("INTERNAL_API_KEY");
    expect(JSON.stringify(root)).not.toContain("INTERNAL_RUNTIME_TOKEN_SECRET");
    expect(provisioning?.params).toMatchObject({
      group_id: "ea_s3",
      bot_id: "insurance-advisor",
      user_id: "ea_user_abc",
      request_metadata: {
        source_channel: "lgj-test",
        ea_managed_runtime: true,
        ea_binding_id: "rtb_test",
        ea_source_agent_id: "agent-insurance",
        ea_asset_bundle: {
          binding_id: "rtb_test",
          fingerprint: "a".repeat(64),
          workspace_key: "workspace_abc",
          source_agent_id: "agent-insurance",
        },
      },
    });
  });
});
