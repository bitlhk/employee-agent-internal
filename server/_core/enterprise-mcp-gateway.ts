import { createHash, randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import type { CustomMcpToolSnapshot } from "../db/custom-mcp-connections";
import {
  completeEnterpriseMcpCall,
  getUserById,
  listEnterpriseMcpConnections,
  listEnterpriseMcpToolPolicies,
  resolveEffectiveRoleAssets,
  resolvePersistedAgentMcpSelection,
  reserveEnterpriseMcpCall,
  revealEnterpriseMcpCredential,
} from "../db";
import { getClawByAdoptId, getClawByAgentId } from "../db/claw";
import { auditActor, auditRequest, recordAuditRequired } from "./audit-events";
import { callCustomMcpTool, type CustomMcpEndpointConfig } from "./custom-mcp-client";
import {
  enterpriseMcpIdentityStatus,
  enterpriseMcpJwks,
  enterpriseMcpTenantId,
  issueEnterpriseMcpAccessToken,
} from "./enterprise-mcp-identity";
import {
  enterpriseMcpRoleAllowed,
  validateEnterpriseMcpToolArguments,
  type EnterpriseMcpToolPolicyDraft,
} from "./enterprise-mcp-policy";
import { isAuthorizedInternalRequest } from "./helpers";
import { beginMcpCall } from "./observability/metrics";
import { stableToolInputHash } from "./tool-governance";
import { guardToolEgress } from "./tool-egress-policy";
import { evaluateGovernance, type GovernanceOperation } from "./governance/contracts";
import { approvalRequiredToolResult, enforceGovernanceApproval } from "./governance/approval-service";
import { attachContextReceipt, buildContextReceipt } from "./governance/context-receipt";
import { enterpriseMcpPolicyAdapter } from "./governance/enterprise-mcp-policy-adapter";
import { evaluateWealthTaskReadiness, readinessCheck } from "./governance/wealth-task-readiness";
import { resolveRuntimePrincipal, resolveRuntimePrincipalV2, type PrincipalResolution } from "./governance/principal";
import { authorizeExecutionAuthority, requiresExecutionAuthority } from "./governance/execution-authority";
import { capabilitySetFingerprint } from "./governance/capability-registry";
import { runtimeGovernanceIsAttested } from "./runtime-governance-attestation";

const SERVICE_NAME = "enterprise-mcp-gateway";
const SERVICE_VERSION = "1.0.0";
const MAX_ACTIVE_CALLS_PER_AGENT = 4;
const activeCalls = new Map<string, number>();

type Connection = Awaited<ReturnType<typeof listEnterpriseMcpConnections>>[number];
type Policy = Awaited<ReturnType<typeof listEnterpriseMcpToolPolicies>>[number];

type RuntimeContext = {
  adoptId: string;
  agentId: string;
  roleKey: string;
  user: NonNullable<Awaited<ReturnType<typeof getUserById>>>;
  adoption: NonNullable<Awaited<ReturnType<typeof getClawByAdoptId>>>;
  enabledServerIds: Set<string>;
  principal: PrincipalResolution;
};

type ExposedTool = {
  exposedName: string;
  connection: Connection;
  policy: Policy;
  tool: CustomMcpToolSnapshot;
};

type JsonRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type GatewayCallControls = {
  approvalId?: string | null;
  taskAuthorizationSnapshotId?: string | null;
  runtimeAttested?: boolean;
  executionOrigin?: "jiuwenswarm" | "a2a_local_executor";
};

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function hasRequestId(id: unknown): boolean {
  return id !== undefined && id !== null;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "Enterprise MCP call failed")).slice(0, 1_000);
}

function stableHash(value: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(value) ?? String(value ?? "");
  } catch {
    raw = String(value ?? "");
  }
  return createHash("sha256").update(raw).digest("hex");
}

function stripUntrustedEaMetadata<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (!result._meta || typeof result._meta !== "object" || Array.isArray(result._meta)) return value;
  const meta = { ...result._meta as Record<string, unknown> };
  const reservedKeys = ["eaMetadataIssuer", "eaContextReceipt", "eaInteractionGrant", "eaResponseEvidence", "eaTaskReceiptBundle"];
  if (!reservedKeys.some((key) => key in meta)) return value;
  delete meta.eaContextReceipt;
  delete meta.eaMetadataIssuer;
  delete meta.eaInteractionGrant;
  delete meta.eaResponseEvidence;
  delete meta.eaTaskReceiptBundle;
  return { ...result, _meta: meta } as T;
}

