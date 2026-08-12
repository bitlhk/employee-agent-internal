import type { ModelCapabilityRequirements } from "../../shared/model-capabilities";
import { modelMeetsCapabilities } from "../../shared/model-capabilities";
import {
  beginModelRequest,
  observeAutomaticModelCircuit,
  observeAutomaticModelSelection,
  type ChatOutcome,
  type ModelSelectionMode,
} from "./observability/metrics";
import type { SelectableJiuwenModel } from "./jiuwenswarm-model-admin";

type PoolEntry = {
  identity: string;
  weight: number;
  maxInflight: number;
};

type ModelState = {
  active: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
};

type StickySelection = {
  modelId: string;
  expiresAt: number;
};

export type ModelRequestLease = {
  model: SelectableJiuwenModel;
  selectionMode: ModelSelectionMode;
  routeReason: "manual" | "sticky" | "least_loaded" | "fallback";
  observeFirstToken: () => void;
  observeUsage: (usage: Record<string, number>) => void;
  complete: (outcome: ChatOutcome) => void;
};

const DEFAULT_POOL: PoolEntry[] = [
  { identity: "deepseek-v4-flash", weight: 35, maxInflight: 24 },
  { identity: "hy3", weight: 25, maxInflight: 18 },
  { identity: "doubao-seed-2.1-pro", weight: 20, maxInflight: 14 },
  { identity: "glm-5.2", weight: 15, maxInflight: 12 },
  { identity: "openpangu-2.0-flash", weight: 5, maxInflight: 8 },
];

const stateByModel = new Map<string, ModelState>();
const stickySelections = new Map<string, StickySelection>();

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

function enabled(value: string | undefined, fallback = true): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function automaticModelRoutingEnabled(): boolean {
  return enabled(process.env.JIUWEN_AUTO_ROUTING_ENABLED, false);
}

function parsePool(): PoolEntry[] {
  const raw = String(process.env.JIUWEN_AUTO_MODEL_POOL || "").trim();
  if (!raw) return DEFAULT_POOL;
  const entries = raw
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const [identity = "", rawWeight = "", rawLimit = ""] = value
        .split(":")
        .map(part => part.trim());
      if (!identity) return null;
      return {
        identity,
        weight: boundedInteger(rawWeight, 10, 1, 1000),
        maxInflight: boundedInteger(rawLimit, 12, 1, 500),
      };
    })
    .filter(Boolean) as PoolEntry[];
  return entries.length > 0 ? entries : DEFAULT_POOL;
}

function modelMatches(model: SelectableJiuwenModel, identity: string): boolean {
  const normalized = identity.trim().toLowerCase();
  return [
    model.id,
    model.name,
    model.modelName,
    model.alias,
    model.runtimeModelId,
  ].some(
    value =>
      String(value || "")
        .trim()
        .toLowerCase() === normalized
  );
}

function modelState(modelId: string): ModelState {
  const existing = stateByModel.get(modelId);
  if (existing) return existing;
  const created = { active: 0, consecutiveFailures: 0, circuitOpenUntil: 0 };
  stateByModel.set(modelId, created);
  return created;
}

function circuitOpen(modelId: string, now: number): boolean {
  const state = modelState(modelId);
  if (state.circuitOpenUntil <= now) {
    if (state.circuitOpenUntil > 0) {
      state.circuitOpenUntil = 0;
      observeAutomaticModelCircuit(modelId, false);
    }
    return false;
  }
  return true;
}

function pruneSticky(now: number): void {
  if (stickySelections.size < 5000) return;
  for (const [key, selection] of stickySelections) {
    if (selection.expiresAt <= now) stickySelections.delete(key);
  }
}

function fallbackModel(
  models: SelectableJiuwenModel[],
  requirements: ModelCapabilityRequirements
): SelectableJiuwenModel | null {
  const compatible = models.filter(model =>
    modelMeetsCapabilities(model.capabilities, requirements)
  );
  const target = String(process.env.JIUWEN_AUTO_TARGET_MODEL || "").trim();
  return (
    (target ? compatible.find(model => modelMatches(model, target)) : null) ||
    compatible.find(model => model.isDefault) ||
    compatible[0] ||
    null
  );
}

