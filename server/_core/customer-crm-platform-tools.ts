import { createHash } from "node:crypto";
import type { Request } from "express";
import type { ClawAdoption } from "../../drizzle/schema";
import { canonicalPurposeIdForRoleTemplate } from "../../shared/memory-purpose";
import { getUserById } from "../db";
import { auditRequest, recordAuditRequired } from "./audit-events";
import {
  createConfiguredTwentyCustomerClient,
  evaluateTwentyCustomerWriteAccess,
  twentyCustomerContextProductionReady,
} from "./customer-context-twenty-access";
import { approvalRequiredToolResult, enforceGovernanceApproval } from "./governance/approval-service";
import { finalizeGovernanceDecision, governanceFingerprint } from "./governance/contracts";
import { resolveRuntimePrincipalV2 } from "./governance/principal";

const TOOL_NAME = "create_customer_followup_task";

export const CUSTOMER_CRM_PLATFORM_TOOLS = [{
  name: TOOL_NAME,
  description: [
    "Create a governed CRM follow-up task for a customer explicitly assigned to the current employee.",
    "Use only after the user asks to create the task. Public Demo customers without an active assignment are read-only.",
    "This write always requires one user confirmation and a stable idempotency_key.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      customer_id: { type: "string", description: "Canonical or governed source customer id returned by customer_directory." },
      objective: { type: "string", description: "Concrete follow-up task objective." },
      due_at: { type: "string", description: "ISO 8601 due date and time." },
      idempotency_key: { type: "string", description: "Stable key of at least 8 characters. Reuse unchanged after confirmation." },
    },
    required: ["customer_id", "objective", "due_at", "idempotency_key"],
  },
}] as const;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

function textResult(text: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], ...extra };
}

function enabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function customerCrmWritebackEnabled(): boolean {
  return enabled(process.env.EA_CUSTOMER_CRM_WRITEBACK_ENABLED);
}

export function isCustomerCrmPlatformTool(name: string): boolean {
  return name === TOOL_NAME;
}

