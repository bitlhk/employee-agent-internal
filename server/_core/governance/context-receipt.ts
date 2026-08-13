import { randomUUID } from "node:crypto";
import {
  CONTEXT_RECEIPT_SCHEMA,
  type ContextReceiptV1,
} from "../../../shared/context-receipt";
import { governanceFingerprint } from "./contracts";
import type { TaskExecutionEnvelope, TaskReadinessDecision } from "./task-execution-envelope";
import { createContextReceiptMemoryFeedbackToken } from "./context-receipt-feedback-token";

type ReceiptKnowledgeLabel = { assetId: string; label: string };
type ReceiptBusinessDataLabel = { sourceSystem: string; label: string };

export type ContextReceiptAppliedPolicy = ContextReceiptV1["applied"]["policyDecisions"][number];
export type ContextReceiptCapabilityExecution = ContextReceiptV1["applied"]["capabilityExecutions"][number];
export type ContextReceiptExclusion = ContextReceiptV1["excluded"][number];

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
  return {
    status: readiness.status,
    requestedOutcome: readiness.requestedOutcome,
    allowedOutcomes: readiness.allowedOutcomes,
    deniedOutcomes: readiness.deniedOutcomes,
    reasons: readiness.reasons,
    remediation: readiness.remediation,
    decisionFingerprint: readiness.decisionFingerprint,
  };
}

export function buildContextReceipt(input: {
  taskId: string;
  principalFingerprint: string;
  provided: ContextReceiptV1["provided"];
  citedKnowledgeAssetIds?: string[];
  policyDecisions?: ContextReceiptAppliedPolicy[];
  capabilityExecutions?: ContextReceiptCapabilityExecution[];
  excluded?: ContextReceiptExclusion[];
  readiness: ContextReceiptV1["readiness"];
  memoryFeedbackBinding?: { userId: number; adoptId: string };
  now?: Date;
}): Readonly<ContextReceiptV1> {
  const providedKnowledgeIds = new Set(input.provided.knowledge.map((item) => item.assetId));
  const citedKnowledgeAssetIds = uniqueStrings(input.citedKnowledgeAssetIds || []);
  if (citedKnowledgeAssetIds.some((assetId) => !providedKnowledgeIds.has(assetId))) {
    throw new Error("Context Receipt cited knowledge must be a subset of provided knowledge");
  }
  const receiptId = `crpt_${randomUUID()}`;
  const createdAt = (input.now || new Date()).toISOString();
  const feedback = input.memoryFeedbackBinding
    ? createContextReceiptMemoryFeedbackToken({
      ...input.memoryFeedbackBinding,
      receiptId,
      memoryIds: input.provided.memory.map((item) => item.memoryId),
      createdAt,
    })
    : null;
  const body = {
    schema: CONTEXT_RECEIPT_SCHEMA,
    receiptId,
    taskId: String(input.taskId || "").trim(),
    principalFingerprint: String(input.principalFingerprint || "").trim(),
    provided: input.provided,
    cited: { knowledgeAssetIds: citedKnowledgeAssetIds },
    applied: {
      policyDecisions: input.policyDecisions || [],
      capabilityExecutions: input.capabilityExecutions || [],
    },
    excluded: input.excluded || [],
    readiness: input.readiness,
    ...(feedback ? { memoryFeedback: feedback } : {}),
    createdAt,
  };
  if (!body.taskId || !body.principalFingerprint) throw new Error("Context Receipt requires task and principal binding");
  return freeze({ ...body, receiptFingerprint: governanceFingerprint(body) });
}

export function buildContextReceiptFromEnvelope(input: {
  envelope: Readonly<TaskExecutionEnvelope>;
  knowledgeLabels?: ReceiptKnowledgeLabel[];
  businessDataLabels?: ReceiptBusinessDataLabel[];
  memoryRefs?: Array<{ memoryId: string | number; kind?: string }>;
  citedKnowledgeAssetIds?: string[];
  policyDecisions?: ContextReceiptAppliedPolicy[];
  capabilityExecutions?: ContextReceiptCapabilityExecution[];
  excluded?: ContextReceiptExclusion[];
  memoryFeedbackBinding?: { userId: number; adoptId: string };
  now?: Date;
}): Readonly<ContextReceiptV1> {
  const knowledgeLabels = new Map((input.knowledgeLabels || []).map((item) => [item.assetId, item.label]));
  const businessDataLabels = new Map((input.businessDataLabels || []).map((item) => [item.sourceSystem, item.label]));
  const memoryRefs: Array<{ memoryId: string | number; kind?: string }> = input.memoryRefs
    || input.envelope.context.memory.memoryRefs.map((memoryId) => ({ memoryId }));
  return buildContextReceipt({
    taskId: input.envelope.readiness.taskId,
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
        .map((item) => ({ memoryId: String(item.memoryId), ...(item.kind ? { kind: item.kind } : {}) })),
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
    memoryFeedbackBinding: input.memoryFeedbackBinding,
    now: input.now,
  });
}

export function attachContextReceipt<T extends Record<string, unknown>>(
  result: T,
  receipt: Readonly<ContextReceiptV1>,
): T {
  const meta = result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
    ? result._meta as Record<string, unknown>
    : {};
  return { ...result, _meta: { ...meta, eaContextReceipt: receipt } };
}
