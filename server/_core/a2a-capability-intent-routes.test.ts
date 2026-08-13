import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  gatewayCalls: [] as Array<Record<string, unknown>>,
  reserveCalls: 0,
  claimCalls: 0,
  completed: [] as Array<Record<string, unknown>>,
  execution: null as Record<string, unknown> | null,
  gatewayResult: {} as Record<string, unknown>,
  intents: [] as Array<Record<string, unknown>>,
  taskAuthorizationSnapshotId: "authz_task_1",
}));

vi.mock("../db", () => ({
  getAgentTask: async () => ({
    id: "agt_12345678",
    adoptId: "lgj-owner",
    userId: 7,
    agentId: "expert-1",
    status: "succeeded",
    sourceSessionId: "session-1",
    requestContextJson: JSON.stringify({ taskAuthorizationSnapshotId: state.taskAuthorizationSnapshotId }),
    capabilityIntentsJson: JSON.stringify(state.intents),
  }),
  listA2ACapabilityIntentExecutions: async () => state.execution ? [state.execution] : [],
  getA2ACapabilityIntentExecution: async () => state.execution,
  reserveA2ACapabilityIntentExecution: async (input: Record<string, unknown>) => {
    state.reserveCalls += 1;
    if (!state.execution) state.execution = { ...input, status: "pending" };
    return { created: state.reserveCalls === 1, execution: state.execution };
  },
  claimA2ACapabilityIntentExecution: async (input: Record<string, unknown>) => {
    state.claimCalls += 1;
    if (state.execution?.status === "approval_required" && input.approvalId !== state.execution.approvalId) return false;
    if (state.execution) state.execution = { ...state.execution, status: "executing", approvalId: input.approvalId || null };
    return true;
  },
  completeA2ACapabilityIntentExecution: async (input: Record<string, unknown>) => {
    state.completed.push(input);
    state.execution = { ...(state.execution || {}), ...input };
    return state.execution;
  },
  getEnterpriseMcpConnection: async () => null,
  listEnterpriseMcpToolPolicies: async () => [],
}));

vi.mock("./helpers", () => ({
  requireClawOwner: async () => ({ userId: 7, adoptId: "lgj-owner", roleTemplate: "wealth-manager" }),
}));

vi.mock("./audit-events", () => ({
  auditActor: () => ({}),
  auditRequest: () => ({}),
  recordAuditRequired: async () => undefined,
}));

vi.mock("./enterprise-mcp-gateway", () => ({
  executeEnterpriseMcpGatewayTool: async (input: Record<string, unknown>) => {
    state.gatewayCalls.push(input);
    return state.gatewayResult;
  },
}));

import { registerA2ACapabilityIntentRoutes } from "./a2a-capability-intent-routes";

let server: ReturnType<express.Express["listen"]> | undefined;

async function startServer(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerA2ACapabilityIntentRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function followupIntent(operation = "create_followup") {
  return {
    schema: "ea.capability-intent.v1",
    intentId: "followup-demo-001",
    capabilityId: "enterprise.crm",
    operation,
    sideEffect: "write",
    arguments: {
      customer_ref: "张先生（Demo）",
      objective: "完成访后回访",
      due_at: "2026-08-20T09:00:00+08:00",
      priority: "medium",
    },
    idempotencyKey: "followup-demo-001",
  };
}

async function execute(base: string, approvalId?: string) {
  return await fetch(`${base}/api/claw/agent-tasks/agt_12345678/capability-intents/followup-demo-001/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adoptId: "lgj-owner", ...(approvalId ? { approvalId } : {}) }),
  });
}

beforeEach(() => {
  state.gatewayCalls = [];
  state.reserveCalls = 0;
  state.claimCalls = 0;
  state.completed = [];
  state.execution = null;
  state.gatewayResult = {};
  state.intents = [followupIntent()];
  state.taskAuthorizationSnapshotId = "authz_task_1";
});

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("A2A capability intent routes", () => {
  it("fails closed before the local gateway for an unregistered remote intent", async () => {
    state.intents = [followupIntent("delete_customer")];
    const response = await execute(await startServer());
    expect(response.status).toBe(422);
    expect(state.reserveCalls).toBe(0);
    expect(state.gatewayCalls).toHaveLength(0);
  });

  it("fails closed before reservation when the parent task has no durable authority snapshot", async () => {
    state.taskAuthorizationSnapshotId = "";
    const response = await execute(await startServer());
    expect(response.status).toBe(409);
    expect(state.reserveCalls).toBe(0);
    expect(state.gatewayCalls).toHaveLength(0);
  });

  it("persists an approval requirement without reporting the business action as executed", async () => {
    const approvalId = "apr_00000000-0000-4000-8000-000000000001";
    state.gatewayResult = {
      content: [{ type: "text", text: "需要确认" }],
      isError: true,
      _meta: { eaGovernance: { code: "EA_APPROVAL_REQUIRED", approvalId, expiresAt: "2026-08-20T09:00:00.000Z" } },
    };
    const response = await execute(await startServer());
    const body = await response.json() as { approvalRequired?: boolean; item?: { execution?: { status?: string } } };
    expect(response.status).toBe(202);
    expect(body.approvalRequired).toBe(true);
    expect(body.item?.execution?.status).toBe("approval_required");
    expect(state.completed.at(-1)).toMatchObject({ status: "approval_required", approvalId });
  });

  it("reuses the immutable task authority snapshot and exact approval for local execution", async () => {
    const approvalId = "apr_00000000-0000-4000-8000-000000000001";
    state.execution = {
      status: "approval_required",
      approvalId,
      intentFingerprint: "stored",
      payloadHash: "stored",
    };
    state.gatewayResult = {
      content: [{ type: "text", text: "客户跟进任务已创建" }],
      _meta: { recordId: "DEMO-FOLLOWUP-001" },
    };
    const response = await execute(await startServer(), approvalId);
    expect(response.status).toBe(200);
    expect(state.gatewayCalls).toHaveLength(1);
    expect(state.gatewayCalls[0]).toMatchObject({
      adoptId: "lgj-owner",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_followup_task",
      taskAuthorizationSnapshotId: "authz_task_1",
      approvalId,
    });
    expect(state.completed.at(-1)).toMatchObject({ status: "succeeded", externalRequestId: "DEMO-FOLLOWUP-001" });
  });
});
