import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ContextNeedPlanV1 } from "../../../shared/context-resolution";

const freshnessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("realtime"), maxAgeSeconds: z.number().int().positive() }),
  z.object({ mode: z.literal("current_effective") }),
  z.object({ mode: z.literal("latest"), maxAgeSeconds: z.number().int().positive().optional() }),
  z.object({ mode: z.literal("version_controlled") }),
]);

const needSchema = z.object({
  needId: z.string().min(1).max(80),
  logicalAssetId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/),
  contextType: z.enum(["knowledge", "business_data", "memory"]),
  requiredness: z.enum(["required", "optional"]),
  purpose: z.string().min(1).max(300),
  freshness: freshnessSchema,
  authority: z.enum(["official", "approved", "reference"]).optional(),
  requiredCapabilities: z.array(z.string().min(1).max(80)).max(16).optional(),
});

const planSchema = z.object({
  schema: z.literal("ea.context-need-plan.v1"),
  planId: z.string().min(1).max(160),
  planVersion: z.string().min(1).max(64),
  rolePackId: z.literal("linggan-bank.wealth-manager"),
  roleTemplate: z.literal("wealth-manager"),
  taskId: z.enum(["WM-GT-01", "WM-GT-02", "WM-GT-03", "WM-GT-05"]),
  needs: z.array(needSchema).min(1).max(16),
});

const manifestSchema = z.object({
  schemaVersion: z.literal("ea.reference-role-pack.context-needs.v1"),
  rolePackId: z.literal("linggan-bank.wealth-manager"),
  roleTemplate: z.literal("wealth-manager"),
  plans: z.array(planSchema).length(4),
});

let cached: Map<string, ContextNeedPlanV1> | null = null;

function manifestPath(): string {
  return path.join(process.cwd(), "examples", "wealth-manager-reference-role-pack", "context-needs.json");
}

export function wealthContextNeedPlans(): ReadonlyMap<string, ContextNeedPlanV1> {
  if (!cached) {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath(), "utf8")));
    cached = new Map(manifest.plans.map((plan) => [plan.taskId, plan as ContextNeedPlanV1]));
  }
  return cached;
}

export function wealthContextNeedPlan(taskId: string): ContextNeedPlanV1 | null {
  return wealthContextNeedPlans().get(taskId) || null;
}

