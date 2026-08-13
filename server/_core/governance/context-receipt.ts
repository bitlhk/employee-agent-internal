import { randomUUID } from "node:crypto";
import {
  CONTEXT_RECEIPT_SCHEMA,
  type ContextReceiptV1,
} from "../../../shared/context-receipt";
import {
  CONTEXT_INTERACTION_GRANT_SCHEMA,
  type ContextInteractionGrantV1,
} from "../../../shared/context-evidence";
import { governanceFingerprint } from "./contracts";
import type { TaskExecutionEnvelope, TaskReadinessDecision } from "./task-execution-envelope";
import { createContextReceiptMemoryFeedbackToken } from "./context-receipt-feedback-token";

type ReceiptKnowledgeLabel = { assetId: string; label: string };
type ReceiptBusinessDataLabel = { sourceSystem: string; label: string };
type ReceiptMemoryRef = {
  memoryId: string | number;
  kind?: string;
  version?: number;
  contentHash?: string;
  sourceType?: string;
  asOf?: string;
  usageType?: ContextReceiptV1["provided"]["memory"][number]["usageType"];
};

const TASK_LABELS: Record<string, string> = {
  "WM-GT-01": "客户访前准备",
  "WM-GT-02": "资产配置建议",
  "WM-GT-03": "现行政策判断",
  "WM-GT-04": "风险错配拦截",
  "WM-GT-05": "客户跟进创建",
  "WM-GT-06": "产品到期经营",
};

const OUTCOME_LABELS: Record<string, string> = {
  customer_specific_previsit_brief: "客户访前简报",
  generic_previsit_checklist: "通用访前检查清单",
  verified_customer_facts_summary: "已核实客户事实摘要",
  governed_asset_allocation_candidates: "受治理的资产配置候选",
  verified_customer_analysis: "已核实客户分析",
  allocation_constraints: "资产配置约束",
  product_screening_criteria: "产品筛选条件",
  current_enterprise_policy_conclusion: "现行企业政策结论",
  knowledge_admin_remediation: "知识管理员修复建议",
  formal_product_recommendation: "正式产品推荐",
  risk_reassessment_next_step: "风险测评更新指引",
  confirmed_business_followup_write: "创建客户跟进任务",
  followup_draft: "客户跟进草稿",
  confirmation_request: "操作确认请求",
  maturity_customer_followup_plan: "到期客户跟进计划",
  generic_maturity_checklist: "通用到期检查清单",
  partial_verified_maturity_list: "部分已核实到期清单",
};

export type ContextReceiptAppliedPolicy = ContextReceiptV1["applied"]["policyDecisions"][number];
export type ContextReceiptCapabilityExecution = Omit<
  ContextReceiptV1["applied"]["capabilityExecutions"][number],
  "label"
> & { label?: string };
export type ContextReceiptExclusion = Omit<ContextReceiptV1["excluded"][number], "disclosure"> & {
  disclosure?: ContextReceiptV1["excluded"][number]["disclosure"];
};

type ContextReceiptReadinessInput = Omit<ContextReceiptV1["readiness"], "presentation"> & {
  presentation?: ContextReceiptV1["readiness"]["presentation"];
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
  }
  return value;
}

function compactReadiness(readiness: TaskReadinessDecision): ContextReceiptV1["readiness"] {
  const labels = (values: string[]) => values.map((value) => OUTCOME_LABELS[value] || value);
  return {
    status: readiness.status,
    requestedOutcome: readiness.requestedOutcome,
    allowedOutcomes: readiness.allowedOutcomes,
    deniedOutcomes: readiness.deniedOutcomes,
    reasons: readiness.reasons,
    remediation: readiness.remediation,
    presentation: {
      completed: labels(readiness.allowedOutcomes),
      unavailable: labels(readiness.deniedOutcomes),
      nextSteps: readiness.remediation,
    },
    decisionFingerprint: readiness.decisionFingerprint,
  };
}

function normalizeReadiness(readiness: ContextReceiptReadinessInput): ContextReceiptV1["readiness"] {
  return {
    ...readiness,
    presentation: readiness.presentation || {
      completed: readiness.allowedOutcomes.map((value) => OUTCOME_LABELS[value] || value),
      unavailable: readiness.deniedOutcomes.map((value) => OUTCOME_LABELS[value] || value),
      nextSteps: readiness.remediation,
    },
  };
}

