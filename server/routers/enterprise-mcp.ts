import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditBestEffort, recordAuditRequired } from "../_core/audit-events";
import { discoverCustomMcpTools, type CustomMcpEndpointConfig } from "../_core/custom-mcp-client";
import {
  inferEnterpriseMcpToolPolicy,
  validateEnterpriseMcpConfig,
  validateEnterpriseMcpToolPolicy,
  type EnterpriseMcpToolPolicyDraft,
} from "../_core/enterprise-mcp-policy";
import { listAgentRoleTemplates } from "../_core/role-templates";
import { enterpriseMcpIdentityStatus, issueEnterpriseMcpAccessToken } from "../_core/enterprise-mcp-identity";
import { verifyEnterpriseMcpIdentityEnforcement } from "../_core/enterprise-mcp-identity-verification";
import { reconcileEnterpriseMcpRuntimeScopes } from "../_core/enterprise-mcp-runtime-reconcile";
import {
  createEnterpriseMcpConnection,
  getEnterpriseMcpConnection,
  listEnterpriseMcpConnections,
  listEnterpriseMcpToolPolicies,
  listRoleAssetGrants,
  replaceAdminRoleAssetGrantsForAsset,
  revealEnterpriseMcpCredential,
  toPublicEnterpriseMcpConnection,
  updateEnterpriseMcpConnection,
  upsertEnterpriseMcpToolPolicies,
} from "../db";

const protocolVersionSchema = z.enum(["2025-11-25", "2026-07-28"]);
const identityModeSchema = z.enum(["platform", "tenant", "user"]);
const authModeSchema = z.enum(["oauth2_access_token", "static_bearer_legacy", "none_shadow"]);
const classificationSchema = z.enum(["public", "internal", "sensitive", "restricted"]);
const lifecycleSchema = z.enum(["legacy", "shadow", "enforced", "disabled"]);
const sideEffectSchema = z.enum(["read", "compute", "workspace_write", "write", "external_send", "financial_action", "approval_action", "admin_action"]);

const connectorConfigSchema = z.object({
  serverId: z.string().min(3).max(128),
  displayName: z.string().min(1).max(128),
  description: z.string().max(4000).optional().nullable(),
  icon: z.string().max(512).optional().nullable(),
  businessDomain: z.string().min(1).max(64),
  endpointUrl: z.string().url().max(2048),
  resourceUri: z.string().url().max(2048),
  protocolVersion: protocolVersionSchema,
  identityMode: identityModeSchema,
  authMode: authModeSchema,
  credential: z.string().max(16000).optional(),
  clearCredential: z.boolean().optional(),
  dataClassification: classificationSchema,
  environment: z.enum(["dev", "test", "prod"]),
  lifecycleState: lifecycleSchema,
  timeoutMs: z.number().int().min(1000).max(120000),
  ownerDepartment: z.string().max(128).optional().nullable(),
  ownerContact: z.string().max(256).optional().nullable(),
  healthUrl: z.string().url().max(2048).optional().nullable().or(z.literal("")),
});

const toolPolicySchema = z.object({
  toolName: z.string().min(1).max(256),
  enabled: z.boolean(),
  sideEffect: sideEffectSchema,
  requiredScopes: z.array(z.string().max(128)).max(32),
  allowedRoles: z.array(z.string().max(64)).max(100).nullable(),
  identityModeOverride: identityModeSchema.nullable(),
  approvalMode: z.enum(["never", "conditional", "always"]),
  auditLevel: z.enum(["normal", "strong", "highest"]),
  idempotencyRequired: z.boolean(),
  argumentPolicyJson: z.record(z.string(), z.unknown()).nullable(),
});

function actorName(user: { id?: number | string | null; email?: string | null }): string {
  return String(user.email || `user:${user.id || "admin"}`).slice(0, 128);
}

