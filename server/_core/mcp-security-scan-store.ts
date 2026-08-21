import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "./helpers";
import { writeJsonFileAtomicSync } from "./atomic-json-file";
import { withSerializedFileMutation } from "./serialized-file-mutation";

export type McpSecurityFinding = {
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  message: string;
  file?: string;
  startLine?: number;
  remediation?: string;
};

export type McpSecurityScanRecord = {
  serverId: string;
  provider: "aig-mcp-scan";
  mode: "observe";
  scanType: "source_static";
  status: "pending" | "completed" | "failed";
  verdict: "pending" | "pass" | "review" | "block" | "error";
  subjectFingerprint: string;
  scannerVersion?: string;
  summary?: { critical: number; high: number; medium: number; low: number; info: number };
  findings?: McpSecurityFinding[];
  errorCode?: string;
  requestedAt: string;
  scannedAt?: string;
};

const STORE_PATH = path.join(APP_ROOT, "data", "mcp-security-scans.json");

function readStore(): Record<string, McpSecurityScanRecord> {
  try {
    if (!existsSync(STORE_PATH)) return {};
    const value = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function getMcpSecurityScan(serverId: string): McpSecurityScanRecord | null {
  return readStore()[serverId] || null;
}

export function listMcpSecurityScans(): McpSecurityScanRecord[] {
  return Object.values(readStore()).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function saveMcpSecurityScan(record: McpSecurityScanRecord): Promise<void> {
  await withSerializedFileMutation(STORE_PATH, async () => {
    const store = readStore();
    store[record.serverId] = record;
    writeJsonFileAtomicSync(STORE_PATH, store);
  });
}
