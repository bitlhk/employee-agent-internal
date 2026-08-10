import {
  listAccessibleKnowledgeBases,
  listKnowledgeDocumentsForBases,
} from "../db";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import type { WealthPolicySource } from "./governance/wealth-suitability-policy";

const DEFAULT_POLICY_DOCUMENT = "15-财富产品适当性销售管理细则（V2.2现行）.md";

export type WealthPolicyBasis = {
  schema: "ea.wealth-policy-basis.v1";
  status: "ready" | "unavailable";
  roleTemplate: string;
  evaluatedAt: string;
  selected: {
    sourceAssetId: string;
    documentName: string;
    versionLabel: string;
    sourceDepartment: string;
    effectiveAt: string | null;
    sourceLocator: string;
  } | null;
  governance: {
    eligibilityFingerprint: string;
    historicalVersionFiltered: boolean;
    filteredForValidity: number;
    unavailableDocuments: number;
    accessRestricted: boolean;
  };
  userMessage: string;
};

function policySeriesKey(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[（(][^）)]*(?:现行|历史|失效|废止)[^）)]*[）)]/g, "")
    .replace(/(?:版本)?\s*[Vv]?\d+(?:\.\d+)*/g, "")
    .replace(/[\s_\-—]+/g, "")
    .trim();
}

export async function resolveWealthPolicyBasis(input: {
  userId: number;
  groupId: number;
  actorRole: string;
  roleTemplate: string;
  now?: Date;
}): Promise<WealthPolicyBasis> {
  const now = input.now || new Date();
  const unavailable = (fingerprint = ""): WealthPolicyBasis => ({
    schema: "ea.wealth-policy-basis.v1",
    status: "unavailable",
    roleTemplate: input.roleTemplate,
    evaluatedAt: now.toISOString(),
    selected: null,
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
  if (input.roleTemplate !== "wealth-manager") return unavailable();

  const bases = (await listAccessibleKnowledgeBases({
    userId: input.userId,
    groupId: input.groupId,
    roleTemplate: input.roleTemplate,
  })).filter((base) => base.status === "ready" && ["enterprise", "role"].includes(base.scope));
  if (!bases.length) return unavailable();

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
  const configuredName = String(process.env.WEALTH_SUITABILITY_POLICY_DOCUMENT || DEFAULT_POLICY_DOCUMENT).trim();
  const configuredSeries = policySeriesKey(configuredName);
  const seriesDocuments = documents.filter((document) => policySeriesKey(document.name) === configuredSeries);
  const candidates = seriesDocuments
    .filter((document) => eligibleIds.has(document.publicId) && document.name === configuredName)
    .sort((left, right) => {
      const authorityRank = { official: 4, approved: 3, reference: 2, personal: 1 } as const;
      const authority = (authorityRank[right.authority] || 0) - (authorityRank[left.authority] || 0);
      return authority || new Date(right.effectiveAt || right.createdAt).getTime() - new Date(left.effectiveAt || left.createdAt).getTime();
    });
  const selected = candidates[0];

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
  if (!selected) return { ...unavailable(eligibility.fingerprint), governance };

  return {
    schema: "ea.wealth-policy-basis.v1",
    status: "ready",
    roleTemplate: input.roleTemplate,
    evaluatedAt: now.toISOString(),
    selected: {
      sourceAssetId: selected.publicId,
      documentName: selected.name,
      versionLabel: selected.versionLabel,
      sourceDepartment: selected.sourceDepartment,
      effectiveAt: selected.effectiveAt,
      sourceLocator: `${selected.name} / 4.1 风险等级匹配`,
    },
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
}): Promise<WealthPolicySource> {
  const basis = await resolveWealthPolicyBasis(input);
  const selected = basis.selected;
  return {
    ready: basis.status === "ready" && Boolean(selected),
    sourceAssetId: selected?.sourceAssetId || "",
    versionLabel: selected?.versionLabel || "",
    sourceLocator: selected?.sourceLocator || "",
    eligibilityFingerprint: basis.governance.eligibilityFingerprint,
  };
}
