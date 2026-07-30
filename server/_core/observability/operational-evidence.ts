export type ReleaseEvidenceRow = {
  action: "prepare" | "deploy" | "rollback";
  result: "success" | "failed";
  timestampSeconds: number;
};

export type RestoreDrillEvidence = {
  rpoSeconds: number;
  rtoSeconds: number;
};

const RELEASE_ACTIONS = new Set<ReleaseEvidenceRow["action"]>(["prepare", "deploy", "rollback"]);
const RELEASE_RESULTS = new Set<ReleaseEvidenceRow["result"]>(["success", "failed"]);

export function parseReleaseEvidence(
  text: string,
  options: { nowMs?: number; windowMs?: number } = {},
): ReleaseEvidenceRow[] {
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = options.windowMs ?? 30 * 24 * 60 * 60 * 1_000;
  const oldestMs = nowMs - windowMs;
  const rows: ReleaseEvidenceRow[] = [];

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const action = String(raw.action || "") as ReleaseEvidenceRow["action"];
      const result = String(raw.result || "") as ReleaseEvidenceRow["result"];
      const timestampMs = Date.parse(String(raw.time || ""));
      if (!RELEASE_ACTIONS.has(action) || !RELEASE_RESULTS.has(result)) continue;
      if (!Number.isFinite(timestampMs) || timestampMs < oldestMs || timestampMs > nowMs + 60_000) continue;
      rows.push({ action, result, timestampSeconds: timestampMs / 1_000 });
    } catch {
      continue;
    }
  }
  return rows;
}

export function parseRestoreDrillEvidence(text: string): RestoreDrillEvidence | null {
  const values = new Map<string, string>();
  for (const line of String(text || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (values.get("result") !== "passed") return null;
  const rpoSeconds = Number(values.get("rpo_seconds"));
  const rtoSeconds = Number(values.get("rto_seconds"));
  if (!Number.isFinite(rpoSeconds) || rpoSeconds < 0) return null;
  if (!Number.isFinite(rtoSeconds) || rtoSeconds < 0) return null;
  return { rpoSeconds, rtoSeconds };
}
