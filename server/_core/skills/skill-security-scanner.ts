import type { SkillScanInfo } from "../../../shared/types/skill";

type SecurityFinding = NonNullable<NonNullable<SkillScanInfo["externalSecurity"]>["findings"]>[number];

type SarifResult = {
  ruleId?: unknown;
  level?: unknown;
  message?: { text?: unknown };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: unknown };
      region?: { startLine?: unknown };
    };
  }>;
  partialFingerprints?: { primaryLocationLineHash?: unknown };
  fixes?: Array<{ description?: { text?: unknown } }>;
  properties?: { severity?: unknown };
};

type ScannerResponse = {
  status?: unknown;
  subjectFingerprint?: unknown;
  scanner?: { version?: unknown };
  sarif?: {
    runs?: Array<{ results?: SarifResult[] }>;
  };
  error?: unknown;
};

function enabled(): boolean {
  return String(process.env.EA_SKILL_SECURITY_SCANNER_ENABLED || "false").toLowerCase() === "true";
}

function scannerUrl(): string {
  return String(process.env.EA_SKILL_SECURITY_SCANNER_URL || "http://127.0.0.1:18920").replace(/\/$/, "");
}

function timeoutMs(): number {
  const parsed = Number(process.env.EA_SKILL_SECURITY_SCANNER_TIMEOUT_MS || 660_000);
  return Number.isFinite(parsed) ? Math.max(10_000, Math.min(parsed, 900_000)) : 660_000;
}

function severityOf(result: SarifResult): SecurityFinding["severity"] {
  const source = String(result.properties?.severity || result.level || "").trim().toLowerCase();
  if (source.includes("critical")) return "critical";
  if (source.includes("high") || source === "error") return "high";
  if (source.includes("medium") || source === "warning") return "medium";
  if (source.includes("low") || source === "note") return "low";
  return "info";
}

function normalizeFinding(result: SarifResult, index: number): SecurityFinding {
  const location = result.locations?.[0]?.physicalLocation;
  const startLine = Number(location?.region?.startLine);
  return {
    ruleId: String(result.ruleId || `AIG-${index + 1}`),
    severity: severityOf(result),
    message: String(result.message?.text || "未提供风险说明"),
    file: location?.artifactLocation?.uri ? String(location.artifactLocation.uri) : undefined,
    startLine: Number.isInteger(startLine) && startLine > 0 ? startLine : undefined,
    fingerprint: result.partialFingerprints?.primaryLocationLineHash
      ? String(result.partialFingerprints.primaryLocationLineHash)
      : undefined,
    remediation: result.fixes?.[0]?.description?.text
      ? String(result.fixes[0].description.text)
      : undefined,
  };
}

function summarize(findings: SecurityFinding[]) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

export function skillSecurityScannerEnabled(): boolean {
  return enabled();
}

export function pendingSkillSecurityScan(subjectFingerprint: string): NonNullable<SkillScanInfo["externalSecurity"]> {
  return {
    provider: "aig-skill-scan",
    mode: "observe",
    status: "pending",
    subjectFingerprint,
  };
}

export async function scanSkillPackageSecurity(input: {
  file: Buffer;
  filename: string;
  subjectFingerprint: string;
}): Promise<NonNullable<SkillScanInfo["externalSecurity"]>> {
  const scannedAt = new Date().toISOString();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(input.file.length),
      "X-Skill-Filename": input.filename,
      "X-Subject-SHA256": input.subjectFingerprint,
    };
    const token = String(process.env.EA_SKILL_SECURITY_SCANNER_TOKEN || "");
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${scannerUrl()}/v1/skill-scans`, {
      method: "POST",
      headers,
      body: new Uint8Array(input.file),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    const body = await response.json().catch(() => ({})) as ScannerResponse;
    if (!response.ok || body.status !== "completed") {
      throw new Error(String(body.error || `scanner returned HTTP ${response.status}`));
    }
    if (String(body.subjectFingerprint || "") !== input.subjectFingerprint) {
      throw new Error("scanner returned a mismatched subject fingerprint");
    }
    const findings = (body.sarif?.runs || [])
      .flatMap((run) => Array.isArray(run.results) ? run.results : [])
      .slice(0, 200)
      .map(normalizeFinding);
    return {
      provider: "aig-skill-scan",
      mode: "observe",
      status: "completed",
      subjectFingerprint: input.subjectFingerprint,
      scannerVersion: body.scanner?.version ? String(body.scanner.version) : undefined,
      findings,
      summary: summarize(findings),
      scannedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill security scan failed";
    return {
      provider: "aig-skill-scan",
      mode: "observe",
      status: "failed",
      subjectFingerprint: input.subjectFingerprint,
      errorCode: /timeout/i.test(message) ? "SCANNER_TIMEOUT" : "SCANNER_UNAVAILABLE",
      scannedAt,
    };
  }
}
