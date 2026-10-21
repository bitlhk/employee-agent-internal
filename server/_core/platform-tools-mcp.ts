import { createHash } from "crypto";
import type { Express, Request, Response } from "express";
import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";
import type { SkillSource } from "../../shared/types/skill";
import { getClawByAdoptId, getUserById } from "../db";
import { forgetAgentMemory, listAgentMemoryView, rememberExplicitPreference } from "./agent-memory";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { COLLABORATION_GOAL_TOOLS, handleCollaborationGoalTool } from "./collaboration/goal-tools";
import { collaborationOperationId } from "./collaboration/operation-id";
import { COLLABORATION_PLATFORM_TOOLS, handleCollaborationTool } from "./collaboration/platform-tools";
import { collaborationScopeTools, scopedCollaborationForRequest, validateScopedTool } from "./collaboration/scope";
import { buildWealthAllocationTaskContextPack, finalizeWealthPolicyResolutionEvidence, observeWealthAllocationRuntimeSources, observeWealthPolicyRuntimeSource, resolveWealthAllocationRuntimeSources, resolveWealthPolicyRuntimeSource } from "./context-resolution/wealth-runtime-sources";
import { handleCustomerCrmPlatformTool, isCustomerCrmPlatformTool } from "./customer-crm-platform-tools";
import { customerProfileRequiredFieldIssue } from "./customer-profile-required-fields";
import { capabilitySetFingerprint } from "./governance/capability-registry";
import { attachContextReceipt, persistTrustedContextReceiptResult } from "./governance/context-receipt";
import { evaluateGovernance, principalFingerprint } from "./governance/contracts";
import { authorizePlatformMcpExecution } from "./governance/platform-mcp-execution-authority";
import { platformMcpPolicyAdapter } from "./governance/platform-mcp-policy";
import { resolveRuntimePrincipal, resolveRuntimePrincipalV2 } from "./governance/principal";
import { buildCapabilitySnapshot, buildTaskContextPack, buildTaskExecutionEnvelope } from "./governance/task-execution-envelope";
import { evaluateWealthTaskReadiness, readinessCheck, wealthPolicyKnowledgeReadiness } from "./governance/wealth-task-readiness";
import { GOVERNED_ROLE_POLICY_TOOLS, handleGovernedRolePolicyTool } from "./governed-role-policy-tools";
import { handleGovernedWorkPlatformTool, isGovernedWorkPlatformTool } from "./governed-work-platform-tools";
import { resolveRuntimeAgentId, resolveRuntimeWorkspaceByIds } from "./helpers";
import { callInternalMcpTool, parseInternalMcpJsonResult } from "./internal-mcp-client";
import { authorizeAndBindInternalRuntimeRequest } from "./internal-runtime-request";
import { internalMcpAudience } from "./internal-runtime-token";
import { registerMcpAgentAuthorizationRoute } from "./mcp-agent-authorization";
import { logError } from "./observability/logger";
import { beginMcpCall } from "./observability/metrics";
import { summarizePlatformAgents } from "./platform-agent-summary";
import { PLATFORM_TOOLS, PlatformIdentityError, SERVICE_NAME, SERVICE_VERSION, TOOL_NAMES, WealthAllocationDependencyError, customerSourceAgentId, err, hasRequestId, internalJson, isAuthorized, loadWealthAllocationDependency, ok, pathInside, pickHeader, requiredCustomerFieldsMessage, resolveAdoptId, textResult, wealthCustomerSourceId, type WealthAllocationDependency } from './platform-tools-support';
import { materializePostLoanRiskA2APayload } from "./post-loan-risk-a2a-contract";
import { executePostLoanRiskDataTool } from "./post-loan-risk-data-provider";
import { handlePostLoanRiskEscalationTool } from "./post-loan-risk-tool-handler";
import { runtimeGovernanceIsAttested, runtimeGovernanceRequestId } from "./runtime-governance-attestation";
import { CASCADE_PLATFORM_TOOLS, handleCascadeTool } from "./scheduling/cascade-tools";
import { SCHEDULING_PLATFORM_TOOLS, handleSchedulingTool } from "./scheduling/platform-tools";
import { readSkillValueEvaluationAllowedTools } from "./skill-value-evaluation-tool-scope";
import { skillInstaller } from "./skills/skill-installer";
import { skillRegistry } from "./skills/skill-registry";
import { parseSkillSourceDirectory, sanitizeSkillId } from "./skills/skill-source";
import { skillStoreRuntimeImportedDir } from "./skills/skill-store";
import { resolveToolGovernance, stableToolInputHash } from "./tool-governance";
import { prepareWealthAllocationContext } from "./wealth-allocation-context";
import { buildWealthAllocationContextReceipt, buildWealthPolicyContextReceipt } from "./wealth-context-receipts";
import { applyWealthDemoProductScenario, wealthDemoScenarioEnabled } from "./wealth-demo-scenario";
import { prepareWealthMaturityContext } from "./wealth-maturity-context";
import { wealthAllocationModelContent, wealthPolicyModelContent } from "./wealth-model-content";
import { resolveWealthPolicyBasis, resolveWealthSuitabilityPolicySource } from "./wealth-policy-source";
import { handleWealthPrevisitTool } from "./wealth-previsit-tool-handler";
import { callWealthProductSourceTool } from "./wealth-product-source-client";
import { resolveWealthRolePackReleaseEvidence, wealthRolePackReleaseReadiness } from "./wealth-role-pack-release";
export { PLATFORM_TOOLS,PlatformIdentityError,platformToolNames,resolvePlatformAdoptId } from './platform-tools-support';

