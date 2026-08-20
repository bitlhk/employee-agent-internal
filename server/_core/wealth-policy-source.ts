import {
  listAccessibleKnowledgeBases,
  listKnowledgeDocumentsForBases,
} from "../db";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import type { WealthPolicySource } from "./governance/wealth-suitability-policy";
import { selectWealthPolicyDocument } from "./wealth-policy-selection";
import type { WealthKnowledgeSourceResolution } from "./context-resolution/wealth-source-resolution";
import { contextBindingEvidence } from "./context-resolution/wealth-source-resolution";
import { selectLlamaIndexKnowledgeBases } from "./context-resolution/llamaindex-adapter";
import { buildContextItemV1 } from "./context-resolution/context-item";
import type { ContextItemV1, ContextResolutionReasonCodeV1 } from "../../shared/context-resolution";

const DEFAULT_POLICY_DOCUMENT = "15-财富产品适当性销售管理细则（V2.2现行）.md";

export type WealthPolicyBasis = {
  schema: "ea.wealth-policy-basis.v1";
  status: "ready" | "unavailable";
  roleTemplate: string;
  evaluatedAt: string;
  selected: {
    sourceAssetId: string;
    documentId: string;
    contentHash: string;
    documentName: string;
    versionLabel: string;
    sourceDepartment: string;
    effectiveAt: string | null;
    sourceLocator: string;
    knowledgeBaseId?: string;
  } | null;
  sourceBinding?: ReturnType<typeof contextBindingEvidence>;
  contextItem?: ContextItemV1;
  resolutionReasonCode?: ContextResolutionReasonCodeV1;
  governance: {
    eligibilityFingerprint: string;
    historicalVersionFiltered: boolean;
    filteredForValidity: number;
    unavailableDocuments: number;
    accessRestricted: boolean;
  };
  userMessage: string;
};

export type WealthPrevisitKnowledgeBasis = {
  status: "ready" | "unavailable";
  evaluatedAt: string;
  selected: {
    sourceAssetId: string;
    documentId: string;
    versionLabel: string;
    contentHash: string;
    sourceDepartment: string;
    knowledgeBaseId?: string;
  } | null;
  sourceBinding?: ReturnType<typeof contextBindingEvidence>;
  contextItem?: ContextItemV1;
  resolutionReasonCode?: ContextResolutionReasonCodeV1;
  eligibilityFingerprint: string;
  userMessage: string;
};

function resolvedKnowledgeContextItem(input: {
  source: WealthKnowledgeSourceResolution | undefined;
  logicalAssetId: string;
  assetId: string;
  assetVersion: string;
  contentHash: string;
  asOf: string;
  sourceDepartment: string;
  authority: string;
  effectiveAt: string | null;
  documentId: string;
  position?: string;
}): ContextItemV1 | undefined {
  const binding = input.source?.binding;
  const resolution = input.source?.plan?.resolutions.find((item) => item.need.logicalAssetId === input.logicalAssetId);
  if (!binding || !resolution) return undefined;
  return buildContextItemV1({
    need: resolution.need,
    binding,
    assetId: input.assetId,
    assetVersion: input.assetVersion,
    contentHash: input.contentHash,
    asOf: input.asOf,
    provenance: {
      sourceDepartment: input.sourceDepartment,
      authority: input.authority,
      effectiveAt: input.effectiveAt,
    },
    citation: { documentId: input.documentId, ...(input.position ? { position: input.position } : {}) },
  });
}

