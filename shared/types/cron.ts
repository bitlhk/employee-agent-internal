import { z } from "zod";

/**
 * Workforce Agent Platform Cron/Channel contract.
 *
 * See docs/product/CRON_TASK_CENTER_PLAN_V3_ADDENDUM.md for product decisions,
 * runtime mapping tables, density rules, and rollout order. This file is the
 * shared compile/runtime schema contract; provider mapping logic lives in
 * server-side provider implementations.
 */

export const CHANNEL_IDS = ["web", "wechat", "feishu", "dingtalk", "wecom"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];
export const channelIdSchema = z.enum(CHANNEL_IDS);

export const RUNTIME_IDS = ["openclaw", "legacy_archived", "jiuwenclaw"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];
export const runtimeIdSchema = z.enum(RUNTIME_IDS);

export const CHANNEL_BIND_MODES = ["scan", "webhook", "admin_config"] as const;
export type ChannelBindMode = (typeof CHANNEL_BIND_MODES)[number];
export const channelBindModeSchema = z.enum(CHANNEL_BIND_MODES);

export const cronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    runAt: z.string().datetime(),
    display: z.string().min(1),
  }),
  z.object({
    kind: z.literal("interval"),
    intervalMinutes: z.number().int().positive(),
    display: z.string().min(1),
  }),
  z.object({
    kind: z.literal("cron"),
    cronExpr: z.string().min(1),
    display: z.string().min(1),
  }),
]);
export type CronSchedule = z.infer<typeof cronScheduleSchema>;

export const cronDeliveryFormatSchema = z.enum(["text", "markdown", "card"]);
export type CronDeliveryFormat = z.infer<typeof cronDeliveryFormatSchema>;

export const cronDeliveryTargetSchema = z.object({
  channelId: channelIdSchema,
  channelLabel: z.string().min(1),
  targetId: z.string().optional(),
  targetLabel: z.string().optional(),
  format: cronDeliveryFormatSchema.optional(),
});
export type CronDeliveryTarget = z.infer<typeof cronDeliveryTargetSchema>;

// MVP is single-target delivery. Keep the array shape so v2 can lift max(1)
// without changing every function signature.
export const cronDeliveryConfigSchema = z.object({
  targets: z.array(cronDeliveryTargetSchema).min(1).max(1),
});
export type CronDeliveryConfig = z.infer<typeof cronDeliveryConfigSchema>;

export const cronStateSchema = z.object({
  status: z.enum(["scheduled", "running", "completed", "paused", "failed"]),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastStatus: z.enum(["ok", "error", "skipped", "timeout", "canceled"]).optional(),
  lastDurationMs: z.number().optional(),
  totalRuns: z.number().int().nonnegative().optional(),
  successRuns: z.number().int().nonnegative().optional(),
});
export type CronState = z.infer<typeof cronStateSchema>;

export const cronJobSchema = z.object({
  id: z.string().min(1),
  runtime: runtimeIdSchema,
  adoptId: z.string().min(1),
  userId: z.number().int(),
  name: z.string().min(1),
  enabled: z.boolean(),
  prompt: z.string().optional(),
  description: z.string().optional(),
  schedule: cronScheduleSchema,
  state: cronStateSchema,
  delivery: cronDeliveryConfigSchema,
  wakeOffsetSeconds: z.number().int().nonnegative().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.number().int(),
  createdAt: z.string().min(1),
  updatedBy: z.number().int().optional(),
  updatedAt: z.string().min(1),
});
export type CronJob = z.infer<typeof cronJobSchema>;

export const cronProviderCapabilitiesSchema = z.object({
  scheduleKinds: z.array(z.enum(["once", "interval", "cron"])),
  promptRequired: z.boolean(),
  supportsTimezone: z.boolean(),
  supportsWakeOffset: z.boolean(),
  supportsPreview: z.boolean(),
  supportsRunNow: z.boolean(),
  supportedChannels: z.array(channelIdSchema),
});
export type CronProviderCapabilities = z.infer<typeof cronProviderCapabilitiesSchema>;

export const previewRunsRequestSchema = z.object({
  adoptId: z.string().min(1),
  schedule: cronScheduleSchema,
  timezone: z.string().optional(),
  count: z.number().int().positive().max(20).default(5),
  wakeOffsetSeconds: z.number().int().nonnegative().optional(),
});
export type PreviewRunsRequest = z.input<typeof previewRunsRequestSchema>;

export const previewRunSchema = z.object({
  runAt: z.string().min(1),
  wakeAt: z.string().optional(),
});
export type PreviewRun = z.infer<typeof previewRunSchema>;

export const previewRunsResponseSchema = z.object({
  runs: z.array(previewRunSchema),
});
export type PreviewRunsResponse = z.infer<typeof previewRunsResponseSchema>;

export type ChannelError =
  | { kind: "not_implemented"; detail: string }
  | { kind: "auth_failed"; detail: string }
  | { kind: "rate_limited"; retryAfterMs: number; detail?: string }
  | { kind: "channel_unreachable"; detail: string }
  | { kind: "payload_rejected"; detail: string };

export type Result<T, E = ChannelError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type ChannelPayload = {
  title?: string;
  text: string;
  format?: CronDeliveryFormat;
  metadata?: Record<string, unknown>;
};

