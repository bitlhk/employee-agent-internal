import { createHash, randomUUID } from "node:crypto";
import type { GovernedWorkItem, GovernedWorkItemExecution } from "../../drizzle/schema";
import type { ContextResolutionEvidenceV1, ContextSourceBindingV1 } from "../../shared/context-resolution";
import {
  GOVERNED_WORK_ITEM_SCHEMA,
  WORK_EXECUTION_RECEIPT_SCHEMA,
  type GovernedWorkItemStatusV1,
  type GovernedWorkItemTypeV1,
  type GovernedWorkItemV1,
  type WorkExecutionOperationV1,
  type WorkExecutionReceiptV1,
} from "../../shared/work-continuity";
import {
  createGovernedWorkItemDrafts,
  executeGovernedWorkItemTransition,
  getGovernedWorkItem,
  listGovernedWorkItemExecutions,
  listGovernedWorkItems,
} from "../db";
import { resolveContextSources } from "./context-resolution/source-resolver";
import { buildContextReceipt } from "./governance/context-receipt";
import { governanceFingerprint, principalFingerprint, type RuntimePrincipalV2 } from "./governance/contracts";
import { buildTaskContextPack } from "./governance/task-execution-envelope";

const EXTRACTOR_VERSION = "meeting-work-extractor-v1";
const WORK_PLAN_ID = "grace-governed-work-continuity";
const WORK_LOGICAL_CONTEXT_ID = "governed_work_state";
const ACTIVE_STATUSES: GovernedWorkItemStatusV1[] = ["confirmed", "open", "in_progress"];

type ExtractedWorkDraft = {
  type: GovernedWorkItemTypeV1;
  subject: string;
  description: string;
  ownerDisplayName: string | null;
  dueAt: Date | null;
  sourceExcerpt: string;
  extractedFields: Array<"type" | "subject" | "description" | "owner" | "due_at">;
  relatedContext: string[];
};

export type WorkScope = {
  organizationId: string;
  userId: number;
  adoptId: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function dateAtEndOfDay(base: Date): Date {
  const result = new Date(base);
  result.setHours(18, 0, 0, 0);
  return result;
}

function parseDueAt(text: string, meetingAt: Date): Date | null {
  const normalized = text.replace(/星期/g, "周");
  if (/今天|今日/.test(normalized)) return dateAtEndOfDay(meetingAt);
  if (/后天/.test(normalized)) return dateAtEndOfDay(new Date(meetingAt.getTime() + 2 * 86_400_000));
  if (/明天|明日/.test(normalized)) return dateAtEndOfDay(new Date(meetingAt.getTime() + 86_400_000));
  const weekday = normalized.match(/(?:下周|本周|周)([一二三四五六日天])/);
  if (weekday) {
    const target = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 } as Record<string, number>)[weekday[1]];
    const current = meetingAt.getDay();
    let delta = (target - current + 7) % 7;
    if (normalized.includes("下周")) {
      const daysSinceMonday = (current + 6) % 7;
      const targetFromMonday = target === 0 ? 6 : target - 1;
      delta = 7 - daysSinceMonday + targetFromMonday;
    }
    const date = new Date(meetingAt.getTime() + delta * 86_400_000);
    return dateAtEndOfDay(date);
  }
  const absolute = normalized.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if (absolute) {
    const date = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), 18, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function relatedContextFor(text: string): string[] {
  const related = new Set<string>();
  if (/客户|王总|李总|风险等级|画像/.test(text)) related.add("customer_profile");
  if (/产品|持仓|到期|资产配置/.test(text)) related.add("customer_portfolio");
  if (/制度|适当性|合规|销售要求/.test(text)) related.add("current_wealth_policy");
  return [...related];
}

