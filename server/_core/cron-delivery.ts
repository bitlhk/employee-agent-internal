/**
 * Platform-side routing metadata for JiuwenSwarm cron jobs.
 *
 * Execution and delivery are owned by JiuwenSwarm. EA stores the selected
 * channel so callbacks and the management UI can recover the intended route.
 */
import { existsSync, readFileSync } from "fs";
import { writeJsonFileAtomicSync } from "./atomic-json-file";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const CONFIG_PATH = `${APP_ROOT}/data/cron-delivery-config.json`;

interface DeliveryConfig {
  adoptId: string;
  jobId: string;
  jobName: string;
  channel: string;
}

function loadConfigs(): DeliveryConfig[] {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {}
  return [];
}

function saveConfigs(configs: DeliveryConfig[]) {
  writeJsonFileAtomicSync(CONFIG_PATH, configs);
}

function findDeliveryConfig(configs: DeliveryConfig[], adoptId: string, jobId: string) {
  return configs.find((config) => config.adoptId === adoptId && config.jobId === jobId);
}

export async function saveCronDeliveryConfig(
  adoptId: string,
  jobName: string,
  channel: string,
  jobId: string,
) {
  if (!jobId) throw new Error("jobId is required for cron delivery config");
  const configs = loadConfigs();
  const existing = findDeliveryConfig(configs, adoptId, jobId);
  if (existing) {
    existing.channel = channel;
    existing.jobName = jobName;
  } else {
    configs.push({ adoptId, jobId, jobName, channel });
  }
  saveConfigs(configs);
}

export async function deleteCronDeliveryConfig(adoptId: string, jobId: string) {
  if (!adoptId || !jobId) return;
  const configs = loadConfigs();
  const next = configs.filter((config) => !(config.adoptId === adoptId && config.jobId === jobId));
  if (next.length !== configs.length) saveConfigs(next);
}

export function getCronDeliveryChannel(adoptId: string, jobId: string): string | undefined {
  return findDeliveryConfig(loadConfigs(), adoptId, jobId)?.channel;
}
