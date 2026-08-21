import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Skill, SkillScanInfo } from "../../../shared/types/skill";
import { APP_ROOT } from "../helpers";
import { logError } from "../observability/logger";
import { writeJsonFileAtomicSync } from "../atomic-json-file";
import { buildSkillSecuritySubject } from "./skill-security-package";
import { skillRegistry } from "./skill-registry";
import {
  pendingSkillSecurityScan,
  scanSkillPackageSecurity,
  skillSecurityScannerEnabled,
} from "./skill-security-scanner";
import { runSkillWork } from "./skill-work-queues";
import path from "node:path";

export type SkillSecurityBackfillStatus = {
  runId: string | null;
  status: "idle" | "running" | "completed" | "failed";
  total: number;
  processed: number;
  scanned: number;
  reused: number;
  skippedCurrent: number;
  skippedMissing: number;
  failed: number;
  currentSkill?: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
};

const STATUS_PATH = path.join(APP_ROOT, "data", "skill-security-backfill.json");
let activeRun: Promise<void> | null = null;

function emptyStatus(): SkillSecurityBackfillStatus {
  return { runId: null, status: "idle", total: 0, processed: 0, scanned: 0, reused: 0, skippedCurrent: 0, skippedMissing: 0, failed: 0 };
}

function saveStatus(status: SkillSecurityBackfillStatus): void {
  writeJsonFileAtomicSync(STATUS_PATH, status);
}

export function skillSecurityBackfillStatus(): SkillSecurityBackfillStatus {
  let stored = emptyStatus();
  try {
    if (existsSync(STATUS_PATH)) stored = JSON.parse(readFileSync(STATUS_PATH, "utf8")) as SkillSecurityBackfillStatus;
  } catch {}
  if (stored.status === "running" && !activeRun) {
    return { ...stored, status: "failed", completedAt: new Date().toISOString(), lastError: "扫描进程已重启，请重新发起补扫" };
  }
  return stored;
}

function scanInfo(skill: Skill, externalSecurity: NonNullable<SkillScanInfo["externalSecurity"]>): SkillScanInfo {
  return {
    warnings: skill.scan?.warnings || [],
    scannedAt: new Date().toISOString(),
    externalSecurity,
  };
}

async function updateSkillSecurity(skill: Skill, externalSecurity: NonNullable<SkillScanInfo["externalSecurity"]>, expected?: string) {
  const updated = await skillRegistry.updateScan(skill.adoptId, skill.id, scanInfo(skill, externalSecurity), expected ? { expectedSecurityFingerprint: expected } : {});
  if (!updated.ok && updated.error.kind !== "validation_failed") throw new Error(updated.error.detail);
}

async function executeBackfill(initial: SkillSecurityBackfillStatus): Promise<void> {
  let status = initial;
  const listed = await skillRegistry.listAllSkills();
  if (!listed.ok) throw new Error(listed.error.detail);
  const skills = listed.value;
  status = { ...status, total: skills.length };
  saveStatus(status);
  const resultByFingerprint = new Map<string, NonNullable<SkillScanInfo["externalSecurity"]>>();

  for (const skill of skills) {
    status = { ...status, currentSkill: `${skill.adoptId}/${skill.id}` };
    saveStatus(status);
    try {
      const subject = buildSkillSecuritySubject(skill);
      const current = skill.scan?.externalSecurity;
      if (current?.status === "completed" && current.subjectFingerprint === subject.fingerprint) {
        status.skippedCurrent++;
      } else {
        await updateSkillSecurity(skill, pendingSkillSecurityScan(subject.fingerprint));
        let result = resultByFingerprint.get(subject.fingerprint);
        if (result) {
          status.reused++;
        } else {
          result = await runSkillWork("security", () => scanSkillPackageSecurity({
            file: subject.file,
            filename: subject.filename,
            subjectFingerprint: subject.fingerprint,
          }));
          resultByFingerprint.set(subject.fingerprint, result);
          status.scanned++;
        }
        await updateSkillSecurity(skill, result, subject.fingerprint);
        if (result.status === "failed") status.failed++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/不存在|缺少根级|不是目录/u.test(message)) status.skippedMissing++;
      else status.failed++;
      status.lastError = message.slice(0, 500);
      logError("skill_security.backfill_item_failed", error, { adoptId: skill.adoptId, skillId: skill.id });
    } finally {
      status.processed++;
      saveStatus(status);
    }
  }
  saveStatus({ ...status, status: "completed", currentSkill: undefined, completedAt: new Date().toISOString() });
}

export function startSkillSecurityBackfill(): SkillSecurityBackfillStatus {
  if (!skillSecurityScannerEnabled()) throw new Error("AI-Infra-Guard Skill Scanner 尚未启用");
  if (activeRun) return skillSecurityBackfillStatus();
  const status: SkillSecurityBackfillStatus = {
    ...emptyStatus(),
    runId: `ssbf_${randomUUID()}`,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  saveStatus(status);
  activeRun = executeBackfill(status)
    .catch(error => {
      saveStatus({ ...skillSecurityBackfillStatus(), status: "failed", currentSkill: undefined, completedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) });
      logError("skill_security.backfill_failed", error);
    })
    .finally(() => { activeRun = null; });
  return status;
}

export async function skillSecurityInventory() {
  const listed = await skillRegistry.listAllSkills();
  if (!listed.ok) throw new Error(listed.error.detail);
  const items = listed.value;
  const counts = { total: items.length, completed: 0, pending: 0, failed: 0, unscanned: 0, highRisk: 0 };
  for (const skill of items) {
    const external = skill.scan?.externalSecurity;
    if (!external) counts.unscanned++;
    else counts[external.status]++;
    if ((external?.summary?.critical || 0) + (external?.summary?.high || 0) > 0) counts.highRisk++;
  }
  return { enabled: skillSecurityScannerEnabled(), counts, backfill: skillSecurityBackfillStatus() };
}
