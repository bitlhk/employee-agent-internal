import { governanceFingerprint } from "./contracts";
import type {
  ReadinessCheck,
  TaskReadinessDecision,
  TaskReadinessStatus,
} from "./task-execution-envelope";

export type TaskReadinessProfile = {
  taskId: string;
  requestedOutcome: string;
  requiredChecks: string[];
  fallbackOutcomes: string[];
};

export function readinessCheck(
  status: ReadinessCheck["status"],
  code: string,
  message: string,
  options: Pick<ReadinessCheck, "retryable" | "asOf"> = {},
): ReadinessCheck {
  return { status, code, message, ...options };
}

export function evaluateTaskReadiness(input: {
  profile: TaskReadinessProfile;
  checks: Record<string, ReadinessCheck>;
  requestedOutcome?: string;
}): TaskReadinessDecision {
  const checks: Record<string, ReadinessCheck> = { ...input.checks };
  for (const name of input.profile.requiredChecks) {
    checks[name] ||= readinessCheck("BLOCKED", "READINESS_CHECK_MISSING", `${name} 就绪检查缺失。`);
  }
  const relevant = input.profile.requiredChecks.map((name) => checks[name]);
  const status: TaskReadinessStatus = relevant.some((check) => check.status === "BLOCKED")
    ? "BLOCKED"
    : relevant.some((check) => check.status === "DEGRADED")
      ? "DEGRADED"
      : "READY";
  const requestedOutcome = String(input.requestedOutcome || input.profile.requestedOutcome).trim();
  const fallbackOutcomes = status === "READY" ? [] : input.profile.fallbackOutcomes;
  const body = {
    taskId: input.profile.taskId,
    status,
    requestedOutcome,
    checks,
    allowedOutcomes: status === "READY" ? [requestedOutcome] : fallbackOutcomes,
    deniedOutcomes: status === "READY" ? [] : [requestedOutcome],
    fallbackOutcomes,
    reasons: relevant
      .filter((check) => check.status === "BLOCKED" || check.status === "DEGRADED")
      .map((check) => check.message),
    remediation: relevant
      .filter((check) => check.status !== "READY" && check.status !== "NOT_REQUIRED")
      .map((check) => check.retryable ? "依赖恢复后重试。" : check.message)
      .filter((value, index, values) => values.indexOf(value) === index),
  };
  return { ...body, decisionFingerprint: governanceFingerprint(body) };
}
