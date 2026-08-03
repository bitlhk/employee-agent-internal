import { evaluateReadiness } from "./readiness";
import { setPublicHealthComponentStatus, type ChatOutcome } from "./metrics";
import { getServerLifecycleSnapshot } from "../operational-lifecycle";
import {
  listJiuwenModelsWithSecrets,
  validateJiuwenModel,
  type JiuwenModelSecret,
} from "../jiuwenswarm-model-admin";
import { logError, logInfo } from "./logger";

export const PUBLIC_HEALTH_PROFILE = "jiuwenswarm-agent" as const;

export type PublicHealthStatus =
  | "operational"
  | "degraded"
  | "outage"
  | "unknown";
export type PublicHealthComponentKey = "application" | "runtime" | "model";

export type PublicHealthComponent = {
  key: PublicHealthComponentKey;
  status: PublicHealthStatus;
  checkedAt: string;
};

export type PublicHealthSnapshot = {
  schemaVersion: "1.0";
  profile: typeof PUBLIC_HEALTH_PROFILE;
  status: PublicHealthStatus;
  checkedAt: string;
  components: PublicHealthComponent[];
};

type ComponentState = {
  status: PublicHealthStatus;
  failures: number;
  checkedAt: number;
};

const componentKeys: PublicHealthComponentKey[] = [
  "application",
  "runtime",
  "model",
];
const componentState = new Map<PublicHealthComponentKey, ComponentState>(
  componentKeys.map(key => [
    key,
    { status: "unknown", failures: 0, checkedAt: 0 },
  ])
);
let lastModelSuccessAt = 0;
let refreshPromise: Promise<void> | null = null;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Math.min(
    max,
    Math.max(min, Number.isFinite(parsed) ? parsed : fallback)
  );
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function publicHealthEnabled(): boolean {
  return enabled(process.env.EA_PUBLIC_HEALTH_ENABLED, true);
}

export function transitionPublicHealthComponent(
  previous: ComponentState,
  ok: boolean,
  checkedAt = Date.now()
): ComponentState {
  if (ok) return { status: "operational", failures: 0, checkedAt };
  const failures = previous.failures + 1;
  return {
    status: failures >= 2 ? "outage" : "degraded",
    failures,
    checkedAt,
  };
}

export function derivePublicHealthStatus(
  states: Pick<PublicHealthComponent, "key" | "status">[]
): PublicHealthStatus {
  if (states.some(item => item.status === "outage")) return "outage";
  if (states.some(item => item.status === "degraded")) return "degraded";
  if (states.some(item => item.status === "unknown")) return "unknown";
  return "operational";
}

function setComponent(
  key: PublicHealthComponentKey,
  ok: boolean,
  checkedAt = Date.now()
): void {
  const previous = componentState.get(key) || {
    status: "unknown",
    failures: 0,
    checkedAt: 0,
  };
  const next = transitionPublicHealthComponent(previous, ok, checkedAt);
  componentState.set(key, next);
  setPublicHealthComponentStatus(key, next.status);
}

function setUnknownComponent(
  key: PublicHealthComponentKey,
  checkedAt = Date.now()
): void {
  const next = { status: "unknown" as const, failures: 0, checkedAt };
  componentState.set(key, next);
  setPublicHealthComponentStatus(key, next.status);
}

export function observePublicModelTraffic(
  outcome: ChatOutcome,
  observedAt = Date.now()
): void {
  if (outcome !== "success") return;
  lastModelSuccessAt = observedAt;
  setComponent("model", true, observedAt);
}

function publicComponents(): PublicHealthComponent[] {
  return componentKeys.map(key => {
    const state = componentState.get(key) || {
      status: "unknown" as const,
      checkedAt: 0,
    };
    return {
      key,
      status: state.status,
      checkedAt: new Date(state.checkedAt || Date.now()).toISOString(),
    };
  });
}

export function getPublicHealthSnapshot(
  now = Date.now()
): PublicHealthSnapshot {
  const components = publicComponents();
  return {
    schemaVersion: "1.0",
    profile: PUBLIC_HEALTH_PROFILE,
    status: derivePublicHealthStatus(components),
    checkedAt: new Date(now).toISOString(),
    components,
  };
}

async function probeApplication(): Promise<void> {
  const lifecycle = getServerLifecycleSnapshot();
  const readiness = await evaluateReadiness();
  const requiredChecks = readiness.checks.filter(
    check => check.required && check.name !== "jiuwenswarm"
  );
  setComponent(
    "application",
    lifecycle.state === "ready" && requiredChecks.every(check => check.ok)
  );
}

async function probeRuntime(): Promise<JiuwenModelSecret[]> {
  try {
    const models = await listJiuwenModelsWithSecrets();
    setComponent("runtime", true);
    if (models.length === 0) setComponent("model", false);
    return models;
  } catch (error) {
    setComponent("runtime", false);
    throw error;
  }
}

async function probeModelIfNeeded(models: JiuwenModelSecret[]): Promise<void> {
  if (models.length === 0) return;
  const now = Date.now();
  const successFreshMs = boundedInteger(
    process.env.EA_MODEL_HEALTH_SUCCESS_TTL_MS,
    30 * 60_000,
    60_000,
    24 * 60 * 60_000
  );
  if (lastModelSuccessAt > 0 && now - lastModelSuccessAt <= successFreshMs)
    return;
  if (!enabled(process.env.EA_MODEL_HEALTH_PROBE_ENABLED, false)) {
    setUnknownComponent("model", now);
    return;
  }
  try {
    await validateJiuwenModel(models[0]);
    lastModelSuccessAt = now;
    setComponent("model", true, now);
  } catch (error) {
    setComponent("model", false, now);
    logError("public_health.model_probe_failed", error);
  }
}

export async function refreshPublicHealthSnapshot(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const [applicationResult, runtimeResult] = await Promise.allSettled([
      probeApplication(),
      probeRuntime(),
    ]);
    if (applicationResult.status === "rejected") {
      setComponent("application", false);
      logError(
        "public_health.application_probe_failed",
        applicationResult.reason
      );
    }
    if (runtimeResult.status === "fulfilled") {
      await probeModelIfNeeded(runtimeResult.value);
    } else {
      logError("public_health.runtime_probe_failed", runtimeResult.reason);
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function startPublicHealthMonitor(): () => void {
  if (!publicHealthEnabled()) return () => {};
  const intervalMs = boundedInteger(
    process.env.EA_PUBLIC_HEALTH_INTERVAL_MS,
    30_000,
    10_000,
    10 * 60_000
  );
  void refreshPublicHealthSnapshot();
  const timer = setInterval(
    () => void refreshPublicHealthSnapshot(),
    intervalMs
  );
  timer.unref();
  logInfo("public_health.monitor_started", {
    intervalMs,
    modelProbeEnabled: enabled(
      process.env.EA_MODEL_HEALTH_PROBE_ENABLED,
      false
    ),
  });
  return () => clearInterval(timer);
}

export function resetPublicHealthForTests(): void {
  lastModelSuccessAt = 0;
  refreshPromise = null;
  for (const key of componentKeys) {
    componentState.set(key, { status: "unknown", failures: 0, checkedAt: 0 });
    setPublicHealthComponentStatus(key, "unknown");
  }
}