export type ChannelSendContext = {
  userId: number;
  adoptId?: string;
  channelId: ChannelId;
  targetId?: string;
  credentials?: unknown;
};

export type ChannelBindHandle = {
  channelId: ChannelId;
  userId: number;
  targetId?: string;
  targetLabel?: string;
  boundAt: string;
  // Some scan-based personal channels (notably ilink WeChat) can lose the
  // ability to proactively deliver after the user stops interacting. Providers
  // should surface that state explicitly so UI can ask the user to reactivate.
  needsReactivation?: boolean;
  lastReactivatedAt?: string;
  // Channel-specific binding context. Feishu/Lark uses this to remember the
  // tenant domain and dynamic app-registration credentials without polluting the
  // base contract with provider-specific fields.
  domain?: string;
  metadata?: Record<string, unknown>;
};

export type ChannelBindStart = {
  qrCode: string;
  pollToken: string;
  expiresAt: string;
  // OAuth/device-flow channels (Feishu/Lark) can also expose a browser fallback
  // for desktop users who cannot scan the QR code.
  verificationUri?: string;
  userCode?: string;
  pollIntervalMs?: number;
};

export type ChannelBindStatus =
  | { status: "pending" }
  | { status: "scanned" }
  | { status: "confirmed"; bindHandle: ChannelBindHandle }
  | { status: "expired" };

type BaseChannelProvider = {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly credentialsSchema: z.ZodTypeAny;
  unbind(ctx: ChannelSendContext): Promise<Result<void>>;
  test(ctx: ChannelSendContext): Promise<Result<{ message: string }>>;
  send(ctx: ChannelSendContext, payload: ChannelPayload): Promise<Result<{ deliveredAt: string }>>;
};

export type ScanChannelProvider = BaseChannelProvider & {
  readonly bindMode: "scan";
  startBindFlow(ctx: ChannelSendContext): Promise<Result<ChannelBindStart>>;
  pollBindStatus(ctx: ChannelSendContext, pollToken: string): Promise<Result<ChannelBindStatus>>;
};

export type SyncBindChannelProvider = BaseChannelProvider & {
  readonly bindMode: "webhook" | "admin_config";
  bind(ctx: ChannelSendContext, credentials: unknown): Promise<Result<ChannelBindHandle>>;
};

export type ChannelProvider = ScanChannelProvider | SyncBindChannelProvider;

export type CronProviderError =
  | { kind: "not_found"; detail: string }
  | { kind: "validation_failed"; detail: string }
  | { kind: "runtime_unavailable"; detail: string }
  | { kind: "not_implemented"; detail: string };

export type CronResult<T> = Result<T, CronProviderError>;

export type CronProviderHandle = {
  adoptId: string;
  agentId: string;
  userId: number;
  // Optional during transition. Provider calls may fall back to provider.runtime
  // when older call sites have not populated the handle yet.
  runtime?: RuntimeId;
};

/**
 * Input runtime is inferred from CronProviderHandle/provider selection, not from
 * this object. If provider.capabilities().promptRequired is true, provider.addJob
 * must return validation_failed when prompt is empty.
 */
export type CronJobInput = {
  name: string;
  prompt?: string;
  description?: string;
  enabled?: boolean;
  schedule: CronSchedule;
  delivery: CronDeliveryConfig;
  wakeOffsetSeconds?: number;
  meta?: Record<string, unknown>;
};

export const cronRunRecordSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  status: z.enum(["running", "ok", "error", "skipped", "timeout", "canceled"]),
  errorMessage: z.string().optional(),
  output: z.string().optional(),
  deliveryStatus: z.enum(["pending", "ok", "failed", "skipped"]).optional(),
  deliveryTargetMasked: z.string().optional(),
  triggeredBy: z.enum(["schedule", "manual", "api"]),
  triggeredByUser: z.number().int().optional(),
});
export type CronRunRecord = z.infer<typeof cronRunRecordSchema>;

export interface CronProvider {
  readonly runtime: RuntimeId;
  capabilities(): CronProviderCapabilities;
  listJobs(handle: CronProviderHandle): Promise<CronResult<CronJob[]>>;
  addJob(handle: CronProviderHandle, input: CronJobInput): Promise<CronResult<CronJob>>;
  updateJob(handle: CronProviderHandle, id: string, patch: Partial<CronJobInput>): Promise<CronResult<CronJob>>;
  removeJob(handle: CronProviderHandle, id: string): Promise<CronResult<void>>;
  runJobNow(handle: CronProviderHandle, id: string): Promise<CronResult<{ runId: string }>>;
  listRuns(handle: CronProviderHandle, id: string, limit: number): Promise<CronResult<CronRunRecord[]>>;
  previewRuns(request: PreviewRunsRequest): Promise<CronResult<PreviewRunsResponse>>;
}

export const wechatCredentialsSchema = z.object({});
export const feishuCredentialsSchema = z.object({
  // Feishu MVP product path is QR/device-flow binding. User-entered webhook
  // credentials are intentionally not the primary contract because they are too
  // hard for normal users to configure correctly.
});
export const dingtalkCredentialsSchema = z.object({});
export const wecomCredentialsSchema = z.object({
  corpId: z.string().min(1),
  agentId: z.string().min(1),
  secret: z.string().min(1),
  userId: z.string().min(1).optional(),
});