export function enterpriseMcpGatewayToolName(serverId: string, remoteToolName: string): string {
  const serverDigest = createHash("sha256").update(serverId).digest("hex").slice(0, 8);
  const toolDigest = createHash("sha256").update(remoteToolName).digest("hex").slice(0, 8);
  const safeName = remoteToolName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const prefix = `enterprise_${serverDigest}_`;
  return `${prefix}${safeName.slice(0, Math.max(1, 119 - prefix.length))}_${toolDigest}`.slice(0, 128);
}

async function trustedAdoptId(req: Request): Promise<string> {
  for (const name of ["x-jiuwen-channel-id", "x-agent-adopt-id", "x-workforce-agent-adopt-id"]) {
    const value = String(req.headers[name] || "").trim();
    if (/^lgj-[A-Za-z0-9_-]{3,60}$/.test(value)) return value;
  }
  const runtimeAgentId = String(req.headers["x-linggan-agent-id"] || "").trim();
  if (!runtimeAgentId) return "";
  const claw = await getClawByAgentId(runtimeAgentId).catch(() => null);
  return String(claw?.adoptId || "");
}

async function runtimeContextForAdoptId(adoptId: string, sessionId?: unknown): Promise<RuntimeContext> {
  if (!adoptId) throw new Error("trusted Agent identity is missing");
  const claw = await getClawByAdoptId(adoptId);
  if (!claw || !["active", "expiring"].includes(String(claw.status || ""))) throw new Error("Agent is not active");
  const user = await getUserById(Number(claw.userId || 0));
  if (!user) throw new Error("Agent owner is unavailable");
  const roleKey = String(claw.roleTemplate || "general-assistant").trim();
  const effectiveAssets = await resolveEffectiveRoleAssets(roleKey);
  const selection = await resolvePersistedAgentMcpSelection(adoptId, effectiveAssets);
  return {
    adoptId,
    agentId: String(claw.agentId || adoptId),
    roleKey,
    user,
    adoption: claw,
    enabledServerIds: new Set(selection.enabledServerIds),
    principal: resolveRuntimePrincipal({
      adoption: claw,
      sessionId,
    }),
  };
}

async function runtimeContext(req: Request): Promise<RuntimeContext> {
  return await runtimeContextForAdoptId(
    await trustedAdoptId(req),
    req.headers["x-linggan-session-id"],
  );
}

