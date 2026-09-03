const CUSTOMER_REQUIRED_FIELD_LABELS: Record<string, string> = {
  "subject.displayName": "客户姓名",
  "subject.customerStatus": "客户状态",
  "relationship.recentContactSummary": "最近联系摘要",
  "risk.investmentRiskLevel": "风险等级",
  "risk.investmentRiskValidUntil": "风险测评有效期",
  "preferences.investmentHorizon": "投资期限",
  "preferences.liquidityNeeds": "流动性需求",
};

function payloadFromError(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  if (record.dependencyError) return payloadFromError(record.dependencyError);
  const payload = record.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

export function customerProfileRequiredFieldIssue(
  error: unknown,
): { paths: string[]; labels: string[] } | null {
  const payload = payloadFromError(error);
  if (!payload) return null;
  const reasonCodes = Array.isArray(payload.reasonCodes)
    ? payload.reasonCodes.map(String)
    : [];
  if (!reasonCodes.includes("CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING")) {
    return null;
  }
  const paths = Array.isArray(payload.missingRequiredFields)
    ? Array.from(new Set(
      payload.missingRequiredFields
        .map(value => String(value || "").trim())
        .filter(Boolean),
    ))
    : [];
  return {
    paths,
    labels: paths.map(path => CUSTOMER_REQUIRED_FIELD_LABELS[path] || path),
  };
}
