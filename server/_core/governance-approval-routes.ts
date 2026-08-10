import { createHash } from "node:crypto";
import type { Express } from "express";
import {
  getClawByAdoptId,
  getCustomMcpCallReceiptByApprovalId,
  getCustomMcpConnection,
  getEnterpriseMcpCallReceiptByApprovalId,
  getEnterpriseMcpConnection,
  getGovernanceApproval,
  getGovernanceDemoBusinessRecord,
  getUserById,
  listGovernanceApprovals,
} from "../db";
import { auditActor, auditRequest, recordAuditBestEffort, recordAuditRequired } from "./audit-events";
import { requireClawOwner } from "./helpers";
import { decideApproval } from "./governance/approval-service";

const APPROVAL_ID_RE = /^apr_[0-9a-f-]{36}$/i;
type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

function publicApproval(item: Awaited<ReturnType<typeof listGovernanceApprovals>>[number]) {
  return {
    approvalId: item.approvalId,
    status: item.status,
    policyCode: item.policyCode,
    ruleVersion: item.ruleVersion,
    capabilityId: item.capabilityId,
    operation: item.operation,
    resource: item.resource,
    reason: item.reason,
    decisionReason: item.decisionReason,
    expiresAt: item.expiresAt,
    approvedAt: item.approvedAt,
    rejectedAt: item.rejectedAt,
    consumedAt: item.consumedAt,
    createdAt: item.createdAt,
  };
}

