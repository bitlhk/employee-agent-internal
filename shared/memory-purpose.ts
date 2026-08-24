export const MEMORY_PURPOSE_SCOPE_SCHEMA = "ea.memory-purpose-scope.v1" as const;
export const MEMORY_PURPOSE_FILTER_EVIDENCE_SCHEMA = "ea.memory-purpose-filter-evidence.v1" as const;

export type GovernedMemoryVisibilityV1 =
  | "principal_private"
  | "role_private"
  | "enterprise_shared";

export type MemoryPurposeScopeV1 = {
  schema: typeof MEMORY_PURPOSE_SCOPE_SCHEMA;
  organizationId: string;
  visibilityClass: GovernedMemoryVisibilityV1;
  purposeIds: string[];
  subjectId?: string;
  scopeVersion: string;
  provenance: {
    source: "human_confirmed" | "governed_work" | "migration" | "system";
    recordedBy: string;
    recordedAt: string;
    reason?: string;
  };
};

export type MemoryRetrievalScopeV1 = {
  organizationId: string;
  userId: number;
  adoptionId: string;
  roleTemplate: string;
  rolePackId: string;
  purposeId: string;
  requestedPurpose: string;
  subjectId?: string;
};

export type MemoryPurposeFilterEvidenceV1 = {
  schema: typeof MEMORY_PURPOSE_FILTER_EVIDENCE_SCHEMA;
  requestedPurposeId: string;
  requestedPurpose: string;
  appliedPurposeFilter: true;
  scopeVersion: string;
  candidateRecordCount: number;
  filteredRecordCount: number;
  eligibleRecordCount: number;
  returnedRecordCount: number;
  filterFingerprint: string;
};

export type PurposeScopedRecordV1 = {
  organizationId?: string | null;
  userId: number;
  adoptionId: string;
  roleTemplate: string;
  visibilityClass?: GovernedMemoryVisibilityV1 | null;
  purposeIds?: string[] | null;
  subjectId?: string | null;
  purposeScopeVersion?: string | null;
};

export function canonicalPurposeIdForRoleTemplate(roleTemplate: string): string {
  if (roleTemplate === "wealth-manager") return "wealth_advisory";
  if (roleTemplate === "insurance-advisor") return "insurance_advisory";
  const normalized = String(roleTemplate || "general")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "general";
  return `role_${normalized}`;
}

export function normalizePurposeIds(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values || []).map(value => String(value || "").trim()).filter(Boolean))].sort();
}

export function isPurposeScopedRecordVisible(
  record: PurposeScopedRecordV1,
  scope: MemoryRetrievalScopeV1,
): boolean {
  if (!record.organizationId || record.organizationId !== scope.organizationId) return false;
  if (!normalizePurposeIds(record.purposeIds).includes(scope.purposeId)) return false;
  if (record.subjectId && record.subjectId !== scope.subjectId) return false;

  const visibility = record.visibilityClass || "principal_private";
  if (visibility === "enterprise_shared") return true;
  if (visibility === "role_private") return record.roleTemplate === scope.roleTemplate;
  return record.userId === scope.userId && record.adoptionId === scope.adoptionId;
}