async function callTool(
  req: Request,
  name: string,
  args: Record<string, unknown>,
  requestIdentity?: unknown,
): Promise<Record<string, unknown> & { isError?: boolean }> {
  const collaborationRun = await scopedCollaborationForRequest(req);
  if (collaborationRun) await validateScopedTool(collaborationRun, name, args);
  const evaluationAdoptId = pickHeader(req, ["x-jiuwen-channel-id", "x-agent-adopt-id"]);
  if (collaborationRun && evaluationAdoptId.startsWith("lgj-eval-")) {
    const evaluationTools = readSkillValueEvaluationAllowedTools(resolveRuntimeWorkspaceByIds(evaluationAdoptId, resolveRuntimeAgentId(evaluationAdoptId, pickHeader(req, ["x-linggan-agent-id"]))), "platform_tools");
    if (evaluationTools && !evaluationTools.has(name)) return textResult("本次评估未授权该工具", { isError: true });
  }
  let adoptId = "";
  try {
    adoptId = resolveAdoptId(req, args);
  } catch (error) {
    if (error instanceof PlatformIdentityError) {
      await recordAuditBestEffort({
        action: "platform.mcp.identity_mismatch",
        result: "denied",
        severity: "high",
        actorType: "agent",
        targetType: "claw_adoption",
        targetId: error.trustedAdoptId || null,
        toolName: name,
        source: "platform_tools_mcp",
        policyCode: "TRUSTED_AGENT_IDENTITY_REQUIRED",
        ...auditRequest(req),
        metadata: {
          trustedAdoptId: error.trustedAdoptId || null,
          requestedAdoptId: error.requestedAdoptId || null,
        },
      });
    }
    throw error;
  }
  if (!adoptId) return textResult("Error: adoptId is missing from JiuwenSwarm user context.", { isError: true });
  const claw = await getClawByAdoptId(adoptId);
  if (!claw || !["active", "expiring"].includes(String(claw.status || ""))) {
    return textResult("Error: employee agent is not active.", { isError: true });
  }
  const profile = resolveToolGovernance(`mcp_platform_tools_${name}`);
  const principal = resolveRuntimePrincipal({
    adoption: claw,
    sessionId: pickHeader(req, ["x-linggan-session-id", "x-jiuwen-session-id"]),
  });
  const operation = {
    capabilityId: "platform.mcp",
    operation: name,
    sideEffect: profile.sideEffect,
    resource: `platform-tool:${name}`,
    payloadHash: stableToolInputHash(args),
  } as const;
  const authority = await authorizePlatformMcpExecution({ req, adoption: claw, principal, operation });
  if (!authority.allowed) return textResult(authority.reason || "当前执行权限不可用。", { isError: true });
  const effectivePrincipal = authority.principal;
  const executionAuthority = authority.decision;
  const governance = await evaluateGovernance({
    principal: effectivePrincipal.principal,
    operation,
  }, [platformMcpPolicyAdapter({
    knownTool: TOOL_NAMES.has(name),
    profile,
    principal: effectivePrincipal,
    runtimeAttested: runtimeGovernanceIsAttested(runtimeGovernanceRequestId(req)),
  })], {
    effect: "DENY",
    policyCode: "EA_PLATFORM_MCP_POLICY_UNAVAILABLE",
    ruleVersion: "platform-mcp-v1",
    reason: "Platform MCP policy is unavailable.",
    obligations: [{ type: "AUDIT", level: "strong" }],
  });
  await recordAuditBestEffort({
    action: governance.effect === "ALLOW" ? "governance.platform_mcp.allowed" : "governance.platform_mcp.blocked",
    result: governance.effect === "ALLOW" ? "success" : "denied",
    severity: governance.effect === "ALLOW" ? "info" : "high",
    actorType: "agent",
    actorUserId: effectivePrincipal.principal.userId || null,
    actorRole: effectivePrincipal.principal.roleTemplate || null,
    targetType: "platform_tool",
    targetId: name,
    workspaceId: effectivePrincipal.principal.workspaceId || null,
    agentInstanceId: effectivePrincipal.principal.adoptionId || null,
    runtimeAgentId: effectivePrincipal.principal.agentId || null,
    sessionId: effectivePrincipal.principal.sessionId || null,
    toolName: name,
    policyCode: governance.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(req),
    metadata: {
      policyDecisionId: governance.decisionId,
      ruleVersion: governance.ruleVersion,
      principalFingerprint: governance.principalFingerprint,
      operationFingerprint: governance.operationFingerprint,
      capabilitySetFingerprint: capabilitySetFingerprint(),
      sideEffect: profile.sideEffect,
      executionAuthorityFingerprint: executionAuthority?.effectiveAuthorityFingerprint || null,
    },
  });
  if (governance.effect !== "ALLOW") return textResult(governance.reason, { isError: true });

  if (SCHEDULING_PLATFORM_TOOLS.some(tool => tool.name === name)) {
    const scopedPrepare = collaborationRun && ["prepare_personal_schedule_write", "prepare_meeting_reschedule"].includes(name);
    const operationId = scopedPrepare ? collaborationOperationId(collaborationRun.id, name, args.operationKey) : undefined;
    const { operationKey: _operationKey, ...scopedArgs } = args;
    const result = operationId ? await handleSchedulingTool(Number(claw.userId), name, scopedArgs, operationId) : await handleSchedulingTool(Number(claw.userId), name, args);
    if (collaborationRun && !result.isError) {
      const { watchPreparedCollaborationResource } = await import("./collaboration/watches");
      await watchPreparedCollaborationResource(collaborationRun, name, result);
    }
    return result;
  }
  if (CASCADE_PLATFORM_TOOLS.some(tool => tool.name === name)) {
    const result = await handleCascadeTool(Number(claw.userId), name, args);
    if (collaborationRun) {
      const { watchPreparedCollaborationResource } = await import("./collaboration/watches");
      await watchPreparedCollaborationResource(collaborationRun, name, result);
    }
    return result;
  }
  const collaborationContext = { sessionId: principal.principal.sessionId, run: collaborationRun || undefined, leaseToken: String(req.headers["x-ea-collaboration-capability"] || ""), authorizationSnapshotId: executionAuthority?.taskSnapshotId };
  if (COLLABORATION_GOAL_TOOLS.some(tool => tool.name === name)) return handleCollaborationGoalTool(Number(claw.userId), adoptId, name, args, collaborationContext);
  if (COLLABORATION_PLATFORM_TOOLS.some(tool => tool.name === name)) {
    return handleCollaborationTool(Number(claw.userId), adoptId, name, args, collaborationContext);
  }

  if (name === "remember_preference") {
    const content = String(args.content || "").trim();
    if (!content) return textResult("Error: content is required", { isError: true });
    const memory = await rememberExplicitPreference({
      adoptId,
      content,
      key: String(args.key || "").trim() || undefined,
      kind: ["preference", "instruction", "entity", "procedure"].includes(String(args.kind || ""))
        ? String(args.kind) as any
        : "preference",
      channel: pickHeader(req, ["x-jiuwen-channel-id", "x-openclaw-channel-id"]) || "conversation",
    });
    await recordAuditBestEffort({
      action: "memory.preference.remember",
      result: "success",
      severity: "info",
      actorType: "agent",
      targetType: "agent_memory",
      targetId: String(memory.id),
      agentInstanceId: adoptId,
      toolName: name,
      source: "platform_tools_mcp",
      ...auditRequest(req),
      metadata: { kind: memory.kind, scope: memory.scope },
    });
    return textResult(`EA_MEMORY_RECEIPT:${JSON.stringify({
      action: "remembered",
      id: memory.id,
      content: memory.content,
      kind: memory.kind,
      scope: memory.scope,
      status: memory.status,
    })}`);
  }

  if (name === "forget_preference") {
    const memoryId = Number(args.memory_id || args.memoryId || 0) || undefined;
    const query = String(args.query || args.content || "").trim() || undefined;
    if (!memoryId && !query) return textResult("Error: memory_id or query is required", { isError: true });
    const memory = await forgetAgentMemory({
      userId: Number(claw.userId),
      adoptId,
      id: memoryId,
      query,
    });
    await recordAuditBestEffort({
      action: "memory.preference.forget",
      result: "success",
      severity: "info",
      actorType: "agent",
      targetType: "agent_memory",
      targetId: String(memory.id),
      agentInstanceId: adoptId,
      toolName: name,
      source: "platform_tools_mcp",
      ...auditRequest(req),
    });
    return textResult(`EA_MEMORY_RECEIPT:${JSON.stringify({
      action: "forgotten",
      id: memory.id,
      content: memory.content,
      status: "forgotten",
    })}`);
  }

  if (name === "list_learned_preferences") {
    const view = await listAgentMemoryView({
      userId: Number(claw.userId),
      adoptId,
      adoptionId: Number(claw.id),
    });
    const active = view.items.filter((item) => item.status === "active");
    if (!active.length) return textResult("当前岗位还没有已生效的工作偏好。");
    return textResult([
      `当前岗位已学会 ${active.length} 条工作偏好：`,
      ...active.map((item) => `- [${item.id}] ${item.content}`),
    ].join("\n"));
  }

  if (isGovernedWorkPlatformTool(name)) return handleGovernedWorkPlatformTool({ req, name, args, adoption: claw, adoptId, sessionId: principal.principal.sessionId });
  if (isCustomerCrmPlatformTool(name)) return handleCustomerCrmPlatformTool({ req, name, args, adoption: claw, adoptId, sessionId: principal.principal.sessionId });

  if (name === "get_user_channels") {
    const channels = ["conversation"];
    try {
      const wxData: any = await internalJson(`/api/claw/weixin/status?adoptId=${encodeURIComponent(adoptId)}`);
      if (wxData?.bound) channels.push("weixin");
    } catch {}
    try {
      const notifyData: any = await internalJson(`/api/claw/notify/config?adoptId=${encodeURIComponent(adoptId)}`);
      const cfg = notifyData?.config || {};
      if (cfg.type === "wechat_work" && cfg.secretConfigured) channels.push("wecom");
      if (cfg.type === "feishu" && cfg.webhookConfigured) channels.push("feishu");
      if (cfg.type === "webhook" && cfg.webhookConfigured) channels.push("webhook");
    } catch {}
    return textResult(`Available channels: ${channels.join(", ")}`);
  }

  if (name === "list_available_agents") {
    const data = await internalJson(`/api/claw/agents/available?adoptId=${encodeURIComponent(adoptId)}`);
    return textResult(summarizePlatformAgents(data));
  }

  if (name === "evaluate_post_loan_risk_escalation") {
    return handlePostLoanRiskEscalationTool({
      req,
      args,
      adoptId,
      principal: effectivePrincipal.principal,
    });
  }

  if (GOVERNED_ROLE_POLICY_TOOLS.some((tool) => tool.name === name)) return handleGovernedRolePolicyTool({ req, name, args, adoptId, principal: effectivePrincipal.principal });

  if (name === "get_wealth_policy_basis") {
    const user = await getUserById(Number(claw.userId));
    if (!user) return textResult("当前用户身份不可用，请重新登录后重试。", { isError: true });
    const principalV2 = await resolveRuntimePrincipalV2({
      adoption: claw,
      user,
      sessionId: principal.principal.sessionId,
    });
    const policyRuntime = principalV2.complete
      ? await resolveWealthPolicyRuntimeSource(principalV2.principal)
      : undefined;
    const knowledgeSource = policyRuntime?.knowledgeSource;
    const basis = await resolveWealthPolicyBasis({
      userId: Number(user.id),
      groupId: Number(user.groupId || 0),
      actorRole: String(user.role || "user"),
      roleTemplate: principal.principal.roleTemplate,
      knowledgeSource,
    });
    const policyReady = basis.status === "ready" && Boolean(basis.selected);
    const releaseEvidence = await resolveWealthRolePackReleaseEvidence();
    const readiness = evaluateWealthTaskReadiness({
      taskId: "WM-GT-03",
      checks: {
        identity: principalV2.complete
          ? readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已就绪。")
          : readinessCheck("BLOCKED", "PRINCIPAL_V2_UNAVAILABLE", "当前岗位身份无法形成可验证授权快照。", { retryable: true }),
        knowledge: policyReady
          ? readinessCheck("READY", "CURRENT_POLICY_READY", "当前有效制度已通过知识资格校验。", { asOf: basis.evaluatedAt })
          : readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", basis.userMessage),
        policy: policyReady
          ? readinessCheck("READY", "POLICY_SOURCE_BOUND", "政策判断已绑定现行制度版本。")
          : readinessCheck("BLOCKED", "POLICY_SOURCE_UNAVAILABLE", "没有可用于正式判断的现行制度依据。"),
        evidence: basis.governance.eligibilityFingerprint
          ? readinessCheck("READY", "KNOWLEDGE_EVIDENCE_READY", "知识资格证据已生成。")
          : readinessCheck("BLOCKED", "KNOWLEDGE_EVIDENCE_MISSING", "知识资格证据缺失。"),
        release: wealthRolePackReleaseReadiness(releaseEvidence),
      },
    });
    const executionEnvelope = principalV2.complete ? buildTaskExecutionEnvelope({
      principal: principalV2.principal,
      context: buildTaskContextPack({
        ...(policyRuntime?.resolutionEvidence ? {
          resolution: finalizeWealthPolicyResolutionEvidence({
            evidence: policyRuntime.resolutionEvidence,
            ready: policyReady,
            reasonCode: basis.resolutionReasonCode,
          }),
        } : {}),
        knowledge: {
          selectedAssets: basis.selected ? [{
            assetId: basis.selected.sourceAssetId,
            version: basis.selected.versionLabel,
            contentHash: basis.selected.contentHash || "",
            effectiveAt: basis.selected.effectiveAt,
            ...(basis.sourceBinding || {}),
          }] : [],
          eligibilityFingerprint: basis.governance.eligibilityFingerprint,
        },
        businessData: { sources: [] },
        memory: { memoryRefs: [] },
        principalFingerprint: principalFingerprint(principalV2.principal),
        assembledAt: basis.evaluatedAt,
      }),
      readiness,
      capabilitySnapshot: buildCapabilitySnapshot({
        capabilityIds: ["get_wealth_policy_basis"],
        capabilityVersions: { get_wealth_policy_basis: "1" },
        sideEffectProfiles: { get_wealth_policy_basis: "read" },
        policyBindings: { get_wealth_policy_basis: ["EA_KNOWLEDGE_ELIGIBILITY_V1"] },
      }),
      releaseEvidence,
      correlationId: pickHeader(req, ["x-request-id", "x-correlation-id"]) || undefined,
    }) : null;
    const contextReceipt = executionEnvelope
      ? buildWealthPolicyContextReceipt({ envelope: executionEnvelope, basis, policyReady })
      : null;
    await recordAuditBestEffort({
      action: basis.status === "ready"
        ? "governance.wealth_policy_basis.selected"
        : "governance.wealth_policy_basis.unavailable",
      result: basis.status === "ready" ? "success" : "denied",
      severity: basis.status === "ready" ? "info" : "medium",
      actorType: "agent",
      actorUserId: Number(user.id),
      actorRole: principal.principal.roleTemplate,
      targetType: "wealth_policy_basis",
      targetId: basis.selected?.sourceAssetId || "unavailable",
      workspaceId: principal.principal.workspaceId || null,
      agentInstanceId: adoptId,
      runtimeAgentId: principal.principal.agentId,
      sessionId: principal.principal.sessionId,
      toolName: name,
      policyCode: "EA_KNOWLEDGE_ELIGIBILITY_V1",
      source: "platform_tools_mcp",
      ...auditRequest(req),
      metadata: {
        ruleVersion: "knowledge-eligibility-v1",
        policySourceVersion: basis.selected?.versionLabel || null,
        contextEligibilityFingerprint: basis.governance.eligibilityFingerprint,
        historicalVersionFiltered: basis.governance.historicalVersionFiltered,
        filteredForValidity: basis.governance.filteredForValidity,
        accessRestricted: basis.governance.accessRestricted,
      },
    });
    if (principalV2.complete) await observeWealthPolicyRuntimeSource({
      principal: principalV2.principal,
      knowledgeBaseId: basis.selected?.knowledgeBaseId,
      resourceRef: policyRuntime?.knowledgeSource.binding?.resourceRef,
    });
    const modelResult = textResult(
      `EA_WEALTH_POLICY_BASIS:${JSON.stringify(wealthPolicyModelContent(basis, readiness))}`,
      principalV2.complete ? {} : { isError: true },
    );
    return contextReceipt ? attachContextReceipt(modelResult, contextReceipt) : modelResult;
  }

  if (name === "prepare_wealth_previsit_context") {
    return handleWealthPrevisitTool({
      req,
      args,
      adoption: claw,
      adoptId,
      sessionId: principal.principal.sessionId,
    });
  }

  if (name === "prepare_wealth_maturity_context") {
    const boundedInteger = (value: unknown, fallback: number, maximum: number) => {
      const number = Math.floor(Number(value || fallback));
      return Number.isFinite(number) ? Math.min(maximum, Math.max(1, number)) : fallback;
    };
    const windowDays = boundedInteger(args.window_days || args.windowDays, 30, 90);
    const maxCustomers = boundedInteger(args.max_customers || args.maxCustomers, 20, 30);
    const maxItems = boundedInteger(args.max_items || args.maxItems, 30, 50);
    const customerEndpoint = String(process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp").trim();
    try {
      const result = await prepareWealthMaturityContext({
        roleTemplate: principal.principal.roleTemplate,
        request: { windowDays, maxCustomers, maxItems },
        dependencies: {
          listCustomers: async (query) => parseInternalMcpJsonResult(await callInternalMcpTool({
            endpointUrl: customerEndpoint,
            toolName: "wealth_assistant_customer_list",
            args: query,
            agentId: principal.principal.agentId,
            adoptId,
            sessionId: principal.principal.sessionId,
          })),
          loadCustomer: async (customerId) => parseInternalMcpJsonResult(await callInternalMcpTool({
            endpointUrl: customerEndpoint,
            toolName: "wealth_assistant_customer_detail",
            args: { customerId },
            agentId: principal.principal.agentId,
            adoptId,
            sessionId: principal.principal.sessionId,
          })),
        },
      });
      await recordAuditBestEffort({
        action: "governance.wealth_maturity_context.prepared",
        result: result.status === "unavailable" ? "failed" : "success",
        severity: result.status === "unavailable" ? "medium" : "info",
        actorType: "agent",
        actorUserId: principal.principal.userId || null,
        actorRole: principal.principal.roleTemplate,
        targetType: "wealth_maturity_context",
        targetId: stableToolInputHash({ windowDays, maxCustomers, maxItems }),
        workspaceId: principal.principal.workspaceId || null,
        agentInstanceId: adoptId,
        runtimeAgentId: principal.principal.agentId,
        sessionId: principal.principal.sessionId,
        toolName: name,
        policyCode: "EA_WEALTH_MATURITY_SCOPE_V1",
        source: "platform_tools_mcp",
        ...auditRequest(req),
        metadata: {
          windowDays,
          customersScanned: result.summary.customersScanned,
          customersFailed: result.summary.customersFailed,
          returnedItems: result.summary.returnedItems,
          truncated: result.summary.truncated,
          scope: result.evidence.scope,
        },
      });
      return textResult(`EA_WEALTH_MATURITY_CONTEXT:${JSON.stringify(result)}`, result.status === "unavailable" ? { isError: true } : {});
    } catch {
      return textResult(`EA_WEALTH_MATURITY_CONTEXT:${JSON.stringify({
        schema: "ea.wealth-maturity-context.v1",
        status: "unavailable",
        message: "客户数据服务暂时不可用，不能形成具体客户到期经营结论。可以先整理通用跟进检查表。",
      })}`, { isError: true });
    }
  }

  if (name === "prepare_wealth_allocation_context") {
    const customerId = String(args.customer_id || args.customerId || "").trim().slice(0, 128);
    if (!customerId) return textResult("需要先选择本人授权范围内的客户，再准备资产配置建议。", { isError: true });
    const optionalPositiveNumber = (value: unknown, maximum: number): number | null => {
      if (value === undefined || value === null || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number <= maximum ? number : null;
    };
    const amount = optionalPositiveNumber(args.amount, 10_000_000_000);
    const horizonMonths = optionalPositiveNumber(args.horizon_months || args.horizonMonths, 1_200);
    const channel = String(args.channel || "").trim().slice(0, 64);
    const keyword = String(args.keyword || "").trim().slice(0, 120);
    const productType = String(args.product_type || args.productType || "").trim().slice(0, 64);
    const allocationTaskId = String(args.task_id || args.taskId || "").trim() === "WM-GT-04" ? "WM-GT-04" : "WM-GT-02";
    const maxProducts = Math.min(20, Math.max(1, Math.floor(Number(args.max_products || args.maxProducts || 10)) || 10));
    const customerEndpoint = String(process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp").trim();
    const productEndpoint = String(process.env.WEALTH_PRODUCT_MCP_URL || "http://127.0.0.1:18007/mcp").trim();
    const readyDependencies = new Set<WealthAllocationDependency>();
    try {
      const user = await getUserById(Number(claw.userId));
      if (!user) throw new Error("当前用户身份不可用");
      const principalV2 = await resolveRuntimePrincipalV2({
        adoption: claw,
        user,
        sessionId: principal.principal.sessionId,
      });
      if (!principalV2.complete) {
        const readiness = evaluateWealthTaskReadiness({
          taskId: allocationTaskId,
          checks: {
            identity: readinessCheck("BLOCKED", "PRINCIPAL_V2_UNAVAILABLE", "当前岗位身份无法形成可验证授权快照。", { retryable: true }),
          },
        });
        return textResult(`EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify({
          schema: "ea.wealth-allocation-context.v1",
          status: "blocked",
          message: "当前岗位身份校验未完成，暂不能形成正式产品推荐。",
          readiness,
        })}`, { isError: true });
      }
      const runtimeSources = await resolveWealthAllocationRuntimeSources({
        taskId: allocationTaskId,
        principal: principalV2.principal,
        customerEndpoint,
        productEndpoint,
      });
      const { profileTarget, portfolioTarget, productTarget, knowledgeSource } = runtimeSources;
      const sourceCustomerId = await wealthCustomerSourceId({
        customerId,
        profileTarget,
        portfolioTarget,
      });
      const result = await prepareWealthAllocationContext({
        principal: principalV2.principal,
        request: {
          customerId,
          ...(sourceCustomerId === customerId ? {} : { sourceCustomerId }),
          amount,
          horizonMonths,
          channel,
          keyword,
          productType,
          maxProducts,
        },
        dependencies: {
          ...(profileTarget.endpointUrl === portfolioTarget.endpointUrl && profileTarget.toolName === portfolioTarget.toolName ? {
            loadCustomer: async (requestedCustomerId: string) => {
              const result = await loadWealthAllocationDependency("profile", readyDependencies, async () =>
                parseInternalMcpJsonResult(await callInternalMcpTool({
                  endpointUrl: portfolioTarget.endpointUrl,
                  toolName: portfolioTarget.toolName,
                  args: { customerId: requestedCustomerId },
                  agentId: customerSourceAgentId(
                    principalV2.principal,
                    portfolioTarget.toolName,
                  ),
                  adoptId,
                  sessionId: principal.principal.sessionId,
                })),
              );
              readyDependencies.add("portfolio");
              return result;
            },
          } : {
            loadCustomerProfile: async (requestedCustomerId: string) => loadWealthAllocationDependency(
              "profile",
              readyDependencies,
              async () => parseInternalMcpJsonResult(await callInternalMcpTool({
                endpointUrl: profileTarget.endpointUrl,
                toolName: profileTarget.toolName,
                args: profileTarget.toolName === "get_governed_customer_profile"
                  ? { customer_id: requestedCustomerId, task_id: allocationTaskId }
                  : { customerId: requestedCustomerId },
                agentId: customerSourceAgentId(
                  principalV2.principal,
                  profileTarget.toolName,
                ),
                adoptId,
                sessionId: principal.principal.sessionId,
              })),
            ),
            loadCustomerPortfolio: async (requestedCustomerId: string) => loadWealthAllocationDependency(
              "portfolio",
              readyDependencies,
              async () => parseInternalMcpJsonResult(await callInternalMcpTool({
                endpointUrl: portfolioTarget.endpointUrl,
                toolName: portfolioTarget.toolName,
                args: portfolioTarget.toolName === "get_customer_portfolio"
                  ? { customer_id: requestedCustomerId, task_id: allocationTaskId }
                  : { customerId: requestedCustomerId },
                agentId: customerSourceAgentId(
                  principalV2.principal,
                  portfolioTarget.toolName,
                ),
                adoptId,
                sessionId: principal.principal.sessionId,
              })),
            ),
          }),
          searchProducts: async (search) => loadWealthAllocationDependency(
            "products",
            readyDependencies,
            async () => {
              const payload = parseInternalMcpJsonResult(await callWealthProductSourceTool({
                endpointUrl: productTarget.endpointUrl,
                toolName: productTarget.toolName,
                args: {
                  keyword: search.keyword || undefined,
                  type: search.type || undefined,
                  page: 1,
                  pageSize: search.pageSize,
                },
                agentId: principal.principal.agentId,
                adoptId,
                sessionId: principal.principal.sessionId,
              }));
              return wealthDemoScenarioEnabled()
                ? applyWealthDemoProductScenario(payload)
                : payload;
            },
          ),
          resolvePolicySource: async () => loadWealthAllocationDependency(
            "policy",
            readyDependencies,
            async () => resolveWealthSuitabilityPolicySource({
              userId: Number(user.id),
              groupId: Number(user.groupId || 0),
              actorRole: String(user.role || "user"),
              roleTemplate: principal.principal.roleTemplate,
              knowledgeSource,
            }),
          ),
        },
      });
      const policyReady = result.policySource.ready && result.eligibleProducts.length > 0;
      const productDataReady = result.evidence.productDataAsOf.length > 0;
      const releaseEvidence = await resolveWealthRolePackReleaseEvidence();
      const readiness = evaluateWealthTaskReadiness({
        taskId: allocationTaskId,
        checks: {
          identity: readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已就绪。"),
          knowledge: wealthPolicyKnowledgeReadiness({
            policyReady: result.policySource.ready,
            resolutionStatus: knowledgeSource?.plan?.status,
          }),
          customerData: result.evidence.customerDataAsOf
            ? readinessCheck("READY", "CUSTOMER_DATA_READY", "客户数据已就绪。", { asOf: result.evidence.customerDataAsOf })
            : readinessCheck("BLOCKED", "CUSTOMER_DATA_STALE", "客户数据缺少有效时间，不能形成正式推荐。"),
          productData: productDataReady
            ? readinessCheck("READY", "PRODUCT_DATA_READY", "当前产品数据已就绪。", { asOf: result.evidence.productDataAsOf[0] })
            : readinessCheck("BLOCKED", "PRODUCT_DATA_UNAVAILABLE", "当前产品数据不可用。", { retryable: true }),
          policy: policyReady
            ? readinessCheck("READY", "SUITABILITY_POLICY_ALLOW", "存在通过适当性校验的产品候选。")
            : readinessCheck("BLOCKED", "SUITABILITY_POLICY_DENY", result.excludedProducts[0]?.reason || "没有产品通过当前适当性规则。"),
          skill: readinessCheck("READY", "WEALTH_ALLOCATION_SKILL_READY", "财富资产配置流程已就绪。"),
          capability: readinessCheck("READY", "WEALTH_CONTEXT_CAPABILITY_READY", "财富配置上下文能力已就绪。"),
          evidence: result.evidence.policyDecisionIds.length
            ? readinessCheck("READY", "POLICY_EVIDENCE_READY", "适当性判断证据已生成。")
            : readinessCheck("BLOCKED", "POLICY_EVIDENCE_MISSING", "适当性判断证据缺失。"),
          release: wealthRolePackReleaseReadiness(releaseEvidence),
        },
      });
      const executionEnvelope = buildTaskExecutionEnvelope({
        principal: principalV2.principal,
        context: buildWealthAllocationTaskContextPack({ sources: runtimeSources, result, principal: principalV2.principal }),
        readiness,
        capabilitySnapshot: buildCapabilitySnapshot({
          capabilityIds: ["prepare_wealth_allocation_context", "wealth_customer_mcp", "wealth_product_mcp"],
          capabilityVersions: { prepare_wealth_allocation_context: "1", wealth_customer_mcp: "1", wealth_product_mcp: "1" },
          sideEffectProfiles: { prepare_wealth_allocation_context: "read", wealth_customer_mcp: "read", wealth_product_mcp: "read" },
          policyBindings: { prepare_wealth_allocation_context: ["WEALTH_SUITABILITY_MATCH"] },
        }),
        releaseEvidence,
        correlationId: pickHeader(req, ["x-request-id", "x-correlation-id"]) || undefined,
      });
      const contextReceipt = buildWealthAllocationContextReceipt({ envelope: executionEnvelope, result });
      await recordAuditBestEffort({
        action: "governance.wealth_suitability.evaluated",
        result: result.status === "ready" ? "success" : "denied",
        severity: result.status === "ready" ? "info" : "medium",
        actorType: "agent",
        actorUserId: Number(user.id),
        actorRole: principal.principal.roleTemplate,
        targetType: "wealth_allocation_context",
        targetId: stableToolInputHash({ customerId }),
        agentInstanceId: adoptId,
        runtimeAgentId: principal.principal.agentId,
        sessionId: principal.principal.sessionId,
        toolName: name,
        policyCode: "WEALTH_SUITABILITY_MATCH",
        source: "platform_tools_mcp",
        ...auditRequest(req),
        metadata: {
          ruleVersion: result.evidence.ruleVersion,
          policySourceAssetId: result.policySource.sourceAssetId,
          policySourceVersion: result.policySource.versionLabel,
          contextEligibilityFingerprint: result.policySource.eligibilityFingerprint,
          policyDecisionIds: result.evidence.policyDecisionIds,
          eligibleProductCount: result.eligibleProducts.length,
          excludedProductCount: result.excludedProducts.length,
        },
      });
      await observeWealthAllocationRuntimeSources(
        runtimeSources,
        principalV2.principal,
        result.policySource.knowledgeBaseId,
      );
      return attachContextReceipt(
        textResult(`EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify(wealthAllocationModelContent(result, readiness))}`),
        contextReceipt,
      );
    } catch (error) {
      logError("wealth_allocation_context.failed", error, {
        adoptId,
        taskId: allocationTaskId,
        customerRef: stableToolInputHash({ customerId }),
      });
      const message = error instanceof Error ? error.message : String(error || "");
      const failedDependency = error instanceof WealthAllocationDependencyError
        ? error.dependency
        : null;
      const requiredFieldIssue = customerProfileRequiredFieldIssue(error);
      const requiredFieldMessage = requiredFieldIssue
        ? requiredCustomerFieldsMessage(requiredFieldIssue.labels)
        : "";
      const policyUnavailable = failedDependency === "policy" || /policy|制度|knowledge/i.test(message);
      const customerAssemblyFailed = /客户(?:画像|持仓|标识|\s*MCP)/i.test(message);
      const customerReady = readyDependencies.has("profile")
        && readyDependencies.has("portfolio")
        && !customerAssemblyFailed;
      const productReady = readyDependencies.has("products");
      const readiness = evaluateWealthTaskReadiness({
        taskId: allocationTaskId,
        checks: {
          identity: readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已就绪。"),
          knowledge: policyUnavailable
            ? readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", "当前有效适当性制度不可用。", { retryable: true })
            : readinessCheck("DEGRADED", "KNOWLEDGE_NOT_ASSEMBLED", "本轮未完成制度上下文装配。", { retryable: true }),
          customerData: requiredFieldIssue
            ? readinessCheck("BLOCKED", "CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING", requiredFieldMessage)
            : customerReady
            ? readinessCheck("READY", "CUSTOMER_DATA_READY", "客户画像与持仓数据已完成核验。")
            : failedDependency === "profile" || failedDependency === "portfolio" || customerAssemblyFailed
              ? readinessCheck("BLOCKED", "CUSTOMER_DATA_UNAVAILABLE", "当前客户数据不可用，不能形成正式推荐。", { retryable: true })
              : readinessCheck("DEGRADED", "CUSTOMER_DATA_NOT_EVALUATED", "本轮尚未完成客户数据核验。", { retryable: true }),
          productData: productReady
            ? readinessCheck("READY", "PRODUCT_DATA_READY", "当前产品数据已完成核验。")
            : failedDependency === "products"
              ? readinessCheck("BLOCKED", "PRODUCT_DATA_UNAVAILABLE", "当前产品数据不可用，不能形成正式推荐。", { retryable: true })
              : readinessCheck("DEGRADED", "PRODUCT_DATA_NOT_EVALUATED", "本轮尚未完成产品数据核验。", { retryable: true }),
          policy: readinessCheck("BLOCKED", "SUITABILITY_POLICY_NOT_EVALUATED", "适当性判断尚未完成。", { retryable: true }),
          skill: readinessCheck("READY", "WEALTH_ALLOCATION_SKILL_READY", "财富资产配置流程已就绪。"),
          capability: requiredFieldIssue
            ? readinessCheck("BLOCKED", "WEALTH_CONTEXT_INPUT_INCOMPLETE", "正式推荐所需客户信息尚未补齐。")
            : readinessCheck("DEGRADED", "WEALTH_CONTEXT_DEPENDENCY_FAILED", "财富配置上下文依赖暂时不可用。", { retryable: true }),
          evidence: readinessCheck("DEGRADED", "POLICY_EVIDENCE_PARTIAL", "本轮仅保留依赖失败证据。", { retryable: true }),
        },
      });
      return textResult(`EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify({
        schema: "ea.wealth-allocation-context.v1",
        status: "blocked",
        errorCode: requiredFieldIssue
          ? "CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"
          : policyUnavailable
            ? "POLICY_CONTEXT_UNAVAILABLE"
            : "BUSINESS_CONTEXT_UNAVAILABLE",
        message: requiredFieldIssue
          ? requiredFieldMessage
          : policyUnavailable
          ? "当前有效适当性制度不可用，暂不能形成正式产品推荐。"
          : "客户或产品数据服务暂时不可用，可以先完成不依赖当前产品的资产结构分析。",
        ...(requiredFieldIssue ? {
          missingFields: requiredFieldIssue.labels,
          remediation: "补齐上述客户信息后重新发起正式产品推荐。",
        } : {}),
        readiness,
      })}`);
    }
  }

  if (name === "submit_agent_task") {
    const agentId = String(args.agent_id || args.agentId || "").trim();
    const task = String(args.task || args.message || "").trim();
    if (!agentId) return textResult("Error: agent_id is required", { isError: true });
    if (!task) return textResult("Error: task is required", { isError: true });
    const suppliedSourceMessageId = String(args.source_message_id || args.sourceMessageId || "").trim();
    let governedPayload = args.governed_payload && typeof args.governed_payload === "object" && !Array.isArray(args.governed_payload)
      ? args.governed_payload
      : undefined;
    if (agentId === "risk-control-a2a" && governedPayload) {
      const materialized = materializePostLoanRiskA2APayload(
        governedPayload,
        (enterpriseId) => executePostLoanRiskDataTool(
          "get_post_loan_risk_snapshot",
          { unified_social_code: enterpriseId },
          principal.principal.roleTemplate,
        ).structuredContent,
      );
      if (!materialized.ok) {
        return textResult(`Error: ${materialized.reasonCode}: ${materialized.message}`, { isError: true });
      }
      governedPayload = materialized.value;
    }
    const sourceMessageId = suppliedSourceMessageId || `mcp:${createHash("sha256")
      .update(`${String(requestIdentity ?? "")}:${stableToolInputHash({ agentId, task, args })}`)
      .digest("hex")}`;
    const data: any = await internalJson("/api/claw/agent-tasks/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(executionAuthority?.taskSnapshotId
          ? { "X-EA-Authorization-Snapshot-Id": executionAuthority.taskSnapshotId }
          : {}),
      },
      body: JSON.stringify({
        adoptId,
        agentId,
        task,
        conversationId: args.conversation_id || args.conversationId,
        sessionId: args.session_id || args.sessionId,
        sourceMessageId,
        ...(governedPayload ? { dataPart: governedPayload } : {}),
      }),
    });
    return textResult(`Agent task submitted. task_id=${data.taskId}. EA will track the asynchronous result and write it back when complete.`);
  }

  if (name === "create_scheduled_task") {
    const runAt = String(args.run_at || args.runAt || "").trim();
    const cronExpr = String(args.cron_expr || args.cronExpr || "").trim();
    if (Boolean(runAt) === Boolean(cronExpr)) {
      return textResult("请且仅提供 run_at（单次任务）或 cron_expr（周期任务）中的一个。", { isError: true });
    }
    if (runAt) {
      const parsedRunAt = new Date(runAt);
      if (!Number.isFinite(parsedRunAt.getTime()) || !/(?:z|[+-]\d{2}:\d{2})$/i.test(runAt)) {
        return textResult("run_at 必须是包含时区的 ISO 8601 时间，例如 2026-08-13T14:00:00+08:00。", { isError: true });
      }
      if (parsedRunAt.getTime() <= Date.now()) {
        return textResult("run_at 必须晚于当前时间。", { isError: true });
      }
    }
    const deliveryChannel = String(args.delivery_channel || args.deliveryChannel || "conversation").trim();
    const channelId = deliveryChannel === "conversation" ? "web" : deliveryChannel === "weixin" ? "wechat" : deliveryChannel;
    const job = {
      name: String(args.name || "scheduled task"),
      description: String(args.message || "").slice(0, 100),
      enabled: true,
      schedule: runAt
        ? { kind: "once", runAt, display: runAt }
        : { kind: "cron", cronExpr, display: cronExpr },
      payload: { kind: "agentTurn", message: String(args.message || "") },
      sessionTarget: "isolated",
      delivery: {
        targets: [{
          channelId,
          channelLabel: channelId === "web" ? "定时任务记录" : channelId,
        }],
      },
      meta: {
        taskAuthorizationSnapshotId: executionAuthority?.taskSnapshotId,
        executionAuthorityFingerprint: executionAuthority?.effectiveAuthorityFingerprint,
      },
    };
    const suppliedKey = String(args.idempotency_key || args.idempotencyKey || "").trim();
    const idempotencyKey = suppliedKey || `mcp:${createHash("sha256")
      .update(`${String(requestIdentity ?? "")}:${JSON.stringify(args)}`)
      .digest("hex")}`;
    await internalJson("/api/claw/cron/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(executionAuthority?.taskSnapshotId
          ? { "X-EA-Authorization-Snapshot-Id": executionAuthority.taskSnapshotId }
          : {}),
      },
      body: JSON.stringify({ adoptId, job, idempotencyKey }),
    });
    const scheduleSummary = runAt ? `one-time: ${runAt}` : `recurring cron: ${cronExpr}`;
    return textResult(`Scheduled task "${job.name}" created. Schedule: ${scheduleSummary}, delivery: ${deliveryChannel}.`);
  }

  return textResult(`Unknown tool: ${name}`, { isError: true });
}
async function handleMessage(req: Request, msg: any) {
  if (!msg || typeof msg !== "object") return null;
  const id = msg.id;
  try {
    if (msg.method === "notifications/initialized") return null;
    if (msg.method === "initialize") {
      if (!hasRequestId(id)) return null;
      return ok(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
        instructions: "EA platform-control tools for scheduling, channel lookup, external Agent task submission, and governed employee-agent preference learning.",
      });
    }
    if (msg.method === "ping") return hasRequestId(id) ? ok(id, {}) : null;
    if (msg.method === "resources/list") return hasRequestId(id) ? ok(id, { resources: [] }) : null;
    if (msg.method === "prompts/list") return hasRequestId(id) ? ok(id, { prompts: [] }) : null;
    if (msg.method === "tools/list") {
      if (!hasRequestId(id)) return null;
      const adoptId = resolveAdoptId(req, {});
      const runtimeAgentId = resolveRuntimeAgentId(
        adoptId,
        pickHeader(req, ["x-linggan-agent-id"]),
      );
      const allowedTools = adoptId.startsWith("lgj-eval-")
        ? readSkillValueEvaluationAllowedTools(
            resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId),
            "platform_tools",
          )
        : null;
      const collaborationRun = await scopedCollaborationForRequest(req);
      const scopedTools = collaborationRun ? new Set([...collaborationScopeTools(collaborationRun.taskType)].filter(name => !allowedTools || allowedTools.has(name))) : allowedTools;
      const tools = scopedTools
        ? PLATFORM_TOOLS.filter(tool => scopedTools.has(tool.name))
        : PLATFORM_TOOLS;
      return ok(id, { tools: collaborationRun ? tools.map(tool => ["prepare_personal_schedule_write", "prepare_meeting_reschedule"].includes(tool.name) ? { ...tool, description: `${tool.description} In this isolated execution a stable UUID operationKey is required. Reuse it for retries; use a new key only for a new proposal.`, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, operationKey: { type: "string", format: "uuid" } }, required: [...(("required" in tool.inputSchema ? tool.inputSchema.required : []) || []), "operationKey"] } } : tool) : tools });
    }
    if (msg.method === "tools/call") {
      if (!hasRequestId(id)) return null;
      const finishMetric = beginMcpCall("platform");
      try {
        const result = await callTool(
          req,
          String(msg.params?.name || ""),
          msg.params?.arguments || {},
          id,
        );
        await persistTrustedContextReceiptResult({ result, sessionId: pickHeader(req, ["x-linggan-session-id", "x-jiuwen-session-id"]), adoptionId: pickHeader(req, ["x-agent-adopt-id", "x-workforce-agent-adopt-id", "x-jiuwen-channel-id", "x-openclaw-channel-id"]), runtimeAgentId: pickHeader(req, ["x-linggan-agent-id"]), toolName: String(msg.params?.name || "") }).catch(() => false);
        finishMetric(result.isError === true ? "error" : "success");
        return ok(id, result);
      } catch (error) {
        finishMetric("error");
        if (pickHeader(req, ["x-ea-collaboration-run-id"])) await recordAuditBestEffort({ action: "collaboration.tool.failed", actorType: "agent", targetType: "collaboration_run", targetId: pickHeader(req, ["x-ea-collaboration-run-id"]), result: "failed", toolName: String(msg.params?.name || ""), metadata: { reason: error instanceof Error ? error.message.slice(0, 600) : "Tool failed" } });
        throw error;
      }
    }
    return hasRequestId(id) ? err(id, -32601, `Method not found: ${msg.method}`) : null;
  } catch (error: any) {
    return hasRequestId(id) ? err(id, -32000, error?.message || String(error)) : null;
  }
}