function policyDraft(policy: Policy): EnterpriseMcpToolPolicyDraft {
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

function shadowRuntimeEnabled(): boolean {
  return String(process.env.ENTERPRISE_MCP_ALLOW_UNAUTHENTICATED_SHADOW || "").trim().toLowerCase() === "true";
}

async function catalogTools(): Promise<ExposedTool[]> {
  const identity = await enterpriseMcpIdentityStatus();
  const connections = await listEnterpriseMcpConnections();
  const exposed: ExposedTool[] = [];
  for (const connection of connections) {
    if (connection.lifecycleState === "disabled") continue;
    if (connection.lifecycleState === "shadow" && !shadowRuntimeEnabled()) continue;
    if (connection.healthStatus !== "ready") continue;
    if (connection.authMode === "oauth2_access_token" && !identity.configured) continue;
    if (connection.authMode === "oauth2_access_token" && connection.lifecycleState === "enforced" && connection.identityVerificationStatus !== "verified") continue;
    if (connection.authMode === "none_shadow" && connection.lifecycleState !== "shadow") continue;
    const snapshots = Array.isArray(connection.toolsJson) ? connection.toolsJson as CustomMcpToolSnapshot[] : [];
    const policyByName = new Map((await listEnterpriseMcpToolPolicies(connection.serverId)).map(policy => [policy.toolName, policy]));
    for (const tool of snapshots) {
      const policy = policyByName.get(tool.name);
      if (!policy?.enabled) continue;
      exposed.push({
        exposedName: enterpriseMcpGatewayToolName(connection.serverId, tool.name),
        connection,
        policy,
        tool,
      });
    }
  }
  return exposed;
}

async function exposedTools(context: RuntimeContext): Promise<ExposedTool[]> {
  return (await catalogTools()).filter((entry) =>
    context.enabledServerIds.has(entry.connection.serverId)
    && enterpriseMcpRoleAllowed(policyDraft(entry.policy), context.roleKey)
  );
}

function idempotencyKey(args: Record<string, unknown>): string {
  return String(args.idempotency_key || args.idempotencyKey || "").trim().slice(0, 191);
}

function externalRequestId(result: Record<string, unknown>): string | null {
  const meta = result._meta && typeof result._meta === "object" ? result._meta as Record<string, unknown> : null;
  const value = result.externalRequestId || result.external_request_id || result.recordId
    || meta?.externalRequestId || meta?.external_request_id || meta?.recordId
    || result.requestId || result.request_id || meta?.requestId || meta?.request_id;
  return value ? String(value).slice(0, 128) : null;
}

async function endpointConfig(entry: ExposedTool, token: string | null): Promise<CustomMcpEndpointConfig> {
  if (entry.connection.authMode === "static_bearer_legacy") {
    const credential = revealEnterpriseMcpCredential(entry.connection);
    if (!credential) throw new Error("Enterprise MCP static credential is missing");
    return { endpointUrl: entry.connection.endpointUrl, authType: "bearer", credential, timeoutMs: entry.connection.timeoutMs };
  }
  if (entry.connection.authMode === "oauth2_access_token") {
    if (!token) throw new Error("Enterprise MCP identity token is unavailable");
    return { endpointUrl: entry.connection.endpointUrl, authType: "bearer", credential: token, timeoutMs: entry.connection.timeoutMs };
  }
  return token
    ? { endpointUrl: entry.connection.endpointUrl, authType: "bearer", credential: token, timeoutMs: entry.connection.timeoutMs }
    : { endpointUrl: entry.connection.endpointUrl, authType: "none", timeoutMs: entry.connection.timeoutMs };
}

async function auditCall(input: {
  phase: "requested" | "completed";
  entry: ExposedTool;
  context: RuntimeContext;
  req: Request;
  requestId: string;
  policyDecisionId: string;
  result: "success" | "failed" | "denied";
  metadata: Record<string, unknown>;
}): Promise<void> {
  const event = {
    action: `mcp.enterprise_tool.${input.phase}`,
    result: input.result,
    severity: input.result === "success" ? "info" as const : "high" as const,
    ...auditActor(input.context.user),
    ...auditRequest(input.req),
    requestId: input.requestId,
    targetType: "mcp_tool",
    targetId: `${input.entry.connection.serverId}:${input.entry.tool.name}`.slice(0, 128),
    targetName: input.entry.tool.name,
    resourceType: "mcp_server",
    resourceId: input.entry.connection.serverId,
    resourceName: input.entry.connection.displayName,
    agentInstanceId: input.context.adoptId,
    runtimeType: "jiuwenswarm",
    runtimeAgentId: input.context.agentId,
    toolName: input.entry.tool.name,
    policyCode: "EA_ENTERPRISE_MCP_POLICY_V1",
    source: "enterprise_mcp_gateway",
    metadata: {
      policyDecisionId: input.policyDecisionId,
      capabilitySetFingerprint: capabilitySetFingerprint(),
      ...input.metadata,
    },
  };
  await recordAuditRequired(event);
}

async function gatewayCall(
  context: RuntimeContext,
  exposedName: string,
  args: Record<string, unknown>,
  req: Request,
  controls: GatewayCallControls = {},
) {
  const current = activeCalls.get(context.adoptId) || 0;
  if (current >= MAX_ACTIVE_CALLS_PER_AGENT) return textResult("当前企业连接器调用较多，请稍后重试。", true);
  activeCalls.set(context.adoptId, current + 1);
  const finishMetric = beginMcpCall("enterprise");
  let metricOutcome: "success" | "empty" | "error" = "empty";
  const startedAt = Date.now();
  let requestId = "";
  let receiptReserved = false;
  let auditState: {
    entry: ExposedTool;
    policyDecisionId: string;
    argsHash: string;
    identityMode: "platform" | "tenant" | "user";
    tenantId: string;
    sideEffect: EnterpriseMcpToolPolicyDraft["sideEffect"];
  } | null = null;
  try {
    const entry = (await exposedTools(context)).find(item => item.exposedName === exposedName);
    if (!entry) return textResult("该企业工具未授权、已停用或不属于当前岗位。", true);
    const policy = policyDraft(entry.policy);
    const identityMode = policy.identityModeOverride || entry.connection.identityMode;
    requestId = `emcp_${randomUUID()}`;
    const tenantId = enterpriseMcpTenantId(context.user.organization, context.user.id);
    const argsHash = stableToolInputHash(args);
    const idemKey = idempotencyKey(args);
    const operation: GovernanceOperation = {
      capabilityId: "enterprise.mcp",
      operation: entry.tool.name,
      sideEffect: policy.sideEffect,
      resource: `enterprise-mcp:${entry.connection.serverId}`,
      payloadHash: argsHash,
    };
    let effectivePrincipal = context.principal;
    let executionAuthority: Awaited<ReturnType<typeof authorizeExecutionAuthority>> | null = null;
    if (requiresExecutionAuthority(policy.sideEffect)) {
      const principalV2 = await resolveRuntimePrincipalV2({
        adoption: context.adoption,
        user: context.user,
        sessionId: context.principal.principal.sessionId,
      });
      if (!principalV2.complete) {
        metricOutcome = "error";
        return textResult("当前执行身份无法形成可验证授权快照，已停止该操作。", true);
      }
      executionAuthority = await authorizeExecutionAuthority({
        principal: principalV2.principal,
        taskAuthorizationSnapshotId: controls.taskAuthorizationSnapshotId
          || String(req.headers["x-ea-authorization-snapshot-id"] || "").trim()
          || null,
        operation,
      });
      if (executionAuthority.effect !== "ALLOW") {
        metricOutcome = "error";
        await recordAuditRequired({
          action: "governance.execution_authority.blocked",
          result: "denied",
          severity: "high",
          ...auditActor(context.user),
          ...auditRequest(req),
          targetType: "mcp_tool",
          targetId: `${entry.connection.serverId}:${entry.tool.name}`.slice(0, 128),
          workspaceId: principalV2.principal.workspaceId,
          agentInstanceId: context.adoptId,
          runtimeAgentId: context.agentId,
          sessionId: principalV2.principal.sessionId,
          toolName: entry.tool.name,
          policyCode: executionAuthority.policyCode,
          source: "enterprise_mcp_gateway",
          metadata: {
            ruleVersion: executionAuthority.ruleVersion,
            taskSnapshotId: executionAuthority.taskSnapshotId,
            currentSnapshotId: executionAuthority.currentSnapshotId,
            effectiveAuthorityFingerprint: executionAuthority.effectiveAuthorityFingerprint,
          },
        });
        return textResult(executionAuthority.reason, true);
      }
      effectivePrincipal = { principal: executionAuthority.effectivePrincipal, complete: true, issues: [] };
    }
    const governance = await evaluateGovernance({
      principal: effectivePrincipal.principal,
      operation,
      context: { serverId: entry.connection.serverId, approvalMode: policy.approvalMode },
    }, [enterpriseMcpPolicyAdapter({
      policy,
      principal: effectivePrincipal,
      runtimeAttested: controls.runtimeAttested ?? runtimeGovernanceIsAttested(req.headers["x-ea-runtime-id"]),
    })], {
      effect: "DENY",
      policyCode: "EA_ENTERPRISE_MCP_POLICY_UNAVAILABLE",
      ruleVersion: "enterprise-mcp-v2",
      reason: "企业 MCP 治理策略不可用，已阻止执行。",
      obligations: [{ type: "AUDIT", level: "strong" }],
    });
    const policyDecisionId = governance.decisionId;

    await auditCall({
      phase: "requested", entry, context, req, requestId, policyDecisionId, result: "success",
      metadata: {
        argsHash,
        sideEffect: policy.sideEffect,
        identityMode,
        tenantId,
        scopes: policy.requiredScopes,
        auditLevel: policy.auditLevel,
        ruleVersion: governance.ruleVersion,
        principalFingerprint: governance.principalFingerprint,
        operationFingerprint: governance.operationFingerprint,
        executionAuthorityFingerprint: executionAuthority?.effectiveAuthorityFingerprint || null,
        executionOrigin: controls.executionOrigin || "jiuwenswarm",
      },
    });
    auditState = { entry, policyDecisionId, argsHash, identityMode, tenantId, sideEffect: policy.sideEffect };

    const block = async (reason: string, errorCode: string) => {
      if (receiptReserved) {
        await completeEnterpriseMcpCall({ requestId, status: "blocked", durationMs: Date.now() - startedAt, errorCode });
      }
      await auditCall({
        phase: "completed", entry, context, req, requestId, policyDecisionId, result: "denied",
        metadata: { reason, errorCode, argsHash, sideEffect: policy.sideEffect, identityMode },
      });
      metricOutcome = "error";
      return textResult(reason, true);
    };

    try {
      validateEnterpriseMcpToolArguments(policy, args);
    } catch (error) {
      return await block(cleanError(error), "ARGUMENT_POLICY_DENIED");
    }
    if (policy.idempotencyRequired && !idemKey) return await block("该工具需要 idempotency_key，已阻止无幂等保护的调用。", "IDEMPOTENCY_KEY_REQUIRED");

    const egress = await guardToolEgress({
      channel: "enterprise_mcp",
      payload: args,
      adoptId: context.adoptId,
      toolName: entry.tool.name,
      destinationUrl: entry.connection.endpointUrl,
      destinationTrust: "platform",
    });
    if (!egress.ok) return await block(egress.error || "工具参数未通过数据护栏。", "DATA_GUARDRAIL_DENIED");

    const approval = await enforceGovernanceApproval({
      decision: governance,
      principal: effectivePrincipal.principal,
      operation,
      approvalId: controls.approvalId || String(req.headers["x-ea-approval-id"] || "").trim() || null,
      idempotencyKey: idemKey || null,
    });
    if (approval.effect === "REQUIRE_APPROVAL") {
      await auditCall({
        phase: "completed", entry, context, req, requestId, policyDecisionId, result: "denied",
        metadata: {
          errorCode: "APPROVAL_REQUIRED",
          approvalId: approval.requirement.approvalId,
          argsHash,
          sideEffect: policy.sideEffect,
          identityMode,
        },
      });
      metricOutcome = "error";
      return approvalRequiredToolResult({
        approvalId: approval.requirement.approvalId,
        expiresAt: approval.requirement.expiresAt,
        reason: approval.reason,
        policyCode: governance.policyCode,
        toolName: entry.tool.name,
        connectorName: entry.connection.displayName,
        demo: entry.connection.environment === "test" || entry.connection.displayName.includes("Demo"),
      });
    }
    if (approval.effect === "DENY") return await block(approval.reason, "APPROVAL_DENIED");

    const reservation = await reserveEnterpriseMcpCall({
      requestId,
      policyDecisionId,
      approvalId: approval.approval?.approvalId || null,
      idempotencyKey: idemKey || null,
      serverId: entry.connection.serverId,
      toolName: entry.tool.name,
      userId: context.user.id,
      tenantId,
      adoptId: context.adoptId,
      roleKey: context.roleKey,
      identityMode,
      argsHash,
    });
    if (!reservation.reserved) {
      metricOutcome = "error";
      return textResult(`重复请求已阻止（${reservation.receipt.requestId}）。`, true);
    }
    receiptReserved = true;

    const identityStatus = await enterpriseMcpIdentityStatus();
    const issued = identityStatus.configured
      ? await issueEnterpriseMcpAccessToken({
        caller: {
          userId: context.user.id,
          organization: context.user.organization,
          adoptId: context.adoptId,
          agentId: context.agentId,
          roleKey: context.roleKey,
        },
        identityMode,
        resourceUri: entry.connection.resourceUri,
        serverId: entry.connection.serverId,
        toolName: entry.tool.name,
        scopes: policy.requiredScopes,
        requestId,
      })
      : null;
    const result = stripUntrustedEaMetadata(
      await callCustomMcpTool(await endpointConfig(entry, issued?.token || null), entry.tool.name, args),
    );
    const failed = result.isError === true;
    const resultHash = stableHash(result);
    const externalId = externalRequestId(result);
    await completeEnterpriseMcpCall({
      requestId,
      status: failed ? "failed" : "completed",
      resultHash,
      externalRequestId: externalId,
      durationMs: Date.now() - startedAt,
      errorCode: failed ? "REMOTE_TOOL_ERROR" : null,
    });
    await auditCall({
      phase: "completed", entry, context, req, requestId, policyDecisionId, result: failed ? "failed" : "success",
      metadata: {
        resultHash,
        externalRequestId: externalId,
        durationMs: Date.now() - startedAt,
        approvalId: approval.approval?.approvalId || null,
        ruleVersion: governance.ruleVersion,
        principalFingerprint: governance.principalFingerprint,
        operationFingerprint: governance.operationFingerprint,
      },
    });
    metricOutcome = failed ? "error" : "success";
    if (entry.tool.name === "demo_create_followup_task") {
      const readiness = evaluateWealthTaskReadiness({
        taskId: "WM-GT-05",
        checks: {
          identity: readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已核验。"),
          policy: readinessCheck("READY", "FOLLOWUP_POLICY_APPLIED", "客户跟进写入策略已执行。"),
          capability: readinessCheck("READY", "FOLLOWUP_CAPABILITY_READY", "客户跟进写入能力已就绪。"),
          approval: approval.approval?.approvalId
            ? readinessCheck("READY", "HUMAN_CONFIRMATION_CONSUMED", "本次操作确认已绑定并消费。")
            : readinessCheck("BLOCKED", "HUMAN_CONFIRMATION_MISSING", "本次操作缺少有效确认。"),
          idempotency: idemKey
            ? readinessCheck("READY", "IDEMPOTENCY_RESERVED", "幂等键已绑定业务调用回执。")
            : readinessCheck("BLOCKED", "IDEMPOTENCY_KEY_MISSING", "写入缺少幂等保护。"),
          receipt: failed
            ? readinessCheck("BLOCKED", "BUSINESS_RECEIPT_FAILED", "下游业务执行失败，可根据回执安全重试。", { retryable: true })
            : readinessCheck("READY", "BUSINESS_RECEIPT_COMPLETED", "业务执行回执已生成。"),
          evidence: readinessCheck("READY", "EXECUTION_EVIDENCE_READY", "治理判断和执行证据已留痕。"),
        },
      });
      const contextReceipt = buildContextReceipt({
        taskId: "WM-GT-05",
        principalFingerprint: governance.principalFingerprint,
        provided: {
          knowledge: [],
          businessData: [],
          memory: [],
          capabilities: [{
            capabilityId: "demo_create_followup_task",
            label: "创建客户跟进任务（Demo）",
            version: SERVICE_VERSION,
            sideEffect: policy.sideEffect,
          }],
        },
        policyDecisions: [{
          decisionId: governance.decisionId,
          policyCode: governance.policyCode,
          ruleVersion: governance.ruleVersion,
          effect: governance.effect,
        }],
        capabilityExecutions: [{
          capabilityId: "demo_create_followup_task",
          label: "创建客户跟进任务（Demo）",
          operation: entry.tool.name,
          status: failed ? "failed" : "completed",
          requestId,
          ...(externalId ? { externalRequestId: externalId } : {}),
          ...(approval.approval?.approvalId ? { approvalId: approval.approval.approvalId } : {}),
          idempotencyProtected: Boolean(idemKey),
        }],
        readiness: {
          status: readiness.status,
          requestedOutcome: readiness.requestedOutcome,
          allowedOutcomes: readiness.allowedOutcomes,
          deniedOutcomes: readiness.deniedOutcomes,
          reasons: readiness.reasons,
          remediation: readiness.remediation,
          decisionFingerprint: readiness.decisionFingerprint,
        },
      });
      return attachContextReceipt(result, contextReceipt);
    }
    return result;
  } catch (error) {
    metricOutcome = "error";
    if (requestId && receiptReserved) {
      await completeEnterpriseMcpCall({
        requestId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: "ENTERPRISE_MCP_CALL_FAILED",
      }).catch(() => undefined);
      if (auditState) {
        await auditCall({
          phase: "completed",
          entry: auditState.entry,
          context,
          req,
          requestId,
          policyDecisionId: auditState.policyDecisionId,
          result: "failed",
          metadata: {
            argsHash: auditState.argsHash,
            sideEffect: auditState.sideEffect,
            identityMode: auditState.identityMode,
            tenantId: auditState.tenantId,
            errorCode: "ENTERPRISE_MCP_CALL_FAILED",
            durationMs: Date.now() - startedAt,
          },
        }).catch(() => undefined);
      }
    }
    return textResult(`企业连接器调用失败：${cleanError(error)}`, true);
  } finally {
    finishMetric(metricOutcome);
    const next = (activeCalls.get(context.adoptId) || 1) - 1;
    if (next <= 0) activeCalls.delete(context.adoptId);
    else activeCalls.set(context.adoptId, next);
  }
}

export async function executeEnterpriseMcpGatewayTool(input: {
  req: Request;
  adoptId: string;
  sessionId?: string | null;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  taskAuthorizationSnapshotId: string;
  approvalId?: string | null;
}) {
  const context = await runtimeContextForAdoptId(input.adoptId, input.sessionId);
  return await gatewayCall(
    context,
    enterpriseMcpGatewayToolName(input.serverId, input.toolName),
    input.arguments,
    input.req,
    {
      approvalId: input.approvalId || null,
      taskAuthorizationSnapshotId: input.taskAuthorizationSnapshotId,
      // This call originates after the EA route has validated task ownership,
      // immutable binding and durable execution state. It does not depend on a
      // remote Runtime hook to establish its local PEP.
      runtimeAttested: true,
      executionOrigin: "a2a_local_executor",
    },
  );
}

async function handleMessage(req: Request, message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const rpc = message as JsonRpcMessage;
  const id = rpc.id;
  if (rpc.method === "notifications/initialized") return null;
  if (rpc.method === "initialize") {
    return hasRequestId(id) ? ok(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
      instructions: "Organization-managed MCP tools governed by role, identity, policy, guardrails and durable audit receipts.",
    }) : null;
  }
  if (rpc.method === "ping") return hasRequestId(id) ? ok(id, {}) : null;
  if (rpc.method === "resources/list") return hasRequestId(id) ? ok(id, { resources: [] }) : null;
  if (rpc.method === "prompts/list") return hasRequestId(id) ? ok(id, { prompts: [] }) : null;
  if (rpc.method === "tools/list") {
    const adoptId = await trustedAdoptId(req);
    const entries = adoptId ? await exposedTools(await runtimeContext(req)) : await catalogTools();
    const tools = entries.map(entry => ({
      name: entry.exposedName,
      description: `[${entry.connection.displayName}] ${entry.tool.description || entry.tool.name}`.slice(0, 2_000),
      inputSchema: entry.tool.inputSchema || { type: "object", properties: {} },
      ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema } : {}),
      annotations: {
        ...(entry.tool.annotations || {}),
        readOnlyHint: ["read", "compute"].includes(entry.policy.sideEffect),
        destructiveHint: !["read", "compute"].includes(entry.policy.sideEffect),
      },
    }));
    return hasRequestId(id) ? ok(id, { tools }) : null;
  }
  if (rpc.method === "tools/call") {
    if (!hasRequestId(id)) return null;
    const context = await runtimeContext(req);
    const rawArguments = rpc.params?.arguments;
    const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : {};
    return ok(id, await gatewayCall(context, String(rpc.params?.name || ""), args, req));
  }
  return hasRequestId(id) ? err(id, -32601, `Method not found: ${String(rpc.method || "")}`) : null;
}