export async function resolveWealthPolicyBasis(input: {
  userId: number;
  groupId: number;
  actorRole: string;
  roleTemplate: string;
  now?: Date;
  knowledgeSource?: WealthKnowledgeSourceResolution;
}): Promise<WealthPolicyBasis> {
  const now = input.now || new Date();
  const unavailable = (
    fingerprint = "",
    resolutionReasonCode: ContextResolutionReasonCodeV1 = "NO_USABLE_CONTEXT",
  ): WealthPolicyBasis => ({
    schema: "ea.wealth-policy-basis.v1",
    status: "unavailable",
    roleTemplate: input.roleTemplate,
    evaluatedAt: now.toISOString(),
    selected: null,
    sourceBinding: contextBindingEvidence(input.knowledgeSource?.binding || null),
    resolutionReasonCode,
    governance: {
      eligibilityFingerprint: fingerprint,
      historicalVersionFiltered: false,
      filteredForValidity: 0,
      unavailableDocuments: 0,
      accessRestricted: false,
    },
    userMessage: input.roleTemplate === "wealth-manager"
      ? "当前没有通过岗位、密级和有效期校验的适当性制度，暂不能据此形成正式业务判断。请联系知识管理员确认现行版本。"
      : "当前岗位不适用财富产品适当性制度。",
  });
  if (input.roleTemplate !== "wealth-manager") return unavailable("", "NOT_ELIGIBLE");

  const accessibleBases = (await listAccessibleKnowledgeBases({
    userId: input.userId,
    groupId: input.groupId,
    roleTemplate: input.roleTemplate,
  })).filter((base) => base.status === "ready" && ["enterprise", "role"].includes(base.scope));
  if (input.knowledgeSource?.mode === "binding" && !input.knowledgeSource.binding) return unavailable("", "NO_BINDING");
  let bases = accessibleBases;
  if (input.knowledgeSource?.mode === "binding" && input.knowledgeSource.binding) {
    try {
      bases = selectLlamaIndexKnowledgeBases({ binding: input.knowledgeSource.binding, accessibleBases }).knowledgeBases;
    } catch {
      return unavailable("", "NOT_ELIGIBLE");
    }
  }
  if (!bases.length) return unavailable("", "SOURCE_UNAVAILABLE");

  const documents = await listKnowledgeDocumentsForBases(bases.map((base) => base.id));
  const eligibility = buildKnowledgeEligibility({
    bases,
    documents,
    userId: input.userId,
    actorRole: input.actorRole,
    roleTemplate: input.roleTemplate,
    now,
  });
  const configuredName = String(process.env.WEALTH_SUITABILITY_POLICY_DOCUMENT || DEFAULT_POLICY_DOCUMENT).trim();
  const { selected, seriesDocuments } = selectWealthPolicyDocument({
    documents,
    eligibleDocumentIds: eligibility.documentIds,
    configuredName,
  });
  const eligibleIds = new Set(eligibility.documentIds);

  const filtered = seriesDocuments
    .filter((document) => !eligibleIds.has(document.publicId))
    .map((document) => buildKnowledgeEligibility({
      bases,
      documents: [document],
      userId: input.userId,
      actorRole: input.actorRole,
      roleTemplate: input.roleTemplate,
      now,
    }).excludedByReason);
  const count = (...reasons: string[]) => filtered.reduce(
    (total, item) => total + reasons.reduce((sum, reason) => sum + Number(item[reason] || 0), 0),
    0,
  );
  const governance = {
    eligibilityFingerprint: eligibility.fingerprint,
    historicalVersionFiltered: count("lifecycle_inactive", "expired") > 0,
    filteredForValidity: count("lifecycle_inactive", "expired", "not_effective"),
    unavailableDocuments: count("base_not_ready", "document_not_ready", "invalid_document_id"),
    // Do not expose restricted document names or precise counts to the model/user.
    accessRestricted: count("classification_denied", "role_mismatch") > 0,
  };
  if (!selected) {
    const resolutionReasonCode: ContextResolutionReasonCodeV1 = governance.accessRestricted
      ? "NOT_ELIGIBLE"
      : governance.filteredForValidity > 0
        ? "STALE_ASSET"
        : governance.unavailableDocuments > 0
          ? "SOURCE_UNAVAILABLE"
          : "NO_USABLE_CONTEXT";
    return { ...unavailable(eligibility.fingerprint, resolutionReasonCode), governance };
  }

  const contextItem = resolvedKnowledgeContextItem({
    source: input.knowledgeSource,
    logicalAssetId: "current_wealth_policy",
    assetId: selected.sourceAssetId || selected.publicId,
    assetVersion: selected.versionLabel,
    contentHash: selected.sha256,
    asOf: now.toISOString(),
    sourceDepartment: selected.sourceDepartment,
    authority: selected.authority,
    effectiveAt: selected.effectiveAt,
    documentId: selected.publicId,
    position: "4.1 风险等级匹配",
  });

  return {
    schema: "ea.wealth-policy-basis.v1",
    status: "ready",
    roleTemplate: input.roleTemplate,
    evaluatedAt: now.toISOString(),
    selected: {
      sourceAssetId: selected.sourceAssetId || selected.publicId,
      documentId: selected.publicId,
      contentHash: selected.sha256,
      documentName: selected.name,
      versionLabel: selected.versionLabel,
      sourceDepartment: selected.sourceDepartment,
      effectiveAt: selected.effectiveAt,
      sourceLocator: `${selected.name} / 4.1 风险等级匹配`,
      knowledgeBaseId: bases.find((base) => base.id === selected.knowledgeBaseId)?.publicId || "",
    },
    sourceBinding: contextBindingEvidence(input.knowledgeSource?.binding || null),
    ...(contextItem ? { contextItem } : {}),
    governance,
    userMessage: [
      `当前适用依据为《${selected.name.replace(/\.md$/i, "")}》${selected.versionLabel ? `（${selected.versionLabel}）` : ""}。`,
      governance.historicalVersionFiltered
        ? `知识资格校验已过滤 ${governance.filteredForValidity} 份失效或尚未生效的同系列资料。`
        : "未发现需要因有效期排除的同系列资料。",
    ].join(""),
  };
}

export async function resolveWealthSuitabilityPolicySource(input: {
  userId: number;
  groupId: number;
  actorRole: string;
  roleTemplate: string;
  now?: Date;
  knowledgeSource?: WealthKnowledgeSourceResolution;
}): Promise<WealthPolicySource> {
  const basis = await resolveWealthPolicyBasis(input);
  const selected = basis.selected;
  return {
    ready: basis.status === "ready" && Boolean(selected),
    sourceAssetId: selected?.sourceAssetId || "",
    ...(selected?.knowledgeBaseId ? { knowledgeBaseId: selected.knowledgeBaseId } : {}),
    versionLabel: selected?.versionLabel || "",
    sourceLocator: selected?.sourceLocator || "",
    eligibilityFingerprint: basis.governance.eligibilityFingerprint,
    ...(basis.resolutionReasonCode ? { resolutionReasonCode: basis.resolutionReasonCode } : {}),
    ...(basis.sourceBinding ? { sourceBinding: basis.sourceBinding } : {}),
    ...(basis.contextItem ? { contextItem: basis.contextItem } : {}),
  };
}