function fingerprint(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function publicReceipt(receipt: Awaited<ReturnType<typeof getCustomMcpCallReceiptByApprovalId>> | Awaited<ReturnType<typeof getEnterpriseMcpCallReceiptByApprovalId>>) {
  if (!receipt) return null;
  return {
    requestId: receipt.requestId,
    status: receipt.status,
    toolName: receipt.toolName,
    idempotencyFingerprint: fingerprint(receipt.idempotencyKey),
    argsHash: receipt.argsHash,
    resultHash: receipt.resultHash,
    externalRequestId: receipt.externalRequestId,
    durationMs: receipt.durationMs,
    errorCode: receipt.errorCode,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

export function registerGovernanceApprovalRoutes(app: Express): void {
  app.get("/api/claw/governance/approvals", async (req, res) => {
    const adoptId = String(req.query.adoptId || "").trim();
    const claw = await requireClawOwner(req, res, adoptId);
    if (!claw) return;
    const requested = String(req.query.status || "pending,approved").split(",").map(item => item.trim());
    const allowed = new Set<string>(["pending", "approved", "rejected", "consumed", "expired"]);
    const statuses = requested.filter((item): item is ApprovalStatus => allowed.has(item));
    const items = await listGovernanceApprovals({
      userId: Number(claw.userId),
      adoptId,
      statuses: statuses.length ? statuses : ["pending", "approved"],
    });
    res.json({ items: items.map(publicApproval) });
  });

  app.get("/api/claw/governance/approvals/:approvalId/evidence", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const approvalId = String(req.params.approvalId || "").trim();
      if (!APPROVAL_ID_RE.test(approvalId)) return res.status(400).json({ error: "确认编号格式不正确" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const approval = await getGovernanceApproval(approvalId);
      if (!approval || approval.userId !== Number(claw.userId) || approval.adoptId !== adoptId) {
        return res.status(404).json({ error: "执行依据不存在" });
      }
      const [user, adoption, customReceipt, enterpriseReceipt] = await Promise.all([
        getUserById(Number(claw.userId)),
        getClawByAdoptId(adoptId),
        getCustomMcpCallReceiptByApprovalId(approvalId),
        getEnterpriseMcpCallReceiptByApprovalId(approvalId),
      ]);
      const receipt = enterpriseReceipt || customReceipt;
      const enterpriseConnection = enterpriseReceipt
        ? await getEnterpriseMcpConnection(enterpriseReceipt.serverId)
        : null;
      const customConnection = customReceipt
        ? await getCustomMcpConnection({
            id: customReceipt.connectionId,
            adoptId,
            userId: Number(claw.userId),
          })
        : null;
      const externalRequestId = receipt?.externalRequestId || null;
      const demoRecord = externalRequestId?.startsWith("DEMO-")
        ? await getGovernanceDemoBusinessRecord(externalRequestId)
        : null;
      res.json({
        item: {
          approval: publicApproval(approval),
          identity: {
            user: user?.name || user?.email || `user:${approval.userId}`,
            roleKey: adoption?.roleTemplate || null,
            adoptionId: approval.adoptId,
            agentId: adoption?.agentId || null,
            permissionProfile: adoption?.permissionProfile || null,
            workspace: `岗位工作空间 · ${approval.adoptId}`,
          },
          decision: {
            policyCode: approval.policyCode,
            ruleVersion: approval.ruleVersion,
            principalFingerprint: approval.principalFingerprint,
            payloadFingerprint: approval.payloadHash,
            capabilityId: approval.capabilityId,
            operation: approval.operation,
            resource: approval.resource,
            reason: approval.reason,
          },
          confirmation: {
            status: approval.status,
            decidedBy: approval.decidedBy === approval.userId ? "当前操作人" : approval.decidedBy ? `user:${approval.decidedBy}` : null,
            approvedAt: approval.approvedAt,
            rejectedAt: approval.rejectedAt,
            consumedAt: approval.consumedAt,
            expiresAt: approval.expiresAt,
          },
          connector: {
            name: enterpriseConnection?.displayName || customConnection?.displayName || null,
            type: enterpriseReceipt ? "enterprise_mcp" : customReceipt ? "custom_mcp" : null,
            demo: Boolean(demoRecord || enterpriseReceipt?.serverId === "wealth_governance_demo"),
          },
          receipt: publicReceipt(receipt),
          businessOutcome: demoRecord ? {
            recordId: demoRecord.recordId,
            status: demoRecord.status,
            customerRef: demoRecord.customerRef,
            createdAt: demoRecord.createdAt,
            demo: true,
          } : null,
        },
      });
    } catch {
      if (!res.headersSent) res.status(503).json({ error: "执行依据暂时不可用" });
    }
  });

  app.post("/api/claw/governance/approvals/:approvalId/decision", async (req, res) => {
    try {
    const adoptId = String(req.body?.adoptId || "").trim();
    const approvalId = String(req.params.approvalId || "").trim();
    if (!APPROVAL_ID_RE.test(approvalId)) return res.status(400).json({ error: "确认编号格式不正确" });
    const claw = await requireClawOwner(req, res, adoptId);
    if (!claw) return;
    const rawDecision = String(req.body?.decision || "").trim().toLowerCase();
    if (rawDecision !== "approved" && rawDecision !== "rejected") {
      return res.status(400).json({ error: "decision 必须为 approved 或 rejected" });
    }
    const existing = await getGovernanceApproval(approvalId);
    if (
      !existing
      || existing.userId !== Number(claw.userId)
      || existing.adoptId !== adoptId
      || existing.status !== "pending"
      || existing.expiresAt.getTime() <= Date.now()
    ) {
      return res.status(409).json({ error: "确认请求不存在、已处理或已过期" });
    }
    const auditBase = {
      ...auditActor({ id: Number(claw.userId), role: "user" }),
      ...auditRequest(req),
      targetType: "governance_approval",
      targetId: approvalId,
      agentInstanceId: adoptId,
      policyCode: existing.policyCode,
      source: "governance_approval_api",
      metadata: {
        requestedDecision: rawDecision,
        policyDecisionId: existing.policyDecisionId,
        ruleVersion: existing.ruleVersion,
        principalFingerprint: existing.principalFingerprint,
        capabilityId: existing.capabilityId,
        operation: existing.operation,
      },
    } as const;
    await recordAuditRequired({
      action: "governance.approval.decision_requested",
      result: "success",
      severity: "high",
      ...auditBase,
    });
    const item = await decideApproval({
      approvalId,
      userId: Number(claw.userId),
      adoptId,
      decision: rawDecision,
      reason: String(req.body?.reason || "").trim().slice(0, 1000) || null,
    });
    if (!item) return res.status(409).json({ error: "确认请求不存在、已处理或已过期" });
    await recordAuditBestEffort({
      action: "governance.approval.decision_completed",
      result: "success",
      severity: rawDecision === "approved" ? "high" : "info",
      ...auditBase,
      metadata: { ...auditBase.metadata, finalStatus: item.status },
    });
    res.json({ item: publicApproval(item) });
    } catch {
      if (!res.headersSent) {
        res.status(503).json({ error: "确认服务暂时不可用，未执行本次决定" });
      }
    }
  });
}
