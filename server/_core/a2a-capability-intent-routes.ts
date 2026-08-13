import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import {
  claimA2ACapabilityIntentExecution,
  completeA2ACapabilityIntentExecution,
  getA2ACapabilityIntentExecution,
  getAgentTask,
  getEnterpriseMcpConnection,
  listEnterpriseMcpToolPolicies,
  listA2ACapabilityIntentExecutions,
  reserveA2ACapabilityIntentExecution,
} from "../db";
import { collectA2ACapabilityIntents, type A2ACapabilityIntent } from "./a2a-capability-intent";
import {
  A2ACapabilityIntentBindingError,
  assertProductionA2ABindingRuntime,
  resolveA2ACapabilityIntentBinding,
  type ResolvedA2ACapabilityIntentBinding,
} from "./a2a-capability-intent-bindings";
import { auditActor, auditRequest, recordAuditRequired } from "./audit-events";
import { executeEnterpriseMcpGatewayTool } from "./enterprise-mcp-gateway";
import { governanceFingerprint } from "./governance/contracts";
import { requireClawOwner } from "./helpers";

const TASK_ID_RE = /^agt_[A-Za-z0-9]{8,64}$/;
const INTENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const APPROVAL_ID_RE = /^apr_[0-9a-f-]{36}$/i;

type GatewayResult = {
  content?: Array<{ type?: unknown; text?: unknown }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

function parseStoredIntents(task: Record<string, unknown>): A2ACapabilityIntent[] {
  const raw = task.capabilityIntentsJson ?? task.capability_intents_json;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    return collectA2ACapabilityIntents(JSON.parse(raw));
  } catch {
    return [];
  }
}

function taskAuthorizationSnapshotId(task: Record<string, unknown>): string {
  const raw = task.requestContextJson ?? task.request_context_json;
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return String(parsed.taskAuthorizationSnapshotId || "").trim().slice(0, 128);
  } catch {
    return "";
  }
}

function approvalRequirement(result: GatewayResult): {
  approvalId: string;
  expiresAt?: string;
  reason?: string;
} | null {
  const governance = result._meta?.eaGovernance;
  if (!governance || typeof governance !== "object") return null;
  const meta = governance as Record<string, unknown>;
  const approvalId = String(meta.approvalId || "").trim();
  if (meta.code !== "EA_APPROVAL_REQUIRED" || !APPROVAL_ID_RE.test(approvalId)) return null;
  return {
    approvalId,
    expiresAt: String(meta.expiresAt || "").trim() || undefined,
    reason: String(meta.reason || "").trim() || undefined,
  };
}