export async function resolveWealthPrevisitKnowledgeBasis(input: {
  userId: number;
  groupId: number;
  actorRole: string;
  roleTemplate: string;
  now?: Date;
  knowledgeSource?: WealthKnowledgeSourceResolution;
}): Promise<WealthPrevisitKnowledgeBasis> {
  const now = input.now || new Date();
  const unavailable = (
    eligibilityFingerprint = "",
    resolutionReasonCode: ContextResolutionReasonCodeV1 = "NO_USABLE_CONTEXT",
  ): WealthPrevisitKnowledgeBasis => ({
    status: "unavailable",
    evaluatedAt: now.toISOString(),
    selected: null,
    sourceBinding: contextBindingEvidence(input.knowledgeSource?.binding || null),
    resolutionReasonCode,
    eligibilityFingerprint,
    userMessage: "当前没有通过岗位、密级和有效期校验的访前作业依据；可以整理已核验客户事实，但不能声称符合本行现行访前规范。",
  });
  if (input.roleTemplate !== "wealth-manager") return unavailable("", "NOT_ELIGIBLE");
  const accessibleBases = (await listAccessibleKnowledgeBases({
    userId: input.userId,
    groupId: input.groupId,
    roleTemplate: input.roleTemplate,
  })).filter((base) => base.status === "ready" && ["enterprise", "role"].includes(base.scope));
  if (input.knowledgeSource?.mode === "binding" && !input.knowledgeSource.binding) return unavailable("", "NO_BINDING");
  let bases = accessibleBases;
  if (input.knowledgeSource?.mode === "binding" && input.knowledgeSource.binding) {
    try {
      bases = selectLlamaIndexKnowledgeBases({ binding: input.knowledgeSource.binding, accessibleBases }).knowledgeBases;
    } catch {
      return unavailable("", "NOT_ELIGIBLE");
    }
  }
  if (!bases.length) return unavailable("", "SOURCE_UNAVAILABLE");
  const documents = await listKnowledgeDocumentsForBases(bases.map((base) => base.id));
  const eligibility = buildKnowledgeEligibility({
    bases,
    documents,
    userId: input.userId,
    actorRole: input.actorRole,
    roleTemplate: input.roleTemplate,
    now,
  });
  const eligibleIds = new Set(eligibility.documentIds);
  const selected = documents
    .filter((document) => eligibleIds.has(document.publicId))
    .filter((document) => document.sourceAssetId === "wm-previsit-sop" || /财富客户访前准备作业指导书/u.test(document.name))
    .sort((left, right) => new Date(right.effectiveAt || right.createdAt).getTime() - new Date(left.effectiveAt || left.createdAt).getTime())[0];
  if (!selected) {
    const excluded = eligibility.excludedByReason;
    const resolutionReasonCode: ContextResolutionReasonCodeV1 = Number(excluded.classification_denied || 0) + Number(excluded.role_mismatch || 0) > 0
      ? "NOT_ELIGIBLE"
      : Number(excluded.expired || 0) + Number(excluded.lifecycle_inactive || 0) + Number(excluded.not_effective || 0) > 0
        ? "STALE_ASSET"
        : Number(excluded.base_not_ready || 0) + Number(excluded.document_not_ready || 0) > 0
          ? "SOURCE_UNAVAILABLE"
          : "NO_USABLE_CONTEXT";
    return unavailable(eligibility.fingerprint, resolutionReasonCode);
  }
  const contextItem = resolvedKnowledgeContextItem({
    source: input.knowledgeSource,
    logicalAssetId: "current_previsit_sop",
    assetId: selected.sourceAssetId || selected.publicId,
    assetVersion: selected.versionLabel,
    contentHash: selected.sha256,
    asOf: now.toISOString(),
    sourceDepartment: selected.sourceDepartment,
    authority: selected.authority,
    effectiveAt: selected.effectiveAt,
    documentId: selected.publicId,
  });
  return {
    status: "ready",
    evaluatedAt: now.toISOString(),
    selected: {
      sourceAssetId: selected.sourceAssetId || selected.publicId,
      documentId: selected.publicId,
      versionLabel: selected.versionLabel,
      contentHash: selected.sha256,
      sourceDepartment: selected.sourceDepartment,
      knowledgeBaseId: bases.find((base) => base.id === selected.knowledgeBaseId)?.publicId || "",
    },
    sourceBinding: contextBindingEvidence(input.knowledgeSource?.binding || null),
    ...(contextItem ? { contextItem } : {}),
    eligibilityFingerprint: eligibility.fingerprint,
    userMessage: `已使用当前有效访前作业依据 ${selected.versionLabel}。`,
  };
}
