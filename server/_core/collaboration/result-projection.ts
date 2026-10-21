type ResultRecord = {
  resultSummary?: string | null;
  resultMeta?: string | null;
};

export function parseCollaborationResultMeta(
  raw: string | null | undefined
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Agent callers receive only the recipient's released conclusion. In particular,
// arbitrary structured_outputs and internal child requests never cross this boundary.
export function projectCollaborationConclusion(
  row: ResultRecord,
  allowSummary: boolean
) {
  const meta = parseCollaborationResultMeta(row.resultMeta);
  if (meta.deliverMode === "none") return { shared: false, summary: "" };
  if (meta.deliverMode === "full" || meta.deliverMode === "summary") {
    return {
      shared: true,
      summary:
        typeof meta.deliveredContent === "string"
          ? meta.deliveredContent.slice(0, 2000)
          : "",
    };
  }
  return {
    shared: allowSummary,
    summary: allowSummary ? (row.resultSummary || "").slice(0, 2000) : "",
  };
}

// Preserve the legacy UI envelope unless an owner has explicitly restricted it.
export function projectLegacyCollaborationResult(row: ResultRecord) {
  const meta = parseCollaborationResultMeta(row.resultMeta);
  if (meta.deliverMode === "none")
    return { resultSummary: "", resultMeta: { deliverMode: "none" } };
  if (meta.deliverMode === "summary") {
    const summary =
      typeof meta.deliveredContent === "string" ? meta.deliveredContent : "";
    return {
      resultSummary: summary,
      resultMeta: {
        deliverMode: "summary",
        summary,
        deliveredContent: summary,
        deliveredAt: meta.deliveredAt,
      },
    };
  }
  return {
    resultSummary: row.resultSummary,
    resultMeta: row.resultMeta ? meta : null,
  };
}