function resultText(result: GatewayResult): string {
  return (result.content || [])
    .filter(item => item?.type === "text")
    .map(item => String(item.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4_000);
}

function externalRequestId(result: GatewayResult): string | null {
  const meta = result._meta && typeof result._meta === "object" ? result._meta : {};
  const value = result.externalRequestId || result.external_request_id || result.recordId
    || meta.externalRequestId || meta.external_request_id || meta.recordId
    || result.requestId || result.request_id || meta.requestId || meta.request_id;
  return value ? String(value).slice(0, 128) : null;
}

function publicExecution(execution: Record<string, unknown> | null | undefined) {
  if (!execution) return null;
  return {
    executionId: execution.executionId,
    status: execution.status,
    approvalId: execution.approvalId,
    resultHash: execution.resultHash,
    externalRequestId: execution.externalRequestId,
    errorCode: execution.errorCode,
    errorMessage: execution.errorMessage,
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
  };
}

function publicIntent(
  intent: A2ACapabilityIntent,
  execution?: Record<string, unknown> | null,
) {
  try {
    const resolved = resolveA2ACapabilityIntentBinding(intent);
    return {
      ...intent,
      supported: true,
      actionName: resolved.binding.displayName,
      bindingId: resolved.binding.bindingId,
      bindingVersion: resolved.binding.bindingVersion,
      execution: publicExecution(execution),
    };
  } catch (error) {
    return {
      ...intent,
      supported: false,
      actionName: "未注册的业务动作",
      reason: error instanceof Error ? error.message : "该业务动作尚未接入平台治理执行器。",
      execution: publicExecution(execution),
    };
  }
}

async function ownedTask(req: Request, res: Parameters<typeof requireClawOwner>[1], adoptId: string, taskId: string) {
  const claw = await requireClawOwner(req, res, adoptId);
  if (!claw) return null;
  const task = await getAgentTask(taskId);
  if (!task || task.adoptId !== adoptId || Number(task.userId || 0) !== Number(claw.userId || 0)) {
    res.status(404).json({ error: "专家任务不存在" });
    return null;
  }
  return { claw, task: task as Record<string, unknown> };
}

async function resolveIntent(task: Record<string, unknown>, intentId: string): Promise<{
  intent: A2ACapabilityIntent;
  resolved: ResolvedA2ACapabilityIntentBinding;
}> {
  const intent = parseStoredIntents(task).find(item => item.intentId === intentId);
  if (!intent) throw new A2ACapabilityIntentBindingError("UNSUPPORTED_INTENT", "远端业务动作不存在或已失效。");
  const resolved = resolveA2ACapabilityIntentBinding(intent);
  if (resolved.binding.mode === "production") {
    const [connection, policies] = await Promise.all([
      getEnterpriseMcpConnection(resolved.binding.targetServerId),
      listEnterpriseMcpToolPolicies(resolved.binding.targetServerId),
    ]);
    assertProductionA2ABindingRuntime({
      binding: resolved.binding,
      connection,
      policy: policies.find(policy => policy.toolName === resolved.binding.targetToolName) || null,
    });
  }
  return { intent, resolved };
}

export function registerA2ACapabilityIntentRoutes(app: Express): void {
  app.get("/api/claw/agent-tasks/:taskId/capability-intents", async (req, res) => {
    const adoptId = String(req.query.adoptId || "").trim();
    const taskId = String(req.params.taskId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ error: "taskId invalid" });
    try {
      const owned = await ownedTask(req, res, adoptId, taskId);
      if (!owned) return;
      const executions = await listA2ACapabilityIntentExecutions(taskId, adoptId);
      const byIntent = new Map(executions.map(item => [item.intentId, item]));
      res.json({ items: parseStoredIntents(owned.task).map(intent => publicIntent(intent, byIntent.get(intent.intentId))) });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "业务动作状态暂时不可用" });
    }
  });

  app.post("/api/claw/agent-tasks/:taskId/capability-intents/:intentId/execute", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const taskId = String(req.params.taskId || "").trim();
    const intentId = String(req.params.intentId || "").trim();
    const approvalId = String(req.body?.approvalId || "").trim() || null;
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ error: "taskId invalid" });
    if (!INTENT_ID_RE.test(intentId)) return res.status(400).json({ error: "intentId invalid" });
    if (approvalId && !APPROVAL_ID_RE.test(approvalId)) return res.status(400).json({ error: "approvalId invalid" });

    let claimed = false;
    try {
      const owned = await ownedTask(req, res, adoptId, taskId);
      if (!owned) return;
      if (String(owned.task.status || "") !== "succeeded") {
        return res.status(409).json({ error: "专家任务尚未成功完成，不能执行其业务动作" });
      }
      const snapshotId = taskAuthorizationSnapshotId(owned.task);
      if (!snapshotId) {
        return res.status(409).json({ error: "原任务缺少可验证授权快照，已保持业务动作未执行" });
      }
      let intent: A2ACapabilityIntent;
      let resolved: ResolvedA2ACapabilityIntentBinding;
      try {
        ({ intent, resolved } = await resolveIntent(owned.task, intentId));
      } catch (error) {
        await recordAuditRequired({
          action: "a2a.capability_intent.execution_blocked",
          result: "denied",
          severity: "high",
          ...auditActor({ id: Number(owned.claw.userId), role: "user" }),
          ...auditRequest(req),
          targetType: "a2a_capability_intent",
          targetId: intentId,
          agentInstanceId: adoptId,
          runtimeAgentId: String(owned.task.agentId || ""),
          source: "a2a_capability_intent_executor",
          metadata: {
            taskId,
            errorCode: error instanceof A2ACapabilityIntentBindingError ? error.code : "INTENT_RESOLUTION_FAILED",
          },
        });
        throw error;
      }
      const executionId = `a2ax_${randomUUID()}`;
      const reservation = await reserveA2ACapabilityIntentExecution({
        executionId,
        taskId,
        intentId,
        intentFingerprint: intent.intentFingerprint,
        userId: Number(owned.claw.userId),
        adoptId,
        sourceAgentId: String(owned.task.agentId || ""),
        capabilityId: intent.capabilityId,
        operation: intent.operation,
        sideEffect: intent.sideEffect,
        bindingId: resolved.binding.bindingId,
        bindingVersion: resolved.binding.bindingVersion,
        targetServerId: resolved.binding.targetServerId,
        targetToolName: resolved.binding.targetToolName,
        payloadHash: resolved.payloadHash,
        idempotencyKey: resolved.idempotencyKey,
      });
      const current = reservation.execution;
      if (current.status === "succeeded") {
        return res.json({ item: publicIntent(intent, current), reused: true });
      }
      if (["failed", "blocked"].includes(current.status)) {
        return res.status(409).json({ error: "该业务动作已结束；如需重试，请让专家生成新的动作提案", item: publicIntent(intent, current) });
      }
      if (current.status === "approval_required" && !approvalId) {
        return res.status(202).json({ item: publicIntent(intent, current), approvalRequired: true });
      }
      claimed = await claimA2ACapabilityIntentExecution({ taskId, intentId, approvalId });
      if (!claimed) {
        const latest = await getA2ACapabilityIntentExecution(taskId, intentId);
        return res.status(409).json({ error: "该业务动作正在处理或确认编号不匹配", item: publicIntent(intent, latest) });
      }

      await recordAuditRequired({
        action: "a2a.capability_intent.execution_requested",
        result: "success",
        severity: "high",
        ...auditActor({ id: Number(owned.claw.userId), role: "user" }),
        ...auditRequest(req),
        targetType: "a2a_capability_intent",
        targetId: intent.intentId,
        agentInstanceId: adoptId,
        runtimeAgentId: String(owned.task.agentId || ""),
        source: "a2a_capability_intent_executor",
        metadata: {
          taskId,
          intentFingerprint: intent.intentFingerprint,
          bindingId: resolved.binding.bindingId,
          bindingVersion: resolved.binding.bindingVersion,
          targetServerId: resolved.binding.targetServerId,
          targetToolName: resolved.binding.targetToolName,
          payloadHash: resolved.payloadHash,
          taskAuthorizationSnapshotId: snapshotId,
        },
      });

      const gatewayResult = await executeEnterpriseMcpGatewayTool({
        req,
        adoptId,
        sessionId: String(owned.task.sourceSessionId || "") || null,
        serverId: resolved.binding.targetServerId,
        toolName: resolved.binding.targetToolName,
        arguments: resolved.arguments,
        taskAuthorizationSnapshotId: snapshotId,
        approvalId,
      }) as GatewayResult;
      const approval = approvalRequirement(gatewayResult);
      if (approval) {
        const execution = await completeA2ACapabilityIntentExecution({
          taskId,
          intentId,
          status: "approval_required",
          approvalId: approval.approvalId,
          errorCode: "APPROVAL_REQUIRED",
          errorMessage: approval.reason || resultText(gatewayResult),
        });
        return res.status(202).json({
          item: publicIntent(intent, execution),
          approvalRequired: true,
          approval: { ...approval, actionName: resolved.binding.displayName },
        });
      }

      const failed = gatewayResult.isError === true;
      const text = resultText(gatewayResult);
      const resultHash = governanceFingerprint(gatewayResult);
      const externalId = externalRequestId(gatewayResult);
      const execution = await completeA2ACapabilityIntentExecution({
        taskId,
        intentId,
        status: failed ? "blocked" : "succeeded",
        approvalId,
        resultHash,
        externalRequestId: externalId,
        errorCode: failed ? "GOVERNED_EXECUTION_DENIED" : null,
        errorMessage: failed ? text || "平台治理网关拒绝了该业务动作" : null,
      });
      await recordAuditRequired({
        action: "a2a.capability_intent.execution_completed",
        result: failed ? "denied" : "success",
        severity: failed ? "high" : "info",
        ...auditActor({ id: Number(owned.claw.userId), role: "user" }),
        ...auditRequest(req),
        targetType: "a2a_capability_intent",
        targetId: intent.intentId,
        agentInstanceId: adoptId,
        runtimeAgentId: String(owned.task.agentId || ""),
        source: "a2a_capability_intent_executor",
        metadata: { taskId, resultHash, externalRequestId: externalId, approvalId },
      });
      return res.status(failed ? 409 : 200).json({
        item: publicIntent(intent, execution),
        result: { text, externalRequestId: externalId },
      });
    } catch (error) {
      if (claimed) {
        await completeA2ACapabilityIntentExecution({
          taskId,
          intentId,
          status: "failed",
          approvalId,
          errorCode: "LOCAL_EXECUTOR_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      if (error instanceof A2ACapabilityIntentBindingError) {
        return res.status(422).json({ error: error.message, code: error.code });
      }
      return res.status(503).json({ error: error instanceof Error ? error.message : "业务动作执行暂时不可用" });
    }
  });
}
