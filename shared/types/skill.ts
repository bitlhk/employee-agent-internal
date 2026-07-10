import { z } from "zod";

/**
 * Workforce Agent Platform skill storage contract.
 *
 * This file contains the shared compile/runtime schema. Runtime sync and
 * tenant policy live in the server-side registry implementation.
 */

export const SKILL_SOURCE_KINDS = ["builtin", "role_default", "marketplace", "uploaded", "generated", "runtime_imported"] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];
export const skillSourceKindSchema = z.enum(SKILL_SOURCE_KINDS);

export const SKILL_RUNTIME_STATES = [
  "ready",
  "disabled",
  "syncing",
  "sync_failed",
  "source_missing",
  "review_pending",
  "reviewing",
  "review_failed",
] as const;
export type SkillRuntimeState = (typeof SKILL_RUNTIME_STATES)[number];
export const skillRuntimeStateSchema = z.enum(SKILL_RUNTIME_STATES);

export const SKILL_REVIEW_STATES = ["none", "pending", "reviewing", "passed", "failed"] as const;
export type SkillReviewState = (typeof SKILL_REVIEW_STATES)[number];
export const skillReviewStateSchema = z.enum(SKILL_REVIEW_STATES);

export const skillSourceSchema = z.object({
  kind: skillSourceKindSchema,
  skillId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  sourcePath: z.string().min(1).optional(),
  catalogId: z.string().optional(),
  marketplaceId: z.string().optional(),
  version: z.string().optional(),
});
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillSyncInfoSchema = z.object({
  runtimePath: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  sourceMtimeMs: z.number().optional(),
  sourceSizeBytes: z.number().optional(),
  runtimeMtimeMs: z.number().optional(),
  runtimeSizeBytes: z.number().optional(),
  reason: z.string().optional(),
});
export type SkillSyncInfo = z.infer<typeof skillSyncInfoSchema>;

export const skillScanInfoSchema = z.object({
  warnings: z.array(z.string()),
  scannedAt: z.string().min(1),
});
export type SkillScanInfo = z.infer<typeof skillScanInfoSchema>;

export const skillSchema = z.object({
  id: z.string().min(1),
  adoptId: z.string().min(1),
  source: skillSourceSchema,
  state: skillRuntimeStateSchema,
  enabled: z.boolean(),
  review: z.object({
    state: skillReviewStateSchema,
    reason: z.string().optional(),
    checkedAt: z.string().optional(),
  }),
  sync: skillSyncInfoSchema,
  scan: skillScanInfoSchema.optional(),
  capabilities: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Skill = z.infer<typeof skillSchema>;

export const reconcileActionSchema = z.enum([
  "none",
  "copied_to_runtime",
  "refreshed_runtime",
  "deleted_runtime_copy",
  "removed_registry_entry",
  "reported_error",
]);
export type ReconcileAction = z.infer<typeof reconcileActionSchema>;

export const reconcileItemSchema = z.object({
  skillId: z.string().min(1),
  sourceKind: skillSourceKindSchema.optional(),
  before: skillRuntimeStateSchema.optional(),
  after: skillRuntimeStateSchema.optional(),
  action: reconcileActionSchema,
  reason: z.string().optional(),
});
export type ReconcileItem = z.infer<typeof reconcileItemSchema>;

export const reconcileReportSchema = z.object({
  adoptId: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  scanned: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(reconcileItemSchema),
});
export type ReconcileReport = z.infer<typeof reconcileReportSchema>;

export type SkillRegistryError =
  | { kind: "not_found"; detail: string }
  | { kind: "validation_failed"; detail: string }
  | { kind: "source_missing"; detail: string }
  | { kind: "sync_failed"; detail: string }
  | { kind: "permission_denied"; detail: string }
  | { kind: "not_implemented"; detail: string };

export type SkillRegistryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SkillRegistryError };

export type SkillRegistryReconcileOptions = {
  skillId?: string;
};

export interface SkillRegistry {
  listSkills(adoptId: string): Promise<SkillRegistryResult<Skill[]>>;
  reconcile(adoptId: string, options?: SkillRegistryReconcileOptions): Promise<SkillRegistryResult<ReconcileReport>>;
  install(adoptId: string, source: SkillSource): Promise<SkillRegistryResult<Skill>>;
  updateScan(adoptId: string, skillId: string, scan: SkillScanInfo): Promise<SkillRegistryResult<Skill>>;
  uninstall(adoptId: string, skillId: string): Promise<SkillRegistryResult<void>>;
  destroy(adoptId: string, skillId: string): Promise<SkillRegistryResult<void>>;
  setEnabled(adoptId: string, skillId: string, enabled: boolean): Promise<SkillRegistryResult<Skill>>;
  rename(adoptId: string, skillId: string, displayName: string): Promise<SkillRegistryResult<Skill>>;
}
