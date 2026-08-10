import {
  listAccessibleKnowledgeBases,
  listKnowledgeDocumentsForBases,
} from "../db";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import type { WealthPolicySource } from "./governance/wealth-suitability-policy";

const DEFAULT_POLICY_DOCUMENT = "15-财富产品适当性销售管理细则（V2.2现行）.md";

export async function resolveWealthSuitabilityPolicySource(input: {
  userId: number;
  groupId: number;
  actorRole: string;
  roleTemplate: string;
  now?: Date;
}): Promise<WealthPolicySource> {
  const empty: WealthPolicySource = {
    ready: false,
    sourceAssetId: "",
    versionLabel: "",
    sourceLocator: "",
    eligibilityFingerprint: "",
  };
  if (input.roleTemplate !== "wealth-manager") return empty;
  const bases = (await listAccessibleKnowledgeBases({
    userId: input.userId,
    groupId: input.groupId,
    roleTemplate: input.roleTemplate,
  })).filter((base) => base.status === "ready" && ["enterprise", "role"].includes(base.scope));
  if (!bases.length) return empty;
  const documents = await listKnowledgeDocumentsForBases(bases.map((base) => base.id));
  const eligibility = buildKnowledgeEligibility({
    bases,
    documents,
    userId: input.userId,
    actorRole: input.actorRole,
    roleTemplate: input.roleTemplate,
    now: input.now,
  });
  const eligibleIds = new Set(eligibility.documentIds);
  const configuredName = String(process.env.WEALTH_SUITABILITY_POLICY_DOCUMENT || DEFAULT_POLICY_DOCUMENT).trim();
  const candidates = documents
    .filter((document) => eligibleIds.has(document.publicId) && document.name === configuredName)
    .sort((left, right) => {
      const authorityRank = { official: 4, approved: 3, reference: 2, personal: 1 } as const;
      const authority = (authorityRank[right.authority] || 0) - (authorityRank[left.authority] || 0);
      return authority || new Date(right.effectiveAt || right.createdAt).getTime() - new Date(left.effectiveAt || left.createdAt).getTime();
    });
  const selected = candidates[0];
  if (!selected) return { ...empty, eligibilityFingerprint: eligibility.fingerprint };
  return {
    ready: true,
    sourceAssetId: selected.publicId,
    versionLabel: selected.versionLabel,
    sourceLocator: `${selected.name} / 4.1 风险等级匹配`,
    eligibilityFingerprint: eligibility.fingerprint,
  };
}