async function endpointConfig(
  row: Awaited<ReturnType<typeof getEnterpriseMcpConnection>> & {},
  user: Parameters<typeof auditActor>[0],
): Promise<CustomMcpEndpointConfig> {
  if (!row) throw new Error("Enterprise MCP connection not found");
  if (row.authMode === "oauth2_access_token") {
    const status = await enterpriseMcpIdentityStatus();
    if (!status.configured) throw new Error("EA 统一短期令牌签发尚未启用");
    const requestId = `emcp_probe_${randomUUID()}`;
    const issued = await issueEnterpriseMcpAccessToken({
      caller: {
        userId: Number(user?.id || 0),
        organization: user?.organization || null,
        adoptId: "lgj-admin-probe",
        agentId: "employee-agent-admin",
        roleKey: "platform-admin",
      },
      identityMode: "platform",
      resourceUri: row.resourceUri,
      serverId: row.serverId,
      toolName: "tools/list",
      scopes: ["mcp.tools.read"],
      requestId,
    });
    return {
      endpointUrl: row.endpointUrl,
      authType: "bearer",
      credential: issued.token,
      timeoutMs: row.timeoutMs,
    };
  }
  const credential = revealEnterpriseMcpCredential(row);
  return {
    endpointUrl: row.endpointUrl,
    authType: row.authMode === "none_shadow" ? "none" : "bearer",
    credential,
    timeoutMs: row.timeoutMs,
  };
}

function storedPolicyDraft(policy: Awaited<ReturnType<typeof listEnterpriseMcpToolPolicies>>[number]): EnterpriseMcpToolPolicyDraft {
  return {
    toolName: policy.toolName,
    enabled: Boolean(policy.enabled),
    sideEffect: policy.sideEffect,
    requiredScopes: Array.isArray(policy.requiredScopes) ? policy.requiredScopes : [],
    allowedRoles: Array.isArray(policy.allowedRoles) ? policy.allowedRoles : null,
    identityModeOverride: policy.identityModeOverride || null,
    approvalMode: policy.approvalMode,
    auditLevel: policy.auditLevel,
    idempotencyRequired: Boolean(policy.idempotencyRequired),
    argumentPolicyJson: policy.argumentPolicyJson && typeof policy.argumentPolicyJson === "object" ? policy.argumentPolicyJson : null,
  };
}

async function requiredAudit(
  phase: "requested" | "completed",
  kind: "connector.config_change" | "tool_policy.change" | "role_grants.change" | "identity_verification",
  ctx: { user: Parameters<typeof auditActor>[0]; req: Parameters<typeof auditRequest>[0] },
  serverId: string,
  metadata: Record<string, unknown>,
  result: "success" | "failed" = "success",
) {
  return await recordAuditRequired({
    action: `mcp.${kind}.${phase}`,
    result,
    severity: "high",
    ...auditActor(ctx.user),
    ...auditRequest(ctx.req),
    targetType: "enterprise_mcp_server",
    targetId: serverId,
    resourceType: "mcp_server",
    resourceId: serverId,
    metadata,
  });
}