export function buildContextReceipt(input: {
  taskId: string;
  taskLabel?: string;
  envelopeId?: string;
  correlationId?: string;
  principalFingerprint: string;
  provided: ContextReceiptV1["provided"];
  citedKnowledgeAssetIds?: string[];
  policyDecisions?: ContextReceiptAppliedPolicy[];
  capabilityExecutions?: ContextReceiptCapabilityExecution[];
  excluded?: ContextReceiptExclusion[];
  readiness: ContextReceiptReadinessInput;
  now?: Date;
}): Readonly<ContextReceiptV1> {
  const providedKnowledgeIds = new Set(input.provided.knowledge.map((item) => item.assetId));
  const citedKnowledgeAssetIds = uniqueStrings(input.citedKnowledgeAssetIds || []);
  if (citedKnowledgeAssetIds.some((assetId) => !providedKnowledgeIds.has(assetId))) {
    throw new Error("Context Receipt cited knowledge must be a subset of provided knowledge");
  }
  const receiptId = `crpt_${randomUUID()}`;
  const createdAt = (input.now || new Date()).toISOString();
  const body = {
    schema: CONTEXT_RECEIPT_SCHEMA,
    receiptId,
    taskId: String(input.taskId || "").trim(),
    taskLabel: String(input.taskLabel || TASK_LABELS[input.taskId] || input.taskId || "岗位任务").trim(),
    ...(input.envelopeId ? { envelopeId: input.envelopeId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    principalFingerprint: String(input.principalFingerprint || "").trim(),
    provided: input.provided,
    cited: { knowledgeAssetIds: citedKnowledgeAssetIds },
    applied: {
      policyDecisions: input.policyDecisions || [],
      capabilityExecutions: (input.capabilityExecutions || []).map((item) => ({
        ...item,
        label: item.label || item.capabilityId,
      })),
    },
    excluded: (input.excluded || []).map((item) => ({
      ...item,
      disclosure: item.disclosure || "aggregate_only" as const,
    })),
    readiness: normalizeReadiness(input.readiness),
    createdAt,
  };
  if (!body.taskId || !body.principalFingerprint) throw new Error("Context Receipt requires task and principal binding");
  return freeze({ ...body, receiptFingerprint: governanceFingerprint(body) });
}

export function buildContextReceiptFromEnvelope(input: {
  envelope: Readonly<TaskExecutionEnvelope>;
  knowledgeLabels?: ReceiptKnowledgeLabel[];
  businessDataLabels?: ReceiptBusinessDataLabel[];
  memoryRefs?: ReceiptMemoryRef[];
  citedKnowledgeAssetIds?: string[];
  policyDecisions?: ContextReceiptAppliedPolicy[];
  capabilityExecutions?: ContextReceiptCapabilityExecution[];
  excluded?: ContextReceiptExclusion[];
  now?: Date;
}): Readonly<ContextReceiptV1> {
  const knowledgeLabels = new Map((input.knowledgeLabels || []).map((item) => [item.assetId, item.label]));
  const businessDataLabels = new Map((input.businessDataLabels || []).map((item) => [item.sourceSystem, item.label]));
  const memoryRefs: ReceiptMemoryRef[] = input.memoryRefs
    || input.envelope.context.memory.memoryRefs.map((memoryId) => ({ memoryId }));
  return buildContextReceipt({
    taskId: input.envelope.readiness.taskId,
    envelopeId: input.envelope.envelopeId,
    correlationId: input.envelope.correlationId,
    principalFingerprint: input.envelope.context.principalFingerprint,
    provided: {
      knowledge: input.envelope.context.knowledge.selectedAssets.map((item) => ({
        ...item,
        label: knowledgeLabels.get(item.assetId) || "当前有效岗位知识",
      })),
      businessData: input.envelope.context.businessData.sources.map((item) => ({
        ...item,
        label: businessDataLabels.get(item.sourceSystem) || item.sourceSystem,
      })),
      memory: memoryRefs
        .map((item) => ({
          memoryId: String(item.memoryId),
          ...(item.kind ? { kind: item.kind } : {}),
          version: Math.max(1, Number(item.version || 1)),
          contentHash: String(item.contentHash || ""),
          ...(item.sourceType ? { sourceType: item.sourceType } : {}),
          ...(item.asOf ? { asOf: item.asOf } : {}),
          usageType: item.usageType || "relationship_observation",
          assurance: "REFERENCE_ONLY" as const,
        })),
      capabilities: input.envelope.capabilitySnapshot.capabilityIds.map((capabilityId) => ({
        capabilityId,
        label: capabilityId,
        version: input.envelope.capabilitySnapshot.capabilityVersions[capabilityId] || "",
        sideEffect: input.envelope.capabilitySnapshot.sideEffectProfiles[capabilityId] || "unknown",
      })),
    },
    citedKnowledgeAssetIds: input.citedKnowledgeAssetIds,
    policyDecisions: input.policyDecisions,
    capabilityExecutions: input.capabilityExecutions,
    excluded: input.excluded,
    readiness: compactReadiness(input.envelope.readiness),
    now: input.now,
  });
}

export function createContextReceiptInteractionGrant(input: {
  receipt: Readonly<ContextReceiptV1>;
  userId: number;
  adoptId: string;
}): ContextInteractionGrantV1 | null {
  const feedback = createContextReceiptMemoryFeedbackToken({
    userId: input.userId,
    adoptId: input.adoptId,
    receiptId: input.receipt.receiptId,
    memoryRefs: input.receipt.provided.memory.map((item) => ({ memoryId: item.memoryId, version: item.version })),
    createdAt: input.receipt.createdAt,
  });
  return feedback ? {
    schema: CONTEXT_INTERACTION_GRANT_SCHEMA,
    receiptId: input.receipt.receiptId,
    ...feedback,
  } : null;
}

export function attachContextReceipt<T extends Record<string, unknown>>(
  result: T,
  receipt: Readonly<ContextReceiptV1>,
  interactionGrant?: ContextInteractionGrantV1 | null,
): T {
  const meta = result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
    ? result._meta as Record<string, unknown>
    : {};
  return {
    ...result,
    _meta: {
      ...meta,
      eaMetadataIssuer: "employee-agent",
      eaContextReceipt: receipt,
      ...(interactionGrant ? { eaInteractionGrant: interactionGrant } : {}),
    },
  };
}
