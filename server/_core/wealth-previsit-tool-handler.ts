import type { Request } from "express";
import type { ClawAdoption } from "../../drizzle/schema";
import { getUserById } from "../db";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { buildRelevantAgentMemoryContext } from "./agent-memory-retrieval";
import { principalFingerprint } from "./governance/contracts";
import { resolveRuntimePrincipalV2 } from "./governance/principal";
import {
  buildCapabilitySnapshot,
  buildTaskContextPack,
  buildTaskExecutionEnvelope,
} from "./governance/task-execution-envelope";
import { buildContextReceiptFromEnvelope } from "./governance/context-receipt";
import { evaluateWealthTaskReadiness, readinessCheck } from "./governance/wealth-task-readiness";
import { callInternalMcpTool, parseInternalMcpJsonResult } from "./internal-mcp-client";
import { prepareWealthPrevisitContext } from "./wealth-previsit-context";
import { resolveWealthPrevisitKnowledgeBasis } from "./wealth-policy-source";
import { resolveWealthRolePackReleaseEvidence, wealthRolePackReleaseReadiness } from "./wealth-role-pack-release";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function textResult(text: string, extra: Pick<ToolResult, "isError"> = {}): ToolResult {
  return { content: [{ type: "text", text }], ...extra };
}

function correlationId(req: Request): string | undefined {
  const value = req.headers["x-request-id"] || req.headers["x-correlation-id"];
  const first = Array.isArray(value) ? value[0] : value;
  return String(first || "").trim() || undefined;
}