function actionDraft(clause: string, inheritedOwner: string | null, meetingAt: Date): ExtractedWorkDraft | null {
  const ownerMatch = clause.match(/^([\u4e00-\u9fa5]{2,8}?)(?=(?:负责|在|于|今天|明天|后天|本周|下周|周|星期))/);
  const owner = cleanText(ownerMatch?.[1] || inheritedOwner || "", 160) || null;
  const dueAt = parseDueAt(clause, meetingAt);
  if (!owner || !dueAt) return null;
  const subject = cleanText(clause
    .replace(new RegExp(`^${owner}`), "")
    .replace(/^(?:负责|在|于)/, "")
    .replace(/(?:今天|今日|明天|明日|后天|本周|下周|周|星期)[一二三四五六日天]?前?/g, "")
    .replace(/20\d{2}[年/-]\d{1,2}[月/-]\d{1,2}日前?/g, "")
    .replace(/^前/, ""), 240);
  if (subject.length < 2) return null;
  return {
    type: "action_item",
    subject,
    description: cleanText(clause, 2_000),
    ownerDisplayName: owner,
    dueAt,
    sourceExcerpt: cleanText(clause, 1_000),
    extractedFields: ["type", "subject", "description", "owner", "due_at"],
    relatedContext: relatedContextFor(clause),
  };
}