export const enterpriseMcpRouter = router({
  list: adminProcedure.query(async () => {
    const [connections, grants, identityProvider] = await Promise.all([
      listEnterpriseMcpConnections(),
      listRoleAssetGrants(),
      enterpriseMcpIdentityStatus(),
    ]);
    const items = await Promise.all(connections.map(async connection => {
      const policies = await listEnterpriseMcpToolPolicies(connection.serverId);
      const connectionGrants = grants.filter(grant => grant.assetType === "mcp_server" && grant.assetId === connection.serverId && grant.enabled);
      const tools = Array.isArray(connection.toolsJson) ? connection.toolsJson : [];
      const blockers: string[] = [];
      if (connection.healthStatus !== "ready" || tools.length === 0) blockers.push("尚未完成工具发现");
      if (connection.authMode !== "oauth2_access_token") blockers.push("尚未使用 EA 短期令牌");
      if (!identityProvider.configured) blockers.push("平台短期令牌签发未配置");
      if (connection.identityVerificationStatus !== "verified") blockers.push("服务端可信身份验证未通过");
      if (!policies.some(policy => policy.enabled)) blockers.push("没有启用的工具策略");
      if (connectionGrants.length === 0) blockers.push("尚未授权给岗位");
      return {
        ...toPublicEnterpriseMcpConnection(connection),
        policies,
        grants: connectionGrants,
        readiness: { readyForEnforcement: blockers.length === 0, blockers },
      };
    }));
    return {
      items,
      identityProvider: {
        ...identityProvider,
        unauthenticatedShadowEnabled: String(process.env.ENTERPRISE_MCP_ALLOW_UNAUTHENTICATED_SHADOW || "").trim().toLowerCase() === "true",
      },
      roles: listAgentRoleTemplates().filter(role => role.status !== "disabled").map(role => ({
        id: role.id,
        name: role.name,
        industry: role.industry,
      })),
    };
  }),

  save: adminProcedure.input(connectorConfigSchema).mutation(async ({ input, ctx }) => {
    const serverId = input.serverId.trim();
    const existing = await getEnterpriseMcpConnection(serverId);
    const credentialConfigured = Boolean(input.credential?.trim() || (!input.clearCredential && existing?.credentialEncrypted));
    validateEnterpriseMcpConfig({
      serverId,
      endpointUrl: input.endpointUrl,
      resourceUri: input.resourceUri,
      healthUrl: input.healthUrl || null,
      authMode: input.authMode,
      lifecycleState: input.lifecycleState,
      identityMode: input.identityMode,
      dataClassification: input.dataClassification,
      timeoutMs: input.timeoutMs,
    });
    if (input.authMode === "static_bearer_legacy" && !credentialConfigured) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "静态 Bearer 方式必须配置访问令牌" });
    }
    const identityContractChanged = !existing
      || existing.endpointUrl !== input.endpointUrl
      || existing.resourceUri !== input.resourceUri
      || existing.authMode !== input.authMode
      || existing.identityMode !== input.identityMode
      || existing.protocolVersion !== input.protocolVersion;
    if (input.authMode === "oauth2_access_token" && input.lifecycleState === "enforced") {
      if (!(await enterpriseMcpIdentityStatus()).configured) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "EA 统一短期令牌签发尚未启用，该连接器暂不能进入强制运行态" });
      }
      if (identityContractChanged || existing?.identityVerificationStatus !== "verified") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "请先保存为影子态并通过服务端可信身份验证，再切换为强制运行" });
      }
    }

    const safeMetadata = {
      operation: existing ? "update" : "create",
      endpointUrl: input.endpointUrl,
      resourceUri: input.resourceUri,
      protocolVersion: input.protocolVersion,
      identityMode: input.identityMode,
      authMode: input.authMode,
      dataClassification: input.dataClassification,
      lifecycleState: input.lifecycleState,
      credentialChanged: input.credential !== undefined || Boolean(input.clearCredential),
    };
    await requiredAudit("requested", "connector.config_change", ctx, serverId, safeMetadata);
    try {
      const actor = actorName(ctx.user);
      const common = {
        displayName: input.displayName.trim(),
        description: input.description?.trim() || null,
        icon: input.icon?.trim() || null,
        businessDomain: input.businessDomain.trim(),
        endpointUrl: input.endpointUrl,
        resourceUri: input.resourceUri,
        protocolVersion: input.protocolVersion,
        identityMode: input.identityMode,
        authMode: input.authMode,
        dataClassification: input.dataClassification,
        environment: input.environment,
        lifecycleState: input.lifecycleState,
        timeoutMs: input.timeoutMs,
        ownerDepartment: input.ownerDepartment?.trim() || null,
        ownerContact: input.ownerContact?.trim() || null,
        healthUrl: input.healthUrl?.trim() || null,
        ...((identityContractChanged || input.authMode !== "oauth2_access_token") ? {
          identityVerificationStatus: "unknown" as const,
          identityVerificationError: null,
          identityVerifiedAt: null,
        } : {}),
        updatedBy: actor,
      } as const;
      const credential = input.authMode !== "static_bearer_legacy" || input.clearCredential
        ? null
        : input.credential?.trim() || undefined;
      const row = existing
        ? await updateEnterpriseMcpConnection(serverId, { ...common, credential })
        : await createEnterpriseMcpConnection({ serverId, ...common, credential, createdBy: actor });
      if (!row) throw new Error("Enterprise MCP connection was not saved");
      const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({ serverId, forceRefresh: true });
      await requiredAudit("completed", "connector.config_change", ctx, serverId, { ...safeMetadata, runtimeRefresh });
      return toPublicEnterpriseMcpConnection(row);
    } catch (error) {
      await recordAuditBestEffort({
        action: "mcp.connector.config_change.failed",
        result: "failed",
        severity: "high",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "enterprise_mcp_server",
        targetId: serverId,
        metadata: { ...safeMetadata, ...auditErrorMetadata(error) },
      });
      throw error;
    }
  }),

  discoverTools: adminProcedure.input(z.object({ serverId: z.string().min(3).max(128) })).mutation(async ({ input, ctx }) => {
    const row = await getEnterpriseMcpConnection(input.serverId);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "企业 MCP 不存在" });
    try {
      const tools = await discoverCustomMcpTools(await endpointConfig(row, ctx.user));
      const existingPolicies = await listEnterpriseMcpToolPolicies(row.serverId);
      const existingNames = new Set(existingPolicies.map(policy => policy.toolName));
      const discoveredNames = new Set(tools.map(tool => tool.name));
      const newPolicies = tools.filter(tool => !existingNames.has(tool.name)).map(tool => inferEnterpriseMcpToolPolicy(tool.name));
      const retiredPolicies = existingPolicies
        .filter(policy => !discoveredNames.has(policy.toolName) && policy.enabled)
        .map(policy => ({ ...storedPolicyDraft(policy), enabled: false }));
      if (newPolicies.length > 0 || retiredPolicies.length > 0) {
        await upsertEnterpriseMcpToolPolicies({ serverId: row.serverId, policies: [...newPolicies, ...retiredPolicies], actor: actorName(ctx.user) });
      }
      await updateEnterpriseMcpConnection(row.serverId, {
        toolsJson: tools,
        healthStatus: "ready",
        lastError: null,
        lastTestedAt: new Date(),
        updatedBy: actorName(ctx.user),
      });
      await recordAuditBestEffort({
        action: "mcp.connector.probed",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "enterprise_mcp_server",
        targetId: row.serverId,
        metadata: { toolCount: tools.length, endpointOrigin: new URL(row.endpointUrl).origin },
      });
      const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({ serverId: row.serverId, forceRefresh: true });
      return { ok: true, tools, runtimeRefresh };
    } catch (error) {
      await updateEnterpriseMcpConnection(row.serverId, {
        healthStatus: "error",
        lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        lastTestedAt: new Date(),
        updatedBy: actorName(ctx.user),
      });
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "MCP 探测失败" });
    }
  }),

  verifyIdentity: adminProcedure.input(z.object({ serverId: z.string().min(3).max(128) })).mutation(async ({ input, ctx }) => {
    const row = await getEnterpriseMcpConnection(input.serverId);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "企业 MCP 不存在" });
    if (row.authMode !== "oauth2_access_token") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "请先将认证方式设置为 EA 短期令牌" });
    }
    const requestMetadata = { endpointOrigin: new URL(row.endpointUrl).origin, checks: ["valid_token", "missing_token", "wrong_audience", "missing_scope", "wrong_tool"] };
    await requiredAudit("requested", "identity_verification", ctx, row.serverId, requestMetadata);
    try {
      const result = await verifyEnterpriseMcpIdentityEnforcement({
        connection: row,
        caller: {
          userId: Number(ctx.user?.id || 0),
          organization: ctx.user?.organization || null,
          adoptId: "lgj-admin-identity-probe",
          agentId: "employee-agent-admin",
          roleKey: "platform-admin",
        },
      });
      const error = result.passed
        ? null
        : result.checks.filter(check => !check.passed).map(check => `${check.code}: ${check.detail}`).join("; ").slice(0, 2000);
      await updateEnterpriseMcpConnection(row.serverId, {
        toolsJson: result.tools,
        healthStatus: result.tools.length > 0 ? "ready" : "error",
        identityVerificationStatus: result.passed ? "verified" : "failed",
        identityVerificationError: error,
        identityVerifiedAt: result.passed ? new Date() : null,
        lastTestedAt: new Date(),
        updatedBy: actorName(ctx.user),
      });
      await requiredAudit("completed", "identity_verification", ctx, row.serverId, {
        ...requestMetadata,
        passed: result.passed,
        toolCount: result.tools.length,
        checks: result.checks.map(check => ({ code: check.code, passed: check.passed })),
      }, result.passed ? "success" : "failed");
      if (!result.passed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `可信身份验证未通过：${error}` });
      }
      return { ok: true, checks: result.checks, tools: result.tools };
    } catch (error) {
      if (!(error instanceof TRPCError)) {
        const message = (error instanceof Error ? error.message : String(error))
          .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
          .slice(0, 2000);
        await updateEnterpriseMcpConnection(row.serverId, {
          identityVerificationStatus: "failed",
          identityVerificationError: message,
          identityVerifiedAt: null,
          lastTestedAt: new Date(),
          updatedBy: actorName(ctx.user),
        });
        await requiredAudit("completed", "identity_verification", ctx, row.serverId, {
          ...requestMetadata,
          passed: false,
          error: message,
        }, "failed");
      }
      throw error instanceof TRPCError
        ? error
        : new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "可信身份验证失败" });
    }
  }),

  saveToolPolicies: adminProcedure.input(z.object({
    serverId: z.string().min(3).max(128),
    policies: z.array(toolPolicySchema).max(256),
  })).mutation(async ({ input, ctx }) => {
    const connection = await getEnterpriseMcpConnection(input.serverId);
    if (!connection) throw new TRPCError({ code: "NOT_FOUND", message: "企业 MCP 不存在" });
    const validRoles = new Set(listAgentRoleTemplates().map(role => role.id));
    for (const policy of input.policies) {
      validateEnterpriseMcpToolPolicy(policy as EnterpriseMcpToolPolicyDraft);
      for (const role of policy.allowedRoles || []) {
        if (!validRoles.has(role)) throw new TRPCError({ code: "BAD_REQUEST", message: `未知岗位: ${role}` });
      }
    }
    const metadata = { policyCount: input.policies.length, toolNames: input.policies.map(policy => policy.toolName) };
    await requiredAudit("requested", "tool_policy.change", ctx, connection.serverId, metadata);
    const policies = await upsertEnterpriseMcpToolPolicies({
      serverId: connection.serverId,
      policies: input.policies as EnterpriseMcpToolPolicyDraft[],
      actor: actorName(ctx.user),
    });
    const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({ serverId: connection.serverId, forceRefresh: true });
    await requiredAudit("completed", "tool_policy.change", ctx, connection.serverId, { ...metadata, runtimeRefresh });
    return { ok: true, policies, runtimeRefresh };
  }),

  setRoleGrants: adminProcedure.input(z.object({
    serverId: z.string().min(3).max(128),
    grants: z.array(z.object({ roleKey: z.string().min(1).max(64), grantMode: z.enum(["default", "optional"]) })).max(100),
  })).mutation(async ({ input, ctx }) => {
    const connection = await getEnterpriseMcpConnection(input.serverId);
    if (!connection) throw new TRPCError({ code: "NOT_FOUND", message: "企业 MCP 不存在" });
    const validRoles = new Set(["*", ...listAgentRoleTemplates().map(role => role.id)]);
    for (const grant of input.grants) {
      if (!validRoles.has(grant.roleKey)) throw new TRPCError({ code: "BAD_REQUEST", message: `未知岗位: ${grant.roleKey}` });
    }
    const previousGrantRoles = (await listRoleAssetGrants())
      .filter(grant => grant.enabled && grant.assetType === "mcp_server" && grant.assetId === connection.serverId)
      .map(grant => grant.roleKey);
    const metadata = { grants: input.grants };
    await requiredAudit("requested", "role_grants.change", ctx, connection.serverId, metadata);
    const rows = await replaceAdminRoleAssetGrantsForAsset({
      assetType: "mcp_server",
      assetId: connection.serverId,
      grants: input.grants,
      actor: actorName(ctx.user),
    });
    const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({
      roleKeys: [...previousGrantRoles, ...input.grants.map(grant => grant.roleKey)],
      forceRefresh: true,
    });
    await requiredAudit("completed", "role_grants.change", ctx, connection.serverId, { ...metadata, runtimeRefresh });
    return { ok: true, rows, runtimeRefresh };
  }),
});