export function registerPlatformToolsMcpRoutes(app: Express): void {
  const internalPlatformAudience = internalMcpAudience("/api/internal/platform-tools/mcp");
  app.get("/api/internal/platform-tools/health", (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ status: "ok", name: SERVICE_NAME, version: SERVICE_VERSION });
  });

  registerMcpAgentAuthorizationRoute(app);

  app.post("/api/internal/platform-tools/skills/register-runtime", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const adoptId = String(body.adoptId || body.adopt_id || "").trim();
      const rawRuntimePath = String(body.runtimePath || body.runtime_path || "").trim();
      const requestedSkillId = sanitizeSkillId(String(body.skillId || body.skill_id || path.basename(rawRuntimePath) || ""));
      if (!adoptId || !rawRuntimePath || !requestedSkillId) {
        res.status(400).json({ error: "adoptId, skillId and runtimePath required" });
        return;
      }
      const claw = await getClawByAdoptId(adoptId).catch(() => null);
      if (!claw) {
        res.status(404).json({ error: "agent not found" });
        return;
      }
      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const workspaceDir = resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId);
      const runtimePath = path.resolve(rawRuntimePath);
      const expectedSkillsRoot = path.join(workspaceDir, "skills");
      if (!pathInside(runtimePath, expectedSkillsRoot)) {
        res.status(400).json({ error: "runtimePath is outside agent skills workspace" });
        return;
      }
      if (!existsSync(path.join(runtimePath, "SKILL.md"))) {
        res.status(400).json({ error: "runtime skill is missing SKILL.md" });
        return;
      }

      const parsed = parseSkillSourceDirectory(runtimePath, requestedSkillId);
      const skillId = parsed.skillId || requestedSkillId;
      const existing = await skillRegistry.listSkills(adoptId);
      if (existing.ok) {
        const registered = existing.value.find((skill) => skill.id === skillId || skill.id === requestedSkillId);
        if (registered && registered.source.kind !== "runtime_imported") {
          res.json({
            ok: true,
            skipped: true,
            reason: "skill already managed by registry",
            skillId: registered.id,
            sourceKind: registered.source.kind,
            sourcePath: registered.source.sourcePath || null,
            runtimePath,
          });
          return;
        }
      }

      const sourceDir = skillStoreRuntimeImportedDir(adoptId, skillId);
      if (existsSync(sourceDir)) rmSync(sourceDir, { recursive: true, force: true });
      mkdirSync(path.dirname(sourceDir), { recursive: true });
      await skillInstaller.installFromSource(runtimePath, sourceDir);

      const source: SkillSource = {
        kind: "runtime_imported",
        skillId,
        displayName: parsed.displayName || skillId,
        description: parsed.description || "运行时导入的个人技能",
        sourcePath: sourceDir,
        version: String(parsed.manifest?.version || ""),
      };
      const installed = await skillRegistry.install(adoptId, source);
      if (!installed.ok) {
        res.status(500).json({ error: installed.error.detail, kind: installed.error.kind });
        return;
      }
      await skillRegistry.updateScan(adoptId, skillId, {
        warnings: parsed.warnings,
        scannedAt: new Date().toISOString(),
      });
      res.json({ ok: true, skillId, sourcePath: sourceDir, runtimePath });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || "register runtime skill failed") });
    }
  });

  app.get("/api/internal/platform-tools/mcp", async (req: Request, res: Response) => {
    if (!await authorizeAndBindInternalRuntimeRequest(req, internalPlatformAudience)) {
      res.status(401).json(err(null, -32001, "unauthorized"));
      return;
    }
    const sessionId = `platform-tools-${resolveAdoptId(req, {}) || "unknown"}`;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", sessionId);
    res.flushHeaders?.();
    res.write(": platform-tools stream ready\n\n");

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
    });
  });

  app.delete("/api/internal/platform-tools/mcp", async (req: Request, res: Response) => {
    if (!await authorizeAndBindInternalRuntimeRequest(req, internalPlatformAudience)) {
      res.status(401).json(err(null, -32001, "unauthorized"));
      return;
    }
    res.status(204).end();
  });

  app.post("/api/internal/platform-tools/mcp", async (req: Request, res: Response) => {
    if (!await authorizeAndBindInternalRuntimeRequest(req, internalPlatformAudience)) {
      res.status(401).json(err(null, -32001, "unauthorized"));
      return;
    }
    const body = req.body || {};
    const response = Array.isArray(body)
      ? (await Promise.all(body.map((item) => handleMessage(req, item)))).filter(Boolean)
      : await handleMessage(req, body);
    if (!response || (Array.isArray(response) && response.length === 0)) {
      res.status(202).json({});
      return;
    }
    res.setHeader("Mcp-Session-Id", `platform-tools-${resolveAdoptId(req, {}) || "unknown"}`);
    res.json(response);
  });
}
