import type { McpSecurityFinding, McpSecurityScanRecord } from "./mcp-security-scan-store";

type SarifResult = {
  ruleId?: unknown;
  level?: unknown;
  message?: { text?: unknown };
  locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } }>;
  fixes?: Array<{ description?: { text?: unknown } }>;
  properties?: { severity?: unknown };
};

type ScannerResponse = {
  status?: unknown;
  subjectFingerprint?: unknown;
  scanner?: { version?: unknown };
  sarif?: { runs?: Array<{ results?: SarifResult[] }> };
  error?: unknown;
};

export function mcpSecurityScannerEnabled(): boolean {
  return String(process.env.EA_MCP_SECURITY_SCANNER_ENABLED || "false").toLowerCase() === "true";
}

function scannerUrl(): string {
  return String(process.env.EA_MCP_SECURITY_SCANNER_URL || process.env.EA_SKILL_SECURITY_SCANNER_URL || "http://127.0.0.1:18920").replace(/\/$/, "");
}

function severity(result: SarifResult): McpSecurityFinding["severity"] {
  const value = String(result.properties?.severity || result.level || "").toLowerCase();
  if (value.includes("critical")) return "critical";
  if (value.includes("high") || value === "error") return "high";
  if (value.includes("medium") || value === "warning") return "medium";
  if (value.includes("low") || value === "note") return "low";
  return "info";
}

function normalize(result: SarifResult, index: number): McpSecurityFinding {
  const location = result.locations?.[0]?.physicalLocation;
  const line = Number(location?.region?.startLine);
  return {
    ruleId: String(result.ruleId || `MCP-${index + 1}`),
    severity: severity(result),
    message: String(result.message?.text || "未提供风险说明"),
    file: location?.artifactLocation?.uri ? String(location.artifactLocation.uri) : undefined,
    startLine: Number.isInteger(line) && line > 0 ? line : undefined,
    remediation: result.fixes?.[0]?.description?.text ? String(result.fixes[0].description.text) : undefined,
  };
}

export function pendingMcpSecurityScan(serverId: string, fingerprint: string): McpSecurityScanRecord {
  return { serverId, provider: "aig-mcp-scan", mode: "observe", scanType: "source_static", status: "pending", verdict: "pending", subjectFingerprint: fingerprint, requestedAt: new Date().toISOString() };
}

export async function scanMcpSourceSecurity(input: { serverId: string; file: Buffer; fingerprint: string }): Promise<McpSecurityScanRecord> {
  const scannedAt = new Date().toISOString();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(input.file.length),
      "X-Subject-SHA256": input.fingerprint,
    };
    const token = String(process.env.EA_MCP_SECURITY_SCANNER_TOKEN || process.env.EA_SKILL_SECURITY_SCANNER_TOKEN || "");
    if (token) headers.Authorization = `Bearer ${token}`;
    const timeout = Math.max(30_000, Math.min(Number(process.env.EA_MCP_SECURITY_SCANNER_TIMEOUT_MS || 1_260_000), 1_800_000));
    const response = await fetch(`${scannerUrl()}/v1/mcp-scans`, { method: "POST", headers, body: new Uint8Array(input.file), signal: AbortSignal.timeout(timeout) });
    const body = await response.json().catch(() => ({})) as ScannerResponse;
    if (!response.ok || body.status !== "completed") throw new Error(String(body.error || `scanner returned HTTP ${response.status}`));
    if (String(body.subjectFingerprint || "") !== input.fingerprint) throw new Error("scanner returned a mismatched subject fingerprint");
    const findings = (body.sarif?.runs || []).flatMap(run => Array.isArray(run.results) ? run.results : []).slice(0, 300).map(normalize);
    const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) summary[finding.severity]++;
    const verdict = summary.critical + summary.high > 0 ? "block" : summary.medium > 0 ? "review" : "pass";
    return { ...pendingMcpSecurityScan(input.serverId, input.fingerprint), status: "completed", verdict, scannerVersion: body.scanner?.version ? String(body.scanner.version) : undefined, summary, findings, scannedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...pendingMcpSecurityScan(input.serverId, input.fingerprint), status: "failed", verdict: "error", errorCode: /timeout/i.test(message) ? "SCANNER_TIMEOUT" : "SCANNER_UNAVAILABLE", scannedAt };
  }
}
