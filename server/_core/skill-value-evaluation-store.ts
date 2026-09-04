import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { governanceFingerprint } from "./governance/contracts";
import type { SkillValueEvaluationJob } from "./skill-value-evaluation-runner";

const JOB_MEMORY_TTL_MS = 2 * 60 * 60 * 1_000;
const JOB_HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const JOB_STORE_DIR = String(process.env.EA_SKILL_EVAL_JOB_DIR || "").trim()
  || path.join(process.cwd(), "data", "skill-value-evaluation-jobs");

export function evaluationOrganizationKey(organization: string): string {
  return createHash("sha256")
    .update(organization.trim() || "default", "utf8")
    .digest("hex")
    .slice(0, 10);
}

export function isTerminalEvaluationStatus(status: SkillValueEvaluationJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function persistedJobPath(jobId: string): string | null {
  if (!/^skill-eval-[A-Za-z0-9-]+$/u.test(jobId)) return null;
  return path.join(JOB_STORE_DIR, `${jobId}.json`);
}

function reportFingerprint(job: SkillValueEvaluationJob): string {
  return governanceFingerprint({
    ...job,
    queuePosition: null,
    reportFingerprint: null,
  });
}

export function persistSkillValueEvaluationJob(job: SkillValueEvaluationJob): void {
  const targetPath = persistedJobPath(job.jobId);
  if (!targetPath) return;
  try {
    mkdirSync(JOB_STORE_DIR, { recursive: true, mode: 0o700 });
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    console.error("[SkillValueEval] Failed to persist job", job.jobId, error);
  }
}

export function finalizeSkillValueEvaluationJob(job: SkillValueEvaluationJob): void {
  job.queuePosition = null;
  job.reportFingerprint = reportFingerprint(job);
  persistSkillValueEvaluationJob(job);
}

function normalizeInterruptedJob(job: SkillValueEvaluationJob): void {
  job.status = "failed";
  job.queuePosition = null;
  job.stageLabel = "评测服务在执行期间重启";
  job.error = "服务在评测过程中重启，本轮未完成，请重新运行。";
  job.updatedAt = new Date().toISOString();
  finalizeSkillValueEvaluationJob(job);
}

function normalizeLegacyJob(job: SkillValueEvaluationJob): void {
  job.queuePosition ??= null;
  job.organizationKey ??= "legacy";
  job.reportFingerprint ??= null;
  job.preflight ??= {
    skillId: job.skillId,
    status: "unchecked",
    canProceed: true,
    message: "历史任务未记录环境预检结果",
    checkedAt: job.createdAt,
    servers: [],
  };
}

export function loadSkillValueEvaluationJob(
  jobId: string,
  liveJobs: Map<string, SkillValueEvaluationJob>,
): SkillValueEvaluationJob | null {
  const targetPath = persistedJobPath(jobId);
  if (!targetPath || !existsSync(targetPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(targetPath, "utf8")) as SkillValueEvaluationJob;
    if (!parsed || parsed.jobId !== jobId) return null;
    normalizeLegacyJob(parsed);
    if (["queued", "preparing", "running", "judging"].includes(parsed.status)) {
      normalizeInterruptedJob(parsed);
    }
    liveJobs.set(jobId, parsed);
    return parsed;
  } catch (error) {
    console.error("[SkillValueEval] Failed to load persisted job", jobId, error);
    return null;
  }
}

export function cleanupSkillValueEvaluationJobs(liveJobs: Map<string, SkillValueEvaluationJob>): void {
  const memoryCutoff = Date.now() - JOB_MEMORY_TTL_MS;
  const historyCutoff = Date.now() - JOB_HISTORY_TTL_MS;
  for (const [jobId, job] of liveJobs) {
    if (isTerminalEvaluationStatus(job.status) && Date.parse(job.updatedAt) < memoryCutoff) {
      liveJobs.delete(jobId);
    }
  }
  if (!existsSync(JOB_STORE_DIR)) return;
  try {
    for (const entry of readdirSync(JOB_STORE_DIR)) {
      if (!entry.startsWith("skill-eval-") || !entry.endsWith(".json")) continue;
      const targetPath = path.join(JOB_STORE_DIR, entry);
      if (statSync(targetPath).mtimeMs < historyCutoff) rmSync(targetPath, { force: true });
    }
  } catch (error) {
    console.error("[SkillValueEval] Failed to clean persisted jobs", error);
  }
}

export function listPersistedSkillValueEvaluationJobs(input: {
  skillId: string;
  organization: string;
  liveJobs: Map<string, SkillValueEvaluationJob>;
  limit?: number;
}): SkillValueEvaluationJob[] {
  cleanupSkillValueEvaluationJobs(input.liveJobs);
  if (!existsSync(JOB_STORE_DIR)) return [];
  const organizationKey = evaluationOrganizationKey(input.organization);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const collected: SkillValueEvaluationJob[] = [];
  try {
    for (const entry of readdirSync(JOB_STORE_DIR)) {
      if (!entry.startsWith("skill-eval-") || !entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(JOB_STORE_DIR, entry), "utf8")) as SkillValueEvaluationJob;
        normalizeLegacyJob(parsed);
        if (["queued", "preparing", "running", "judging"].includes(parsed.status)) {
          const liveJob = input.liveJobs.get(parsed.jobId);
          if (liveJob && !isTerminalEvaluationStatus(liveJob.status)) continue;
          normalizeInterruptedJob(parsed);
        }
        if (
          parsed.skillId === input.skillId
          && parsed.organizationKey === organizationKey
          && isTerminalEvaluationStatus(parsed.status)
        ) collected.push(parsed);
      } catch {
        // A partial or obsolete report must not hide valid history.
      }
    }
  } catch (error) {
    console.error("[SkillValueEval] Failed to list persisted jobs", error);
  }
  return collected
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit)
    .map(job => structuredClone(job));
}
