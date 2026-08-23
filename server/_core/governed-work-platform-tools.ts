import type { Request } from "express";
import type { ClawAdoption } from "../../drizzle/schema";
import { getUserById } from "../db";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { governedWorkView, transitionGovernedWorkItem } from "./governed-work-continuity";
import { approvalRequiredToolResult, enforceGovernanceApproval } from "./governance/approval-service";
import { attachContextReceipt } from "./governance/context-receipt";
import { finalizeGovernanceDecision, governanceFingerprint } from "./governance/contracts";
import { resolveRuntimePrincipalV2 } from "./governance/principal";

export const GOVERNED_WORK_PLATFORM_TOOLS = [
  {
    name: "list_governed_work_items",
    description: [
      "List user-confirmed decisions, open action items, and open questions for the current employee-agent scope.",
      "Use this when the user asks what remains to do, requests follow-up on a prior meeting, or refers to previously confirmed work.",
      "Do not infer work status again from meeting text; use the returned governed work state and its Context Receipt.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        include_closed: { type: "boolean", description: "Include done and cancelled items only when the user asks for history." },
      },
    },
  },
  {
    name: "update_governed_work_item",
    description: [
      "Update one confirmed governed work item after the user explicitly asks to start, complete, or cancel it.",
      "This is a governed write and always requires user confirmation before execution.",
      "Use the exact work_item_id returned by list_governed_work_items and keep the same idempotency_key after approval.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        work_item_id: { type: "string", description: "Governed work item id returned by list_governed_work_items." },
        operation: { type: "string", enum: ["start", "complete", "cancel"] },
        idempotency_key: { type: "string", description: "Stable key of at least 8 characters. Reuse unchanged after approval." },
      },
      required: ["work_item_id", "operation", "idempotency_key"],
    },
  },
] as const;

const GOVERNED_WORK_TOOL_NAMES = new Set(GOVERNED_WORK_PLATFORM_TOOLS.map(tool => tool.name));

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

function textResult(text: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], ...extra };
}
export function isGovernedWorkPlatformTool(name: string): boolean {
  return GOVERNED_WORK_TOOL_NAMES.has(name as typeof GOVERNED_WORK_PLATFORM_TOOLS[number]["name"]);
}

export async function handleGovernedWorkPlatformTool(input: {
  req: Request;
  name: string;
  args: Record<string, unknown>;
  adoption: ClawAdoption;
  adoptId: string;
  sessionId: string;
}): Promise<ToolResult> {
  const user = await getUserById(Number(input.adoption.userId));
  if (!user) return textResult("当前用户身份不可用，请重新登录后重试。", { isError: true });
  const principalV2 = await resolveRuntimePrincipalV2({
    adoption: input.adoption,
    user,
    sessionId: input.sessionId,
  });
  if (!principalV2.complete) return textResult("当前岗位身份无法形成可验证授权快照。", { isError: true });

  if (input.name === "list_governed_work_items") {
    const view = await governedWorkView({
      principal: principalV2.principal,
      includeClosed: input.args.include_closed === true || input.args.includeClosed === true,
    });
    const modelItems = view.items.filter(item => item.status !== "draft").map(item => ({
      workItemId: item.workItemId,
      type: item.type,
      subject: item.subject,
      owner: item.ownerDisplayName,
      dueAt: item.dueAt,
      status: item.status,
      version: item.version,
      confirmedAt: item.confirmation?.confirmedAt || null,
      relatedContext: item.relatedContext,
    }));
    return attachContextReceipt(textResult(`EA_GOVERNED_WORK_CONTEXT:${JSON.stringify({
      schema: "ea.governed-work-context.v1",
      status: modelItems.length ? "ready" : "empty",
      items: modelItems,
      instruction: "Only confirmed/open/in-progress items are enterprise work facts. Drafts are not formal work state.",
    })}`), view.receipt);
  }

  const workItemId = String(input.args.work_item_id || input.args.workItemId || "").trim();
  const workOperation = String(input.args.operation || "").trim() as "start" | "complete" | "cancel";
  const idempotencyKey = String(input.args.idempotency_key || input.args.idempotencyKey || "").trim().slice(0, 191);
  if (!/^gwk_[0-9a-f-]{36}$/i.test(workItemId)) return textResult("工作事项编号格式不正确。", { isError: true });
  if (!["start", "complete", "cancel"].includes(workOperation)) return textResult("operation 必须为 start、complete 或 cancel。", { isError: true });
  if (idempotencyKey.length < 8) return textResult("idempotency_key 至少需要 8 个字符。", { isError: true });
  const approvalOperation = {
    capabilityId: "grace.work_item",
    operation: workOperation,
    sideEffect: "write" as const,
    resource: `governed-work-item:${workItemId}`,
    payloadHash: governanceFingerprint({ workItemId, operation: workOperation }),
  };
  const decision = finalizeGovernanceDecision({ principal: principalV2.principal, operation: approvalOperation }, {
    effect: "REQUIRE_APPROVAL",
    policyCode: "EA_GOVERNED_WORK_CONFIRMATION_V1",
    ruleVersion: "governed-work-continuity-v1",
    reason: `工作事项状态将执行 ${workOperation}，需要你本人确认。`,
    obligations: [
      { type: "APPROVAL", mode: "always" },
      { type: "IDEMPOTENCY_KEY" },
      { type: "AUDIT", level: "strong" },
    ],
  });
  const approvalId = String(
    input.args.approval_id || input.args.approvalId || input.req.headers["x-ea-approval-id"] || "",
  ).trim() || null;
  const approval = await enforceGovernanceApproval({
    decision,
    principal: principalV2.principal,
    operation: approvalOperation,
    approvalId,
    idempotencyKey,
  });
  if (approval.effect === "REQUIRE_APPROVAL") {
    return approvalRequiredToolResult({
      approvalId: approval.requirement.approvalId,
      expiresAt: approval.requirement.expiresAt,
      reason: approval.reason,
      policyCode: decision.policyCode,
      toolName: input.name,
    });
  }
  if (approval.effect === "DENY") return textResult(approval.reason, { isError: true });
  const result = await transitionGovernedWorkItem({
    principal: principalV2.principal,
    workItemId,
    operation: workOperation,
    idempotencyKey,
    actor: String(user.name || user.email || user.id).slice(0, 128),
    approvalId: approval.approval?.approvalId || approvalId,
  });
  await recordAuditBestEffort({
    action: `work_continuity.item.${workOperation}`,
    result: "success",
    severity: "high",
    actorType: "agent",
    actorUserId: principalV2.principal.userId,
    actorRole: principalV2.principal.roleTemplate,
    targetType: "governed_work_item",
    targetId: workItemId,
    workspaceId: principalV2.principal.workspaceId,
    agentInstanceId: input.adoptId,
    runtimeAgentId: principalV2.principal.agentId,
    sessionId: principalV2.principal.sessionId,
    toolName: input.name,
    policyCode: decision.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(input.req),
    metadata: {
      executionReceiptId: result.executionReceipt.executionReceiptId,
      approvalId: result.executionReceipt.approvalId,
      toStatus: result.item.status,
      reused: result.reused,
    },
  });
  return attachContextReceipt(textResult(`EA_WORK_EXECUTION_RECEIPT:${JSON.stringify({
    item: result.item,
    executionReceipt: result.executionReceipt,
  })}`), result.contextReceipt);
}