export function registerEnterpriseMcpGatewayRoutes(app: Express): void {
  app.get("/api/enterprise-mcp/.well-known/jwks.json", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
      res.json(await enterpriseMcpJwks());
    } catch (error) {
      res.status(503).json({ error: cleanError(error) });
    }
  });

  app.get("/api/internal/enterprise-mcp/health", async (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json({ error: "unauthorized" });
    res.json({ status: "ok", name: SERVICE_NAME, version: SERVICE_VERSION, identity: await enterpriseMcpIdentityStatus() });
  });

  app.get("/api/internal/enterprise-mcp/mcp", async (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    const adoptId = await trustedAdoptId(req);
    if (!adoptId) return res.status(400).json(err(null, -32001, "trusted Agent identity is missing"));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", `enterprise-mcp-${adoptId}`);
    res.flushHeaders?.();
    res.write(": enterprise MCP stream ready\n\n");
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => clearInterval(heartbeat));
  });

  app.delete("/api/internal/enterprise-mcp/mcp", (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    res.status(204).end();
  });

  app.post("/api/internal/enterprise-mcp/mcp", async (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    try {
      const body = req.body || {};
      const response = Array.isArray(body)
        ? (await Promise.all(body.map(item => handleMessage(req, item)))).filter(Boolean)
        : await handleMessage(req, body);
      if (!response || (Array.isArray(response) && response.length === 0)) return res.status(202).json({});
      const adoptId = await trustedAdoptId(req);
      if (adoptId) res.setHeader("Mcp-Session-Id", `enterprise-mcp-${adoptId}`);
      res.json(response);
    } catch (error) {
      res.status(200).json(err(req.body?.id, -32000, cleanError(error)));
    }
  });
}