export function extractMeetingWorkDrafts(input: { meetingText: string; meetingAt?: Date }): ExtractedWorkDraft[] {
  const meetingText = cleanText(input.meetingText, 30_000);
  if (!meetingText) return [];
  const meetingAt = input.meetingAt || new Date();
  const sentences = meetingText.split(/[。！？!?;；\n]+/).map(item => cleanText(item, 2_000)).filter(Boolean);
  const drafts: ExtractedWorkDraft[] = [];
  for (const sentence of sentences) {
    const decision = sentence.match(/(?:决定|确定|一致同意|会议同意)[：:]?(.+)/);
    if (decision) {
      drafts.push({
        type: "decision",
        subject: cleanText(decision[1], 240),
        description: sentence,
        ownerDisplayName: null,
        dueAt: null,
        sourceExcerpt: sentence,
        extractedFields: ["type", "subject", "description"],
        relatedContext: relatedContextFor(sentence),
      });
    }
    if (/(?:还需要|尚需|需要投研|待|尚待).{0,40}(?:确认|明确|回复)|(?:尚未确定|有待确认)/.test(sentence)) {
      drafts.push({
        type: "open_question",
        subject: cleanText(sentence.replace(/^(?:但是|另外|此外|同时)[，,:：]?/, ""), 240),
        description: sentence,
        ownerDisplayName: null,
        dueAt: null,
        sourceExcerpt: sentence,
        extractedFields: ["type", "subject", "description"],
        relatedContext: relatedContextFor(sentence),
      });
    }
    let inheritedOwner: string | null = null;
    for (const clause of sentence.split(/[，,]/).map(item => cleanText(item, 1_000)).filter(Boolean)) {
      const ownerMatch = clause.match(/^([\u4e00-\u9fa5]{2,8}?)(?=(?:负责|在|于|今天|明天|后天|本周|下周|周|星期))/);
      if (ownerMatch) inheritedOwner = ownerMatch[1];
      const action = actionDraft(clause, inheritedOwner, meetingAt);
      if (action) drafts.push(action);
    }
  }
  const seen = new Set<string>();
  return drafts.filter(draft => {
    const key = `${draft.type}:${draft.subject}:${draft.ownerDisplayName || ""}:${draft.dueAt?.toISOString() || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicWorkItem(row: GovernedWorkItem): GovernedWorkItemV1 {
  const extraction = row.extractionJson as GovernedWorkItemV1["extraction"];
  return {
    schema: GOVERNED_WORK_ITEM_SCHEMA,
    workItemId: row.workItemId,
    organizationId: row.organizationId,
    userId: row.userId,
    adoptionId: row.adoptId,
    roleTemplate: row.roleTemplate,
    type: row.type,
    subject: row.subject,
    description: row.description,
    ownerPrincipalId: row.ownerPrincipalId,
    ownerDisplayName: row.ownerDisplayName,
    dueAt: row.dueAt?.toISOString() || null,
    status: row.status,
    source: { type: "meeting", sourceId: row.sourceId, sourceFingerprint: row.sourceFingerprint },
    extraction,
    confirmation: row.confirmedBy && row.confirmedAt
      ? { confirmedBy: row.confirmedBy, confirmedAt: row.confirmedAt.toISOString() }
      : null,
    relatedContext: Array.isArray(row.relatedContextJson) ? row.relatedContextJson : [],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publicExecution(row: GovernedWorkItemExecution): WorkExecutionReceiptV1 {
  return {
    schema: WORK_EXECUTION_RECEIPT_SCHEMA,
    executionReceiptId: row.executionReceiptId,
    workItemId: row.workItemId,
    capabilityId: "grace.work_item",
    capabilityVersion: "1",
    operation: row.operation,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    status: row.status,
    requestedBy: row.requestedBy,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt?.toISOString() || null,
    approvalId: row.approvalId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    contextReceiptFingerprint: row.contextReceiptFingerprint,
    resultFingerprint: row.resultFingerprint,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() || null,
  };
}

export async function createMeetingWorkDrafts(input: {
  principal: RuntimePrincipalV2;
  meetingText: string;
  meetingAt?: Date;
  sourceId?: string;
}) {
  const sourceText = cleanText(input.meetingText, 30_000);
  const drafts = extractMeetingWorkDrafts({ meetingText: sourceText, meetingAt: input.meetingAt });
  if (!drafts.length) throw new Error("NO_WORK_ITEMS_EXTRACTED");
  const sourceId = cleanText(input.sourceId, 128) || `mtg_${randomUUID()}`;
  const sourceFingerprint = sha256(sourceText);
  const rows = await createGovernedWorkItemDrafts(drafts.map(draft => ({
    workItemId: `gwk_${randomUUID()}`,
    organizationId: input.principal.organizationId,
    userId: input.principal.userId,
    adoptId: input.principal.adoptionId,
    roleTemplate: input.principal.roleTemplate,
    type: draft.type,
    subject: draft.subject,
    description: draft.description,
    ownerDisplayName: draft.ownerDisplayName,
    dueAt: draft.dueAt,
    sourceId,
    sourceFingerprint,
    sourceExcerpt: draft.sourceExcerpt,
    extractionJson: {
      extractor: "deterministic",
      extractorVersion: EXTRACTOR_VERSION,
      sourceExcerpt: draft.sourceExcerpt,
      extractedFields: draft.extractedFields,
    },
    relatedContextJson: draft.relatedContext,
  })));
  return { sourceId, sourceFingerprint, items: rows.map(publicWorkItem) };
}

function workResolutionEvidence(principal: RuntimePrincipalV2): ContextResolutionEvidenceV1 {
  const plan = {
    schema: "ea.context-need-plan.v1" as const,
    planId: WORK_PLAN_ID,
    planVersion: "1.0.0",
    rolePackId: `role:${principal.roleTemplate}`,
    roleTemplate: principal.roleTemplate,
    taskId: "GWC-GT-02",
    needs: [{
      needId: "confirmed_work_state",
      logicalAssetId: WORK_LOGICAL_CONTEXT_ID,
      contextType: "memory" as const,
      requiredness: "required" as const,
      purpose: "Recall user-confirmed work state without re-inferring meeting text.",
      freshness: { mode: "latest" as const },
      requiredCapabilities: ["read_work_state"],
    }],
  };
  const binding: ContextSourceBindingV1 = {
    schema: "ea.context-source-binding.v1",
    bindingId: `builtin.${principal.roleTemplate}.governed-work-state`,
    organizationId: principal.organizationId,
    rolePackId: plan.rolePackId,
    logicalAssetId: WORK_LOGICAL_CONTEXT_ID,
    contextType: "memory",
    providerType: "api",
    resourceRef: "api://employee-agent/governed-work-items",
    capabilities: ["read_work_state"],
    bindingVersion: "1.0.0",
    stage: "production",
    status: "active",
  };
  const resolved = resolveContextSources({ plan, bindings: [binding], organizationId: principal.organizationId });
  return {
    schema: "ea.context-resolution-evidence.v1",
    planId: resolved.planId,
    planVersion: resolved.planVersion,
    taskId: resolved.taskId,
    status: resolved.status,
    needs: resolved.resolutions.map(item => ({
      logicalAssetId: item.need.logicalAssetId,
      contextType: item.need.contextType,
      requiredness: item.need.requiredness,
      resolutionStatus: item.status,
      ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
      ...(item.binding ? {
        bindingId: item.binding.bindingId,
        providerType: item.binding.providerType,
        resourceRefFingerprint: governanceFingerprint(item.binding.resourceRef),
      } : {}),
    })),
    bindingSnapshotFingerprint: resolved.bindingSnapshotFingerprint,
    resolutionFingerprint: resolved.resolutionFingerprint,
  };
}

export async function governedWorkContext(input: {
  principal: RuntimePrincipalV2;
  statuses?: GovernedWorkItemStatusV1[];
  limit?: number;
}) {
  const rows = await listGovernedWorkItems({
    organizationId: input.principal.organizationId,
    userId: input.principal.userId,
    adoptId: input.principal.adoptionId,
    statuses: input.statuses || ACTIVE_STATUSES,
    limit: input.limit,
  });
  const items = rows.map(publicWorkItem);
  const assembledAt = new Date().toISOString();
  const resolution = workResolutionEvidence(input.principal);
  const context = buildTaskContextPack({
    resolution,
    knowledge: { selectedAssets: [], eligibilityFingerprint: governanceFingerprint([]) },
    businessData: { sources: [] },
    memory: {
      memoryRefs: items.map(item => item.workItemId),
      taskStateVersion: governanceFingerprint(items.map(item => ({ id: item.workItemId, status: item.status, version: item.version }))),
    },
    principalFingerprint: principalFingerprint(input.principal),
    assembledAt,
  });
  const readiness = items.length ? "READY" as const : "DEGRADED" as const;
  const receipt = buildContextReceipt({
    taskId: "GWC-GT-02",
    taskLabel: "接续已确认工作",
    principalFingerprint: context.principalFingerprint,
    resolution,
    effectiveContextSnapshot: context.effectiveContextSnapshot,
    provided: {
      knowledge: [],
      businessData: [],
      memory: items.map(item => ({
        memoryId: item.workItemId,
        kind: item.type,
        version: item.version,
        contentHash: governanceFingerprint({ subject: item.subject, status: item.status, dueAt: item.dueAt }),
        sourceType: "confirmed_work_item",
        asOf: item.updatedAt,
        usageType: "work_state",
        assurance: "REFERENCE_ONLY",
      })),
      capabilities: [{ capabilityId: "grace.work_item", label: "工作事项状态管理", version: "1", sideEffect: "write" }],
    },
    readiness: {
      status: readiness,
      requestedOutcome: "continue_confirmed_work",
      allowedOutcomes: items.length ? ["review_open_work", "propose_next_action"] : ["report_no_open_work"],
      deniedOutcomes: ["infer_unconfirmed_meeting_state"],
      reasons: items.length ? [] : ["当前范围没有已确认且未关闭的工作事项。"],
      remediation: items.length ? [] : ["可从会议文字提取草稿，并经用户确认后创建工作事项。"],
      decisionFingerprint: governanceFingerprint({ readiness, itemIds: items.map(item => item.workItemId) }),
    },
  });
  return { items, context, receipt };
}

function transitionTarget(item: GovernedWorkItem, operation: WorkExecutionOperationV1) {
  if (operation === "confirm" && item.status === "draft") {
    return item.type === "decision" ? "confirmed" as const : "open" as const;
  }
  if (operation === "start" && item.status === "open") return "in_progress" as const;
  if (operation === "complete" && ["open", "in_progress"].includes(item.status)) return "done" as const;
  if (operation === "cancel" && !["done", "cancelled"].includes(item.status)) return "cancelled" as const;
  throw new Error("INVALID_WORK_ITEM_TRANSITION");
}

export async function transitionGovernedWorkItem(input: {
  principal: RuntimePrincipalV2;
  workItemId: string;
  operation: WorkExecutionOperationV1;
  idempotencyKey: string;
  actor: string;
  approvalId?: string | null;
  patch?: {
    subject?: string;
    description?: string | null;
    ownerPrincipalId?: string | null;
    ownerDisplayName?: string | null;
    dueAt?: Date | null;
    relatedContext?: string[];
  };
}) {
  const scope = {
    organizationId: input.principal.organizationId,
    userId: input.principal.userId,
    adoptId: input.principal.adoptionId,
  };
  const current = await getGovernedWorkItem(scope, input.workItemId);
  if (!current) throw new Error("WORK_ITEM_NOT_FOUND");
  const toStatus = transitionTarget(current, input.operation);
  const context = await governedWorkContext({
    principal: input.principal,
    ...(current.status === "draft" ? {} : { statuses: [current.status] }),
    limit: 200,
  });
  const payload = {
    workItemId: input.workItemId,
    operation: input.operation,
    fromStatus: current.status,
    toStatus,
    patch: input.patch || null,
  };
  const payloadHash = governanceFingerprint(payload);
  const resultFingerprint = governanceFingerprint({ ...payload, nextVersion: current.version + 1 });
  const result = await executeGovernedWorkItemTransition({
    ...scope,
    executionReceiptId: `wex_${randomUUID()}`,
    workItemId: input.workItemId,
    operation: input.operation,
    expectedStatuses: [current.status],
    toStatus,
    requestedBy: input.actor,
    confirmedBy: input.actor,
    confirmedAt: new Date(),
    approvalId: input.approvalId,
    idempotencyKey: cleanText(input.idempotencyKey, 191),
    payloadHash,
    contextReceiptFingerprint: context.receipt.receiptFingerprint,
    resultFingerprint,
    patch: input.patch ? {
      ...(input.patch.subject !== undefined ? { subject: input.patch.subject } : {}),
      ...(input.patch.description !== undefined ? { description: input.patch.description } : {}),
      ...(input.patch.ownerPrincipalId !== undefined ? { ownerPrincipalId: input.patch.ownerPrincipalId } : {}),
      ...(input.patch.ownerDisplayName !== undefined ? { ownerDisplayName: input.patch.ownerDisplayName } : {}),
      ...(input.patch.dueAt !== undefined ? { dueAt: input.patch.dueAt } : {}),
      ...(input.patch.relatedContext !== undefined ? { relatedContextJson: input.patch.relatedContext } : {}),
    } : undefined,
  });
  return {
    item: publicWorkItem(result.item),
    executionReceipt: publicExecution(result.execution),
    contextReceipt: context.receipt,
    reused: result.reused,
  };
}

export async function governedWorkView(input: { principal: RuntimePrincipalV2; includeClosed?: boolean }) {
  const visibleStatuses: GovernedWorkItemStatusV1[] = input.includeClosed
    ? ["draft", "confirmed", "open", "in_progress", "done", "cancelled"]
    : ["draft", "confirmed", "open", "in_progress"];
  const contextStatuses: GovernedWorkItemStatusV1[] = input.includeClosed
    ? ["confirmed", "open", "in_progress", "done", "cancelled"]
    : ACTIVE_STATUSES;
  const rows = await listGovernedWorkItems({
    organizationId: input.principal.organizationId,
    userId: input.principal.userId,
    adoptId: input.principal.adoptionId,
    statuses: visibleStatuses,
    limit: 200,
  });
  const items = rows.map(publicWorkItem);
  const context = await governedWorkContext({ principal: input.principal, statuses: contextStatuses, limit: 200 });
  const executions = await listGovernedWorkItemExecutions({
    organizationId: input.principal.organizationId,
    userId: input.principal.userId,
    adoptId: input.principal.adoptionId,
  }, items.map(item => item.workItemId));
  return { ...context, items, executions: executions.map(publicExecution) };
}