function createLease(args: {
  model: SelectableJiuwenModel;
  selectionMode: ModelSelectionMode;
  routeReason: ModelRequestLease["routeReason"];
  automatic: boolean;
}): ModelRequestLease {
  const state = modelState(args.model.id);
  state.active += 1;
  const metric = beginModelRequest(args.model.id, args.selectionMode);
  let completed = false;
  return {
    model: args.model,
    selectionMode: args.selectionMode,
    routeReason: args.routeReason,
    observeFirstToken: metric.observeFirstToken,
    observeUsage: metric.observeUsage,
    complete(outcome) {
      if (completed) return;
      completed = true;
      state.active = Math.max(0, state.active - 1);
      metric.finish(outcome);
      if (!args.automatic || outcome === "cancelled") return;
      if (outcome === "success") {
        state.consecutiveFailures = 0;
        if (state.circuitOpenUntil > 0) {
          state.circuitOpenUntil = 0;
          observeAutomaticModelCircuit(args.model.id, false);
        }
        return;
      }
      state.consecutiveFailures += 1;
      const threshold = boundedInteger(
        process.env.JIUWEN_AUTO_MODEL_FAILURE_THRESHOLD,
        3,
        1,
        20
      );
      if (state.consecutiveFailures < threshold) return;
      const baseCircuitMs = boundedInteger(
        process.env.JIUWEN_AUTO_MODEL_CIRCUIT_MS,
        30_000,
        5_000,
        10 * 60_000
      );
      const multiplier = Math.min(
        4,
        Math.max(1, state.consecutiveFailures - threshold + 1)
      );
      state.circuitOpenUntil = Date.now() + baseCircuitMs * multiplier;
      observeAutomaticModelCircuit(args.model.id, true);
    },
  };
}

export function beginManualModelRequest(
  model: SelectableJiuwenModel
): ModelRequestLease {
  return createLease({
    model,
    selectionMode: "manual",
    routeReason: "manual",
    automatic: false,
  });
}

export function acquireAutomaticModel(args: {
  models: SelectableJiuwenModel[];
  requirements?: ModelCapabilityRequirements;
  stickyKey?: string;
  now?: number;
}): ModelRequestLease | null {
  const requirements = args.requirements || {};
  if (!automaticModelRoutingEnabled()) {
    const model = fallbackModel(args.models, requirements);
    if (!model) return null;
    observeAutomaticModelSelection(model.id, "fallback");
    return createLease({
      model,
      selectionMode: "automatic",
      routeReason: "fallback",
      automatic: true,
    });
  }

  const now = args.now ?? Date.now();
  const configured = parsePool()
    .map(entry => {
      const model = args.models.find(candidate =>
        modelMatches(candidate, entry.identity)
      );
      return model ? { model, entry } : null;
    })
    .filter(Boolean) as Array<{
    model: SelectableJiuwenModel;
    entry: PoolEntry;
  }>;
  const candidates = configured.filter(
    ({ model }) =>
      modelMeetsCapabilities(model.capabilities, requirements) &&
      !circuitOpen(model.id, now)
  );

  const stickyKey = String(args.stickyKey || "")
    .trim()
    .slice(0, 256);
  if (stickyKey) {
    const sticky = stickySelections.get(stickyKey);
    const candidate =
      sticky && sticky.expiresAt > now
        ? candidates.find(({ model }) => model.id === sticky.modelId)
        : null;
    if (
      candidate &&
      modelState(candidate.model.id).active < candidate.entry.maxInflight
    ) {
      observeAutomaticModelSelection(candidate.model.id, "sticky");
      return createLease({
        model: candidate.model,
        selectionMode: "automatic",
        routeReason: "sticky",
        automatic: true,
      });
    }
    if (sticky) stickySelections.delete(stickyKey);
  }

  const available = candidates.filter(
    ({ model, entry }) => modelState(model.id).active < entry.maxInflight
  );
  const selected = available.sort((left, right) => {
    const leftScore =
      (modelState(left.model.id).active + 1) / left.entry.weight;
    const rightScore =
      (modelState(right.model.id).active + 1) / right.entry.weight;
    return (
      leftScore - rightScore ||
      right.entry.weight - left.entry.weight ||
      left.model.id.localeCompare(right.model.id)
    );
  })[0];

  if (selected) {
    if (stickyKey) {
      const stickyMs = boundedInteger(
        process.env.JIUWEN_AUTO_MODEL_STICKY_MS,
        15 * 60_000,
        0,
        24 * 60 * 60_000
      );
      if (stickyMs > 0)
        stickySelections.set(stickyKey, {
          modelId: selected.model.id,
          expiresAt: now + stickyMs,
        });
      pruneSticky(now);
    }
    observeAutomaticModelSelection(selected.model.id, "least_loaded");
    return createLease({
      model: selected.model,
      selectionMode: "automatic",
      routeReason: "least_loaded",
      automatic: true,
    });
  }

  // A configured pool is a hard capacity boundary. The outer HTTP queue can
  // absorb bursts; exceeding a model lane here would defeat load shedding.
  if (configured.length > 0) return null;
  const fallback = fallbackModel(
    args.models.filter(model => !circuitOpen(model.id, now)),
    requirements
  );
  if (!fallback) return null;
  observeAutomaticModelSelection(fallback.id, "fallback");
  return createLease({
    model: fallback,
    selectionMode: "automatic",
    routeReason: "fallback",
    automatic: true,
  });
}

export function resetAutomaticModelRouterForTests(): void {
  stateByModel.clear();
  stickySelections.clear();
}
