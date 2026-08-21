export type AssetDiagnostic = {
  code?: unknown;
  field?: unknown;
  message?: unknown;
  severity?: unknown;
  resolvedAt?: unknown;
};

export type AssetIssueGroup =
  | "all"
  | "owner"
  | "effective_at"
  | "version"
  | "duplicate"
  | "parsing"
  | "role"
  | "suggestion";

export const ASSET_ISSUE_GROUPS: Array<{ id: AssetIssueGroup; label: string }> =
  [
    { id: "all", label: "全部问题" },
    { id: "owner", label: "缺 Owner" },
    { id: "effective_at", label: "缺生效时间" },
    { id: "version", label: "版本问题" },
    { id: "duplicate", label: "重复资产" },
    { id: "parsing", label: "解析异常" },
    { id: "role", label: "岗位待确认" },
    { id: "suggestion", label: "建议生成异常" },
  ];

const ISSUE_CODES: Record<Exclude<AssetIssueGroup, "all">, Set<string>> = {
  owner: new Set(["MISSING_OWNER"]),
  effective_at: new Set(["MISSING_EFFECTIVE_DATE"]),
  version: new Set(["MISSING_VERSION", "SUSPECTED_OLD_VERSION"]),
  duplicate: new Set(["DUPLICATE_CONTENT"]),
  parsing: new Set([
    "CONTENT_PARSE_FAILED",
    "OCR_FAILED",
    "TABLE_PARSE_ANOMALY",
  ]),
  role: new Set(["ROLE_UNRESOLVED"]),
  suggestion: new Set(["MODEL_SUGGESTION_FAILED"]),
};

export function unresolvedAssetDiagnostics(value: unknown): AssetDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    item =>
      item && typeof item === "object" && !(item as AssetDiagnostic).resolvedAt
  ) as AssetDiagnostic[];
}

export function diagnosticMatchesIssue(
  diagnostic: AssetDiagnostic,
  issue: AssetIssueGroup
): boolean {
  if (issue === "all") return true;
  return ISSUE_CODES[issue].has(String(diagnostic.code || ""));
}

export function assetMatchesIssue(
  diagnostics: unknown,
  issue: AssetIssueGroup
): boolean {
  const unresolved = unresolvedAssetDiagnostics(diagnostics);
  return (
    unresolved.length > 0 &&
    unresolved.some(item => diagnosticMatchesIssue(item, issue))
  );
}

export function countAssetIssues<T extends { diagnosticsJson?: unknown }>(
  candidates: T[]
): Record<AssetIssueGroup, number> {
  return Object.fromEntries(
    ASSET_ISSUE_GROUPS.map(group => [
      group.id,
      candidates.filter(candidate =>
        assetMatchesIssue(candidate.diagnosticsJson, group.id)
      ).length,
    ])
  ) as Record<AssetIssueGroup, number>;
}

export function normalizedReviewMetadata(
  value: unknown
): Record<string, unknown> {
  const metadata =
    value && typeof value === "object"
      ? { ...(value as Record<string, unknown>) }
      : {};
  metadata.businessDomain = String(
    metadata.businessDomain || metadata.suggestedDomain || "general"
  );
  metadata.logicalAssetIds = Array.isArray(metadata.logicalAssetIds)
    ? metadata.logicalAssetIds
    : Array.isArray(metadata.logicalAssetCandidates)
      ? metadata.logicalAssetCandidates
      : [];
  metadata.applicableOrganizations = Array.isArray(
    metadata.applicableOrganizations
  )
    ? metadata.applicableOrganizations
    : [];
  metadata.relatedTasks = Array.isArray(metadata.relatedTasks)
    ? metadata.relatedTasks
    : [];
  metadata.policyCandidates = Array.isArray(metadata.policyCandidates)
    ? metadata.policyCandidates
    : [];
  metadata.externalProcessingAllowed = Boolean(
    metadata.externalProcessingAllowed
  );
  delete metadata.enterpriseId;
  delete metadata.suggestedDomain;
  delete metadata.logicalAssetCandidates;
  delete metadata.suggestionMethod;
  return metadata;
}

export function suggestionSourceLabel(value: unknown): string {
  return value === "model_assisted" ? "平台模型建议" : "确定性规则建议";
}

export function suggestionSourceEvidence(value: unknown): string {
  return value === "model_assisted"
    ? "依据文件路径、文件名及获准处理的有限正文摘要生成"
    : "依据文件路径、文件名与接入来源规则生成";
}

export function toLocalDateTimeInput(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalDateTimeInput(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map(item => item.trim())
      .filter(Boolean);
  return String(value || "")
    .split(/[\n,，]/)
    .map(item => item.trim())
    .filter(Boolean);
}