function textArg(args: Record<string, unknown>, snake: string, camel: string, max: number): string {
  return String(args[snake] ?? args[camel] ?? "").trim().slice(0, max);
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40)}`;
}

function writeDeniedMessage(reasonCode: string): string {
  if (reasonCode === "CUSTOMER_NOT_ASSIGNED") return "该客户未明确分配给当前员工，只可查看，不能写入 CRM。";
  if (reasonCode === "PROFILE_NOT_ELIGIBLE") return "该客户没有当前岗位可使用的有效业务画像，不能写入 CRM。";
  if (reasonCode === "ROLE_NOT_SUPPORTED") return "当前岗位尚未启用客户跟进写入能力。";
  return "该客户不在当前员工可写范围内，不能写入 CRM。";
}

export async function handleCustomerCrmPlatformTool(input: {
  req: Request;
  name: string;
  args: Record<string, unknown>;
  adoption: ClawAdoption;
  adoptId: string;
  sessionId: string;
}): Promise<ToolResult> {
  if (input.name !== TOOL_NAME) return textResult("未知客户跟进工具。", { isError: true });
  if (!customerCrmWritebackEnabled() || !twentyCustomerContextProductionReady()) {
    return textResult("客户跟进写入尚未在当前环境启用。", { isError: true });
  }
  const customerId = textArg(input.args, "customer_id", "customerId", 128);
  const objective = textArg(input.args, "objective", "subject", 500);
  const rawDueAt = textArg(input.args, "due_at", "dueAt", 64);
  const dueTimestamp = Date.parse(rawDueAt);
  const idempotencyKey = textArg(input.args, "idempotency_key", "idempotencyKey", 191);
  if (!customerId) return textResult("客户编号不能为空。", { isError: true });
  if (objective.length < 2) return textResult("跟进目标至少需要 2 个字符。", { isError: true });
  if (!Number.isFinite(dueTimestamp)) return textResult("跟进截止时间必须是有效的 ISO 8601 时间。", { isError: true });
  if (idempotencyKey.length < 8) return textResult("idempotency_key 至少需要 8 个字符。", { isError: true });

  const user = await getUserById(Number(input.adoption.userId));
  if (!user) return textResult("当前用户身份不可用，请重新登录后重试。", { isError: true });
  const principalResolution = await resolveRuntimePrincipalV2({
    adoption: input.adoption,
    user,
    sessionId: input.sessionId,
  });
  if (!principalResolution.complete) {
    return textResult("当前岗位身份无法形成可验证授权快照。", { isError: true });
  }
  const principal = principalResolution.principal;
  const client = createConfiguredTwentyCustomerClient();
  const initialAccess = await evaluateTwentyCustomerWriteAccess({ client, principal, customerId });
  if (!initialAccess.allowed || !initialAccess.globalCustomerId || !initialAccess.assignmentKey) {
    return textResult(writeDeniedMessage(initialAccess.reasonCode), {
      isError: true,
      reasonCode: initialAccess.reasonCode,
      authorizationEvidenceId: initialAccess.authorizationEvidenceId,
    });
  }
  const dueAt = new Date(dueTimestamp).toISOString();
  const canonicalPayload = {
    globalCustomerId: initialAccess.globalCustomerId,
    objective,
    dueAt,
    idempotencyKey,
  };
  const operation = {
    capabilityId: "enterprise.crm",
    operation: "create_followup",
    sideEffect: "write" as const,
    resource: `customer:${initialAccess.globalCustomerId}`,
    payloadHash: governanceFingerprint(canonicalPayload),
  };
  const decision = finalizeGovernanceDecision({ principal, operation }, {
    effect: "REQUIRE_APPROVAL",
    policyCode: "EA_CUSTOMER_CRM_FOLLOWUP_WRITE_V1",
    ruleVersion: "customer-crm-followup-write-v1",
    reason: `将为本人负责的客户创建跟进任务：${objective}`,
    obligations: [
      { type: "APPROVAL", mode: "always" },
      { type: "IDEMPOTENCY_KEY" },
      { type: "AUDIT", level: "strong" },
    ],
  });
  const approvalId = textArg(input.args, "approval_id", "approvalId", 64)
    || header(input.req, "x-ea-approval-id");
  const approval = await enforceGovernanceApproval({
    decision,
    principal,
    operation,
    approvalId: approvalId || null,
    idempotencyKey,
  });
  if (approval.effect === "REQUIRE_APPROVAL") {
    return approvalRequiredToolResult({
      approvalId: approval.requirement.approvalId,
      expiresAt: approval.requirement.expiresAt,
      reason: approval.reason,
      policyCode: decision.policyCode,
      toolName: input.name,
      connectorName: "客户洞察",
    });
  }
  if (approval.effect === "DENY") return textResult(approval.reason, { isError: true });

  const executionAccess = await evaluateTwentyCustomerWriteAccess({ client, principal, customerId });
  if (
    !executionAccess.allowed ||
    executionAccess.globalCustomerId !== initialAccess.globalCustomerId ||
    !executionAccess.assignmentKey
  ) {
    return textResult("确认后客户服务关系已变化，本次写入已取消。", {
      isError: true,
      reasonCode: executionAccess.reasonCode,
      authorizationEvidenceId: executionAccess.authorizationEvidenceId,
    });
  }

  const identity = {
    organizationId: principal.organizationId,
    userId: principal.userId,
    adoptionId: principal.adoptionId,
    globalCustomerId: executionAccess.globalCustomerId,
    idempotencyKey,
  };
  const taskKey = stableId("crm_followup", identity);
  const workItemId = stableId("crmwi", identity);
  const executionReceiptId = stableId("crmex", { ...identity, operation: "create_followup" });
  const confirmedAt = new Date().toISOString();
  const actor = String(user.name || user.email || user.id).trim().slice(0, 128);
  await recordAuditRequired({
    action: "customer_crm.followup.write_authorized",
    result: "success",
    severity: "high",
    actorType: "agent",
    actorUserId: principal.userId,
    actorRole: principal.roleTemplate,
    targetType: "customer_followup_task",
    targetId: taskKey,
    workspaceId: principal.workspaceId,
    agentInstanceId: input.adoptId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName: input.name,
    policyCode: decision.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(input.req),
    metadata: {
      globalCustomerId: executionAccess.globalCustomerId,
      assignmentKey: executionAccess.assignmentKey,
      authorizationEvidenceId: executionAccess.authorizationEvidenceId,
      approvalId: approval.approval?.approvalId || approvalId,
      executionReceiptId,
    },
  });
  await client.writeFollowupTask({
    taskKey,
    globalCustomerId: executionAccess.globalCustomerId,
    workItemId,
    subject: objective,
    description: null,
    taskStatus: "open",
    dueAt,
    ownerPrincipalId: `${executionAccess.assignmentPrincipalType}:${executionAccess.assignmentPrincipalRef}`,
    ownerDisplayName: actor,
    purposeId: canonicalPurposeIdForRoleTemplate(principal.roleTemplate),
    organizationId: principal.organizationId,
    confirmedBy: actor,
    confirmedAt,
    executionReceiptId,
    lastIdempotencyKey: idempotencyKey,
    workStateUpdatedAt: confirmedAt,
  });
  const receipt = {
    schema: "ea.customer-crm-execution-receipt.v1",
    executionReceiptId,
    capabilityId: "enterprise.crm",
    operation: "create_followup",
    status: "completed",
    taskKey,
    globalCustomerId: executionAccess.globalCustomerId,
    assignmentKey: executionAccess.assignmentKey,
    authorizationEvidenceId: executionAccess.authorizationEvidenceId,
    approvalId: approval.approval?.approvalId || approvalId,
    idempotencyKey,
    confirmedBy: actor,
    confirmedAt,
  };
  await recordAuditRequired({
    action: "customer_crm.followup.written",
    result: "success",
    severity: "high",
    actorType: "agent",
    actorUserId: principal.userId,
    actorRole: principal.roleTemplate,
    targetType: "customer_followup_task",
    targetId: taskKey,
    workspaceId: principal.workspaceId,
    agentInstanceId: input.adoptId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName: input.name,
    policyCode: decision.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(input.req),
    metadata: receipt,
  });
  return textResult(`EA_CUSTOMER_CRM_EXECUTION_RECEIPT:${JSON.stringify(receipt)}`, {
    externalRequestId: taskKey,
    executionReceipt: receipt,
  });
}
