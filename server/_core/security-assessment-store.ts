import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "./helpers";
import { writeJsonFileAtomicSync } from "./atomic-json-file";

export type SecurityAssessmentKey = "agent_redteam" | "prompt_eval";

export type SecurityAssessmentRecord = {
  key: SecurityAssessmentKey;
  provider: string;
  status: "running" | "completed" | "failed";
  verdict: "pending" | "pass" | "review" | "risk" | "error";
  targetId: string;
  targetLabel?: string;
  isolated: boolean;
  configFingerprint: string;
  toolVersion?: string;
  summary?: {
    totalTests: number;
    vulnerableTests: number;
    high: number;
    medium: number;
    low: number;
  };
  reportFingerprint?: string;
  reportPath?: string;
  errorCode?: string;
  requestedAt: string;
  completedAt?: string;
};

const STORE_PATH = path.join(APP_ROOT, "data", "security-assessments.json");

function readStore(): Partial<Record<SecurityAssessmentKey, SecurityAssessmentRecord>> {
  try {
    if (!existsSync(STORE_PATH)) return {};
    const value = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function getSecurityAssessment(key: SecurityAssessmentKey): SecurityAssessmentRecord | null {
  return readStore()[key] || null;
}

export function saveSecurityAssessment(record: SecurityAssessmentRecord): void {
  writeJsonFileAtomicSync(STORE_PATH, { ...readStore(), [record.key]: record });
}