export async function handleWealthPrevisitTool(input: {
  req: Request;
  args: Record<string, unknown>;
  adoption: ClawAdoption;
  adoptId: string;
  sessionId: string;
}): Promise<ToolResult> {
  const { req, args, adoption, adoptId, sessionId } = input;
  const customerId = String(args.customer_id || args.customerId || "").trim().slice(0, 128);
  if (!customerId) return textResult("需要先从本人授权客户范围内选择客户。", { isError: true });

  const customerEndpoint = String(process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp").trim();
  const user = await getUserById(Number(adoption.userId));
  if (!user) return textResult("当前用户身份不可用，请重新登录后重试。", { isError: true });

  const principalV2 = await resolveRuntimePrincipalV2({ adoption, user, sessionId });
  if (!principalV2.complete) {
    const readiness = evaluateWealthTaskReadiness({
      taskId: "WM-GT-01",
      checks: {
        identity: readinessCheck(
          "BLOCKED",
          "PRINCIPAL_V2_UNAVAILABLE",
          "当前岗位身份无法形成可验证授权快照。",
          { retryable: true },
        ),
      },
    });
    return textResult(`EA_WEALTH_PREVISIT_CONTEXT:${JSON.stringify({
      schema: "ea.wealth-previsit-context.v1",
      status: "blocked",
      message: "当前岗位身份校验未完成，暂不能读取客户访前资料。",
      readiness,
    })}`, { isError: true });
  }

  try {
    const result = await prepareWealthPrevisitContext({
      principal: principalV2.principal,
      customerId,
      dependencies: {
        probeIdentity: async () => parseInternalMcpJsonResult(await callInternalMcpTool({
          endpointUrl: customerEndpoint,
          toolName: "wealth_assistant_context_probe",
          args: {},
          agentId: principalV2.principal.agentId,
          adoptId,
          sessionId: principalV2.principal.sessionId,
        })),
        loadCustomer: async (requestedCustomerId) => parseInternalMcpJsonResult(await callInternalMcpTool({
          endpointUrl: customerEndpoint,
          toolName: "wealth_assistant_customer_detail",
          args: { customerId: requestedCustomerId },
          agentId: principalV2.principal.agentId,
          adoptId,
          sessionId: principalV2.principal.sessionId,
        })),
        resolveKnowledge: async () => resolveWealthPrevisitKnowledgeBasis({
          userId: Number(user.id),
          groupId: Number(user.groupId || 0),
          actorRole: String(user.role || "user"),
          roleTemplate: principalV2.principal.roleTemplate,
        }),
      },
    });
    const customerName = String(result.customer.name || result.customer.customerName || "").trim();
    const taskMemory = await buildRelevantAgentMemoryContext({
      userId: Number(user.id),
      adoptId,
      adoptionId: Number(adoption.id),
      query: [customerId, customerName, "访前准备", "客户沟通偏好"].filter(Boolean).join(" "),
    }).catch(() => ({ context: "", selectedIds: [] as number[], activeCount: 0 }));
    const knowledgeReady = result.knowledgeBasis.status === "ready" && Boolean(result.knowledgeBasis.selected);
    const customerDataReady = Boolean(result.evidence.customerDataAsOf);
    const releaseEvidence = await resolveWealthRolePackReleaseEvidence();
    const readiness = evaluateWealthTaskReadiness({
      taskId: "WM-GT-01",
      checks: {
        identity: readinessCheck("READY", "PRINCIPAL_AND_SCOPE_READY", "岗位身份、授权快照和客户范围已核验。"),
        knowledge: knowledgeReady
          ? readinessCheck("READY", "PREVISIT_KNOWLEDGE_READY", "当前有效访前作业依据已就绪。", { asOf: result.knowledgeBasis.evaluatedAt })
          : readinessCheck("DEGRADED", "PREVISIT_KNOWLEDGE_UNAVAILABLE", result.knowledgeBasis.userMessage),
        customerData: customerDataReady
          ? readinessCheck("READY", "CUSTOMER_DATA_READY", "客户数据已就绪。", { asOf: result.evidence.customerDataAsOf })
          : readinessCheck("DEGRADED", "CUSTOMER_DATA_AS_OF_MISSING", "客户事实缺少数据时间，只能标记待核实。"),
        skill: readinessCheck("READY", "PREVISIT_SKILL_READY", "财富客户访前准备流程已就绪。"),
        evidence: result.evidence.scopeVerified && result.evidence.customerResultFingerprint
          ? readinessCheck("READY", "PREVISIT_EVIDENCE_READY", "客户范围和结果证据已生成。")
          : readinessCheck("BLOCKED", "PREVISIT_EVIDENCE_MISSING", "客户范围证据缺失。"),
        release: wealthRolePackReleaseReadiness(releaseEvidence),
      },
    });
    const executionEnvelope = buildTaskExecutionEnvelope({
      principal: principalV2.principal,
      context: buildTaskContextPack({
        knowledge: {
          selectedAssets: result.knowledgeBasis.selected ? [{
            assetId: result.knowledgeBasis.selected.sourceAssetId,
            version: result.knowledgeBasis.selected.versionLabel,
            contentHash: result.knowledgeBasis.selected.contentHash,
          }] : [],
          eligibilityFingerprint: result.knowledgeBasis.eligibilityFingerprint,
        },
        businessData: {
          sources: [{
            sourceSystem: "wealth_customer_mcp",
            entityRef: result.evidence.customerId,
            asOf: result.evidence.customerDataAsOf,
            resultFingerprint: result.evidence.customerResultFingerprint,
          }],
        },
        memory: { memoryRefs: taskMemory.selectedIds.map(String) },
        principalFingerprint: principalFingerprint(principalV2.principal),
        assembledAt: new Date().toISOString(),
      }),
      readiness,
      capabilitySnapshot: buildCapabilitySnapshot({
        capabilityIds: ["prepare_wealth_previsit_context", "wealth_customer_mcp"],
        capabilityVersions: { prepare_wealth_previsit_context: "1", wealth_customer_mcp: "1" },
        sideEffectProfiles: { prepare_wealth_previsit_context: "read", wealth_customer_mcp: "read" },
        policyBindings: {
          prepare_wealth_previsit_context: ["EA_KNOWLEDGE_ELIGIBILITY_V1", "EA_CUSTOMER_SCOPE_V1"],
        },
      }),
      releaseEvidence,
      correlationId: correlationId(req),
    });
    const contextReceipt = buildContextReceiptFromEnvelope({
      envelope: executionEnvelope,
      knowledgeLabels: result.knowledgeBasis.selected ? [{
        assetId: result.knowledgeBasis.selected.sourceAssetId,
        label: `财富客户访前准备作业依据 ${result.knowledgeBasis.selected.versionLabel}`.trim(),
      }] : [],
      businessDataLabels: [{ sourceSystem: "wealth_customer_mcp", label: "当前客户画像与持仓" }],
      memoryRefs: taskMemory.selectedIds.map((memoryId) => ({ memoryId })),
      memoryFeedbackBinding: { userId: Number(user.id), adoptId },
      policyDecisions: [
        {
          policyCode: "EA_CUSTOMER_SCOPE_V1",
          ruleVersion: "customer-scope-v1",
          effect: "ALLOW",
        },
        ...(knowledgeReady ? [{
          policyCode: "EA_KNOWLEDGE_ELIGIBILITY_V1",
          ruleVersion: "knowledge-eligibility-v1",
          effect: "ALLOW" as const,
        }] : []),
      ],
      capabilityExecutions: [{
        capabilityId: "prepare_wealth_previsit_context",
        operation: "prepare_customer_previsit_context",
        status: "completed",
      }],
      excluded: knowledgeReady ? [] : [{
        category: "knowledge",
        reasonCode: "PREVISIT_KNOWLEDGE_UNAVAILABLE",
        count: 1,
        message: "未提供不符合岗位、密级或有效期要求的访前资料。",
      }],
    });
    await recordAuditBestEffort({
      action: "governance.wealth_previsit_context.prepared",
      result: readiness.status === "READY" ? "success" : "failed",
      severity: readiness.status === "READY" ? "info" : "medium",
      actorType: "agent",
      actorUserId: principalV2.principal.userId,
      actorRole: principalV2.principal.roleTemplate,
      targetType: "wealth_previsit_context",
      targetId: customerId,
      workspaceId: principalV2.principal.workspaceId,
      agentInstanceId: adoptId,
      runtimeAgentId: principalV2.principal.agentId,
      sessionId: principalV2.principal.sessionId,
      toolName: "prepare_wealth_previsit_context",
      policyCode: "EA_WEALTH_PREVISIT_READINESS_V1",
      source: "platform_tools_mcp",
      ...auditRequest(req),
      metadata: {
        readinessStatus: readiness.status,
        readinessFingerprint: readiness.decisionFingerprint,
        envelopeFingerprint: executionEnvelope.envelopeFingerprint,
        contextEligibilityFingerprint: result.knowledgeBasis.eligibilityFingerprint,
      },
    });
    return textResult(`EA_WEALTH_PREVISIT_CONTEXT:${JSON.stringify({
      ...result,
      ...(taskMemory.context ? { taskMemoryContext: taskMemory.context } : {}),
      readiness,
      executionEnvelope,
      contextReceipt,
    })}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    const authorizationDenied = /标识|范围|归属|授权/u.test(message);
    const readiness = evaluateWealthTaskReadiness({
      taskId: "WM-GT-01",
      checks: {
        identity: authorizationDenied
          ? readinessCheck("BLOCKED", "CUSTOMER_SCOPE_DENIED", "当前岗位无权读取该客户资料。")
          : readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份已就绪。"),
        customerData: authorizationDenied
          ? readinessCheck("BLOCKED", "CUSTOMER_SCOPE_DENIED", "该客户不在当前岗位授权范围内。")
          : readinessCheck("DEGRADED", "CUSTOMER_DATA_UNAVAILABLE", "客户数据服务暂时不可用。", { retryable: true }),
        knowledge: readinessCheck(
          "DEGRADED",
          "PREVISIT_KNOWLEDGE_NOT_ASSEMBLED",
          "本轮尚未完成访前依据装配。",
          { retryable: true },
        ),
        skill: readinessCheck("READY", "PREVISIT_SKILL_READY", "财富客户访前准备流程已就绪。"),
        evidence: authorizationDenied
          ? readinessCheck("BLOCKED", "CUSTOMER_SCOPE_DENY_EVIDENCE", "客户范围拒绝证据已生成。")
          : readinessCheck("DEGRADED", "PREVISIT_EVIDENCE_PARTIAL", "本轮仅保留依赖失败证据。", { retryable: true }),
      },
    });
    return textResult(`EA_WEALTH_PREVISIT_CONTEXT:${JSON.stringify({
      schema: "ea.wealth-previsit-context.v1",
      status: readiness.status.toLowerCase(),
      message: authorizationDenied
        ? "当前岗位无权读取该客户资料。"
        : "客户数据服务暂时不可用，可以先生成通用访前检查清单。",
      readiness,
    })}`, authorizationDenied ? { isError: true } : {});
  }
}
