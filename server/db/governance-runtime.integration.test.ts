import "dotenv/config";
import { randomUUID } from "node:crypto";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDbConnection } from "./connection";
import {
  consumeGovernanceApproval,
  createGovernanceApproval,
  decideGovernanceApproval,
  expireGovernanceApprovals,
  getGovernanceApproval,
} from "./governance-approvals";
import { completeCustomMcpCall, reserveCustomMcpCall } from "./custom-mcp-receipts";

const runIntegration = process.env.RUN_DB_INTEGRATION_TESTS === "1";
const suite = runIntegration ? describe : describe.skip;
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const adoptId = `lgj-governance-${suffix}`;
let rawPool: Pool;

function approvalInput(index: number, activeBindingKey = `binding-${suffix}-${index}`) {
  return {
    approvalId: `apr_${randomUUID()}`,
    activeBindingKey,
    policyDecisionId: `pdec_${randomUUID()}`,
    policyCode: "EA_DB_INTEGRATION_TEST",
    ruleVersion: "test-v1",
    principalFingerprint: "a".repeat(64),
    userId: 7,
    adoptId,
    capabilityId: "custom.mcp",
    operation: "update_customer",
    resource: "custom-mcp:12",
    payloadHash: String(index).padStart(64, "b").slice(-64),
    idempotencyKey: `idem-${suffix}-${index}`,
    reason: "integration test",
    decisionReason: null,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    decidedBy: null,
    approvedAt: null,
    rejectedAt: null,
    consumedAt: null,
  };
}

suite("governance runtime database invariants", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for DB integration tests");
    rawPool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 2 });
    await rawPool.query("SELECT 1 FROM governance_approvals LIMIT 1");
    await rawPool.query("SELECT 1 FROM custom_mcp_call_receipts LIMIT 1");
  });

  afterEach(async () => {
    await rawPool.query("DELETE FROM governance_approvals WHERE adopt_id = ?", [adoptId]);
    await rawPool.query("DELETE FROM custom_mcp_call_receipts WHERE adopt_id = ?", [adoptId]);
  });

  afterAll(async () => {
    await closeDbConnection();
    await rawPool?.end();
  });

  it("keeps one active approval when concurrent requests race on the same binding", async () => {
    const binding = `binding-race-${suffix}`;
    const [first, second] = await Promise.all([
      createGovernanceApproval(approvalInput(1, binding)),
      createGovernanceApproval(approvalInput(2, binding)),
    ]);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.approval.approvalId).toBe(second.approval.approvalId);
    const [rows] = await rawPool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM governance_approvals WHERE adopt_id = ? AND active_binding_key = ?",
      [adoptId, binding],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("allows exactly one concurrent APPROVED to CONSUMED transition", async () => {
    const input = approvalInput(3);
    const created = await createGovernanceApproval(input);
    const approved = await decideGovernanceApproval({
      approvalId: created.approval.approvalId,
      userId: input.userId,
      adoptId,
      decision: "approved",
    });
    expect(approved?.status).toBe("approved");
    const binding = {
      approvalId: input.approvalId,
      principalFingerprint: input.principalFingerprint,
      userId: input.userId,
      adoptId,
      capabilityId: input.capabilityId,
      operation: input.operation,
      resource: input.resource,
      payloadHash: input.payloadHash,
      policyCode: input.policyCode,
      ruleVersion: input.ruleVersion,
    };
    const results = await Promise.all([
      consumeGovernanceApproval(binding),
      consumeGovernanceApproval(binding),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getGovernanceApproval(input.approvalId))?.status).toBe("consumed");
  });

  it("expires stale approvals and releases the active binding", async () => {
    const input = approvalInput(4);
    input.expiresAt = new Date(Date.now() - 2_000);
    await createGovernanceApproval(input);
    expect(await expireGovernanceApprovals()).toBeGreaterThanOrEqual(1);
    expect(await getGovernanceApproval(input.approvalId)).toMatchObject({
      status: "expired",
      activeBindingKey: null,
    });
  });

  it("deduplicates Custom MCP calls and detects key reuse with different arguments", async () => {
    const base = {
      requestId: `cmcp_${randomUUID()}`,
      policyDecisionId: `pdec_${randomUUID()}`,
      idempotencyKey: `idem-receipt-${suffix}`,
      connectionId: 12,
      toolName: "update_customer",
      userId: 7,
      adoptId,
      argsHash: "c".repeat(64),
    };
    const first = await reserveCustomMcpCall(base);
    const duplicate = await reserveCustomMcpCall({ ...base, requestId: `cmcp_${randomUUID()}` });
    const conflict = await reserveCustomMcpCall({
      ...base,
      requestId: `cmcp_${randomUUID()}`,
      argsHash: "d".repeat(64),
    });
    expect(first).toMatchObject({ reserved: true, conflict: false });
    expect(duplicate).toMatchObject({ reserved: false, conflict: false });
    expect(conflict).toMatchObject({ reserved: false, conflict: true });
    await completeCustomMcpCall({ requestId: base.requestId, status: "completed", resultHash: "e".repeat(64) });
    const [rows] = await rawPool.query<mysql.RowDataPacket[]>(
      "SELECT status, result_hash FROM custom_mcp_call_receipts WHERE request_id = ?",
      [base.requestId],
    );
    expect(rows[0]).toMatchObject({ status: "completed", result_hash: "e".repeat(64) });
  });

  it("fails closed when the database is unavailable", async () => {
    const previousUrl = process.env.DATABASE_URL;
    const previousTimeout = process.env.DB_CONNECT_TIMEOUT_MS;
    await closeDbConnection();
    process.env.DATABASE_URL = "mysql://invalid:invalid@127.0.0.1:1/unavailable";
    process.env.DB_CONNECT_TIMEOUT_MS = "1000";
    try {
      await expect(createGovernanceApproval(approvalInput(5))).rejects.toThrow("Database not available");
      await expect(reserveCustomMcpCall({
        requestId: `cmcp_${randomUUID()}`,
        policyDecisionId: `pdec_${randomUUID()}`,
        idempotencyKey: `idem-unavailable-${suffix}`,
        connectionId: 12,
        toolName: "update_customer",
        userId: 7,
        adoptId,
        argsHash: "f".repeat(64),
      })).rejects.toThrow("Database not available");
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousTimeout === undefined) delete process.env.DB_CONNECT_TIMEOUT_MS;
      else process.env.DB_CONNECT_TIMEOUT_MS = previousTimeout;
      await closeDbConnection();
    }
  });
});
