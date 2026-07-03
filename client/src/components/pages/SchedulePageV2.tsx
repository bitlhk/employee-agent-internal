import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock3,
  Check,
  Copy,
  Eye,
  MessageCircle,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { PageContainer } from "@/components/console/PageContainer";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type ChannelId = "web" | "wechat" | "feishu" | "wecom";

type CronJobV2 = {
  id: string;
  runtime?: "openclaw" | "legacy_archived" | "jiuwenclaw";
  name: string;
  description?: string;
  enabled: boolean;
  prompt?: string;
  schedule: {
    kind: "interval" | "once" | "cron";
    intervalMinutes?: number;
    runAt?: string;
    cronExpr?: string;
    display?: string;
  };
  state?: {
    status?: "scheduled" | "running" | "completed" | "paused" | "failed";
    nextRunAt?: string;
    lastRunAt?: string;
    lastStatus?: "ok" | "error" | "skipped" | "timeout" | "canceled";
    lastDurationMs?: number;
  };
  delivery?: {
    targets?: Array<{
      channelId: ChannelId;
      channelLabel?: string;
      targetLabel?: string;
    }>;
  };
  meta?: Record<string, any>;
};

type CronRunV2 = {
  id?: string;
  jobId: string;
  jobName?: string;
  startedAt?: string;
  status: "running" | "ok" | "error" | "skipped" | "timeout" | "canceled";
  output?: string;
  summary?: string;
  errorMessage?: string;
  error?: string;
  durationMs?: number;
};

type PreviewRun = { runAt: string; wakeAt?: string };
type CronCapabilities = {
  scheduleKinds?: Array<"interval" | "once" | "cron">;
  supportsRunNow?: boolean;
  supportedChannels?: ChannelId[];
};

type CreateScheduleKind = "daily" | "interval" | "once" | "cron";

type CreateForm = {
  name: string;
  prompt: string;
  scheduleKind: CreateScheduleKind;
  dailyTime: string;
  intervalMinutes: string;
  runAt: string;
  cronExpr: string;
  channelId: Exclude<ChannelId, "wecom">;
};

const T = {
  pageTitle: "定时任务",
  kicker: "\u4efb\u52a1\u4e2d\u5fc3",
  subtitle: "\u6309\u4efb\u52a1\u884c\u67e5\u770b\u9891\u7387\u3001\u6295\u9012\u6e20\u9053\u3001\u4e0b\u6b21\u6267\u884c\u548c\u6700\u8fd1\u72b6\u6001\u3002",
  refresh: "\u5237\u65b0",
  refreshing: "\u5237\u65b0\u4e2d",
  createTask: "\u65b0\u5efa\u4efb\u52a1",
  collapseCreate: "\u6536\u8d77\u65b0\u5efa",
  missingAdoptId: "缺少 adoptId，无法加载定时任务。",
  retry: "\u91cd\u8bd5",
  task: "\u4efb\u52a1",
  schedule: "\u8ba1\u5212",
  delivery: "\u63a8\u9001\u5230",
  nextRun: "\u4e0b\u6b21\u6267\u884c",
  status: "\u6700\u8fd1\u72b6\u6001",
  actions: "\u64cd\u4f5c",
  emptyTitle: "暂无定时任务",
  emptyHint: "可以在主对话或微信里说出自动执行需求，也可以在这里手动创建。",
  taskName: "\u4efb\u52a1\u540d\u79f0",
  taskNamePlaceholder: "\u6bcf\u65e5\u5929\u6c14\u63d0\u9192",
  promptLabel: "\u8981\u505a\u7684\u4e8b",
  promptPlaceholder: "\u67e5\u4eca\u5929\u5929\u6c14\uff0c\u7b80\u8981\u603b\u7ed3\u540e\u53d1\u7ed9\u6211",
  scheduleKind: "\u6267\u884c\u65b9\u5f0f",
  daily: "\u6bcf\u5929\u5b9a\u65f6",
  interval: "\u95f4\u9694\u6267\u884c",
  cronExpr: "Cron",
  deliveryChannel: "\u6295\u9012\u9891\u9053",
  saveTask: "\u521b\u5efa\u4efb\u52a1",
  saving: "\u521b\u5efa\u4e2d",
  createSuccess: "定时任务已创建",
  createFailed: "\u521b\u5efa\u5931\u8d25",
  requiredHint: "\u8bf7\u586b\u5199\u4efb\u52a1\u540d\u79f0\u548c\u8981\u505a\u7684\u4e8b",
  every: "\u6bcf",
  minute: "\u5206\u949f",
  once: "\u4e00\u6b21\u6027",
  ok: "\u6210\u529f",
  error: "\u5931\u8d25",
  timeout: "\u8d85\u65f6",
  canceled: "\u5df2\u53d6\u6d88",
  skipped: "\u5df2\u8df3\u8fc7",
  neverRun: "\u672a\u8fd0\u884c",
  loadFailed: "\u52a0\u8f7d\u5931\u8d25",
  jobLoadFailed: "\u4efb\u52a1\u52a0\u8f7d\u5931\u8d25",
  runsLoadFailed: "\u8fd0\u884c\u8bb0\u5f55\u52a0\u8f7d\u5931\u8d25",
  run: "\u8fd0\u884c",
  runNow: "\u7acb\u5373\u8fd0\u884c",
  runNowFailed: "\u7acb\u5373\u8fd0\u884c\u5931\u8d25",
  started: "\u5df2\u53d1\u8d77\uff0c\u7ed3\u679c\u5c06\u63a8\u9001\u5230",
  runningHint: "正在执行，完成后将在这里显示结果。",
  noRunOutput: "暂无执行结果。",
  preview: "\u9884\u89c8",
  previewFuture: "\u9884\u89c8\u672a\u6765\u6267\u884c",
  previewFailed: "\u9884\u89c8\u5931\u8d25",
  futureRuns: "\u672a\u6765 5 \u6b21\u6267\u884c",
  computing: "\u8ba1\u7b97\u4e2d...",
  noPreview: "\u6ca1\u6709\u53ef\u9884\u89c8\u7684\u672a\u6765\u6267\u884c\u65f6\u95f4\u3002",
  wake: "\u9884\u70ed",
  enable: "\u542f\u7528",
  disable: "\u505c\u7528",
  enableFailed: "\u542f\u505c\u5931\u8d25",
  enabled: "\u4efb\u52a1\u5df2\u542f\u7528",
  disabled: "\u4efb\u52a1\u5df2\u505c\u7528",
  delete: "\u5220\u9664",
  deleteFailed: "\u5220\u9664\u5931\u8d25",
  deleted: "\u4efb\u52a1\u5df2\u5220\u9664",
  deleteConfirmPrefix: "\u5220\u9664\u300c",
  deleteConfirmSuffix: "\u300d\uff1f\u5220\u9664\u540e\u4efb\u52a1\u548c\u6295\u9012\u914d\u7f6e\u90fd\u4f1a\u6e05\u7406\u3002",
};

const CHANNEL_LABEL: Record<ChannelId, string> = {
  web: "定时任务记录",
  wechat: "\u5fae\u4fe1",
  feishu: "\u98de\u4e66",
  wecom: "\u4f01\u4e1a\u5fae\u4fe1",
};

const EMPTY_CREATE_FORM: CreateForm = {
  name: "",
  prompt: "",
  scheduleKind: "daily",
  dailyTime: "09:00",
  intervalMinutes: "60",
  runAt: "",
  cronExpr: "0 9 * * *",
  channelId: "wechat",
};

function normalizeChannelId(channelId?: string): ChannelId {
  if (channelId === "web" || channelId === "conversation") return "web";
  if (channelId === "feishu" || channelId === "wecom") return channelId;
  return "wechat";
}

function channelLabel(channelId?: string) {
  return CHANNEL_LABEL[normalizeChannelId(channelId)];
}

function channelIcon(channelId?: string) {
  const props = { size: 15, strokeWidth: 2 };
  const id = normalizeChannelId(channelId);
  if (id === "web") return <CalendarClock {...props} />;
  if (id === "feishu") return <Zap {...props} />;
  if (id === "wecom") return <Bell {...props} />;
  return <MessageCircle {...props} />;
}

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scheduleText(job: CronJobV2) {
  if (job.schedule.kind === "interval") return `${T.every} ${job.schedule.intervalMinutes || "?"} ${T.minute}`;
  if (job.schedule.kind === "once") return `${T.once} ${formatDate(job.schedule.runAt)}`;
  return job.schedule.display || job.schedule.cronExpr || "cron";
}

function runOutputText(run?: CronRunV2, fallback = T.noRunOutput) {
  const text = String(run?.output || run?.summary || run?.errorMessage || run?.error || "").trim();
  return text || fallback;
}

function runDurationText(run?: CronRunV2) {
  const ms = Number(run?.durationMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function cronExprFromDailyTime(value: string) {
  const [hourRaw, minuteRaw] = String(value || "09:00").split(":");
  const hour = Math.max(0, Math.min(23, Number(hourRaw || 9)));
  const minute = Math.max(0, Math.min(59, Number(minuteRaw || 0)));
  return `${minute} ${hour} * * *`;
}

function buildCreateJob(form: CreateForm) {
  const name = form.name.trim();
  const prompt = form.prompt.trim();
  const channelLabelValue = CHANNEL_LABEL[form.channelId];
  let schedule: CronJobV2["schedule"];
  if (form.scheduleKind === "daily") {
    schedule = {
      kind: "cron",
      cronExpr: cronExprFromDailyTime(form.dailyTime),
      display: `${T.every}\u5929 ${form.dailyTime || "09:00"}`,
    };
  } else if (form.scheduleKind === "interval") {
    const intervalMinutes = Math.max(30, Number(form.intervalMinutes || 60));
    schedule = { kind: "interval", intervalMinutes, display: `${T.every} ${intervalMinutes} ${T.minute}` };
  } else if (form.scheduleKind === "once") {
    const runAt = form.runAt ? new Date(form.runAt).toISOString() : "";
    schedule = { kind: "once", runAt, display: runAt };
  } else {
    schedule = { kind: "cron", cronExpr: form.cronExpr.trim() || "0 9 * * *", display: form.cronExpr.trim() || "0 9 * * *" };
  }
  return {
    name,
    prompt,
    enabled: true,
    schedule,
    delivery: {
      targets: [{
        channelId: form.channelId,
        channelLabel: channelLabelValue,
        targetLabel: channelLabelValue,
        format: "text",
      }],
    },
  };
}

function statusMeta(status?: string) {
  if (status === "ok") return { label: T.ok, tone: "ok" };
  if (status === "error") return { label: T.error, tone: "danger" };
  if (status === "timeout") return { label: T.timeout, tone: "warn" };
  if (status === "canceled") return { label: T.canceled, tone: "muted" };
  if (status === "skipped") return { label: T.skipped, tone: "muted" };
  return { label: T.neverRun, tone: "muted" };
}

function StatusPill({ status }: { status?: string }) {
  const meta = statusMeta(status);
  return <span className={`schedule-v2-pill schedule-v2-pill--${meta.tone}`}>{meta.label}</span>;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <div className="schedule-v2-row schedule-v2-row--skeleton" key={index}>
          <div className="schedule-v2-skeleton schedule-v2-skeleton--title" />
          <div className="schedule-v2-skeleton schedule-v2-skeleton--meta" />
          <div className="schedule-v2-skeleton schedule-v2-skeleton--actions" />
        </div>
      ))}
    </>
  );
}

export function SchedulePageV2({ adoptId }: { adoptId?: string }) {
  const aid = adoptId || "";
  const { confirm, dialog } = useConfirmDialog();
  const [jobs, setJobs] = useState<CronJobV2[]>([]);
  const [runs, setRuns] = useState<CronRunV2[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewRun[]>>({});
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [expandedRunJobIds, setExpandedRunJobIds] = useState<Set<string>>(() => new Set());
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [capabilities, setCapabilities] = useState<CronCapabilities | null>(null);

  const latestRunByJob = useMemo(() => {
    const map = new Map<string, CronRunV2>();
    for (const run of runs) {
      if (!map.has(run.jobId)) map.set(run.jobId, run);
    }
    return map;
  }, [runs]);

  async function load() {
    if (!aid) return;
    setLoading(true);
    setError("");
    try {
      const resp = await fetch(`/api/ea/session-view/cron?adoptId=${encodeURIComponent(aid)}&limit=100`, { credentials: "include" });
      if (!resp.ok) throw new Error(`${T.jobLoadFailed} (${resp.status})`);
      const data = await resp.json();
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      setRuns(Array.isArray(data?.runs) ? data.runs : []);
      setCapabilities(data?.capabilities || null);
    } catch (err: any) {
      setError(err?.message || T.loadFailed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [aid]);

  const supportsScheduleKind = (kind: CreateScheduleKind) => {
    const kinds = capabilities?.scheduleKinds;
    if (!kinds || kinds.length === 0) return true;
    if (kind === "daily") return kinds.includes("cron");
    return kinds.includes(kind as any);
  };

  useEffect(() => {
    if (!capabilities?.scheduleKinds?.length) return;
    if (supportsScheduleKind(createForm.scheduleKind)) return;
    const fallback: CreateScheduleKind = capabilities.scheduleKinds.includes("interval")
      ? "interval"
      : capabilities.scheduleKinds.includes("once")
        ? "once"
        : "cron";
    setCreateForm((form) => ({ ...form, scheduleKind: fallback }));
  }, [capabilities, createForm.scheduleKind]);

  async function runNow(job: CronJobV2) {
    if (!aid || runningJobId) return;
    setRunningJobId(job.id);
    setExpandedRunJobIds((prev) => new Set(prev).add(job.id));
    const target = job.delivery?.targets?.[0];
    try {
      const resp = await fetch("/api/claw/cron/run", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: aid, id: job.id }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || `${T.runNowFailed} (${resp.status})`);
      }
      const data = await resp.json().catch(() => ({}));
      toast.success(`${T.started} ${target?.channelLabel || channelLabel(target?.channelId)}`);
      void pollRunResult(job.id, typeof data?.runId === "string" ? data.runId : undefined);
    } catch (err: any) {
      setRunningJobId(null);
      toast.error(err?.message || T.runNowFailed);
    }
  }

  async function pollRunResult(jobId: string, runId?: string) {
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1800 : 3000));
      try {
        const resp = await fetch(`/api/ea/session-view/cron?adoptId=${encodeURIComponent(aid)}&jobId=${encodeURIComponent(jobId)}&limit=20`, { credentials: "include" });
        if (!resp.ok) continue;
        const data = await resp.json();
        const nextRuns: CronRunV2[] = Array.isArray(data?.runs) ? data.runs : [];
        if (nextRuns.length > 0) {
          setRuns((prev) => {
            const rest = prev.filter((run) => run.jobId !== jobId);
            return [...nextRuns, ...rest];
          });
        }
        const targetRun = runId ? nextRuns.find((run) => run.id === runId) : nextRuns[0];
        if (targetRun && targetRun.status !== "running") {
          await load();
          break;
        }
      } catch {
        // Keep polling; a transient refresh failure should not hide a completed run.
      }
    }
    setRunningJobId((current) => current === jobId ? null : current);
  }

  async function toggleJob(job: CronJobV2) {
    if (!aid) return;
    const previous = jobs;
    setJobs((items) => items.map((item) => (item.id === job.id ? { ...item, enabled: !job.enabled } : item)));
    try {
      const resp = await fetch("/api/claw/cron/update", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: aid, id: job.id, patch: { enabled: !job.enabled } }),
      });
      if (!resp.ok) throw new Error(T.enableFailed);
      toast.success(job.enabled ? T.disabled : T.enabled);
      setTimeout(load, 500);
    } catch (err: any) {
      setJobs(previous);
      toast.error(err?.message || T.enableFailed);
    }
  }

  async function removeJob(job: CronJobV2) {
    if (!aid) return;
    const ok = await confirm({
      title: "删除定时任务？",
      description: `${T.deleteConfirmPrefix}${job.name}${T.deleteConfirmSuffix}`,
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const resp = await fetch("/api/claw/cron/remove", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: aid, id: job.id }),
      });
      if (!resp.ok) throw new Error(T.deleteFailed);
      toast.success(T.deleted);
      load();
    } catch (err: any) {
      toast.error(err?.message || T.deleteFailed);
    }
  }

  async function togglePreview(job: CronJobV2) {
    if (previewJobId === job.id) {
      setPreviewJobId(null);
      return;
    }
    setPreviewJobId(job.id);
    if (previews[job.id]) return;
    setPreviewLoading(job.id);
    try {
      const resp = await fetch("/api/claw/cron/preview-runs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: aid, schedule: job.schedule, count: 5 }),
      });
      if (!resp.ok) throw new Error(T.previewFailed);
      const data = await resp.json();
      setPreviews((prev) => ({ ...prev, [job.id]: Array.isArray(data?.runs) ? data.runs : [] }));
    } catch (err: any) {
      toast.error(err?.message || T.previewFailed);
    } finally {
      setPreviewLoading(null);
    }
  }

  async function copyRunOutput(run: CronRunV2 | undefined, copyId: string) {
    const text = runOutputText(run, "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedRunId(copyId);
      window.setTimeout(() => setCopiedRunId((current) => current === copyId ? null : current), 1400);
      toast.success("执行结果已复制");
    } catch {
      toast.error("复制失败");
    }
  }

  function toggleRunOutput(jobId: string) {
    setExpandedRunJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  async function createJob() {
    if (!aid || createBusy) return;
    const job = buildCreateJob(createForm);
    if (!job.name || !job.prompt) {
      toast.error(T.requiredHint);
      return;
    }
    if (job.schedule.kind === "once" && !job.schedule.runAt) {
      toast.error("\u8bf7\u9009\u62e9\u5355\u6b21\u6267\u884c\u65f6\u95f4");
      return;
    }
    setCreateBusy(true);
    try {
      const resp = await fetch("/api/claw/cron/add", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: aid, job }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || `${T.createFailed} (${resp.status})`);
      toast.success(T.createSuccess);
      setCreateForm(EMPTY_CREATE_FORM);
      setCreateOpen(false);
      await load();
    } catch (err: any) {
      toast.error(err?.message || T.createFailed);
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <PageContainer title={T.pageTitle}>
      {dialog}
      <div className="schedule-v2 ea-data-page">
        <div className="schedule-v2-toolbar ea-data-toolbar">
          <div className="schedule-v2-toolbar-actions ea-data-toolbar__actions">
            <button className="schedule-v2-btn schedule-v2-btn--primary ea-data-btn ea-data-btn--primary" onClick={() => setCreateOpen((v) => !v)} disabled={!aid}>
              <Plus size={14} /> {createOpen ? T.collapseCreate : T.createTask}
            </button>
            <button className="schedule-v2-btn schedule-v2-btn--ghost ea-data-btn ea-data-btn--ghost" onClick={load} disabled={loading}>
              <RefreshCw size={14} /> {T.refresh}
            </button>
          </div>
        </div>

        {!aid && <div className="schedule-v2-empty ea-data-empty">{T.missingAdoptId}</div>}

        {error && (
          <div className="schedule-v2-error ea-data-error">
            <span>{error}</span>
            <button className="schedule-v2-btn schedule-v2-btn--ghost ea-data-btn ea-data-btn--ghost" onClick={load}>{T.retry}</button>
          </div>
        )}

        {createOpen && (
          <div className="schedule-v2-create">
            <div className="schedule-v2-form-grid">
              <label className="schedule-v2-field">
                <span>{T.taskName}</span>
                <input
                  value={createForm.name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={T.taskNamePlaceholder}
                />
              </label>
              <label className="schedule-v2-field schedule-v2-field--wide">
                <span>{T.promptLabel}</span>
                <input
                  value={createForm.prompt}
                  onChange={(e) => setCreateForm((f) => ({ ...f, prompt: e.target.value }))}
                  placeholder={T.promptPlaceholder}
                />
              </label>
              <label className="schedule-v2-field">
                <span>{T.scheduleKind}</span>
                <select
                  value={createForm.scheduleKind}
                  onChange={(e) => setCreateForm((f) => ({ ...f, scheduleKind: e.target.value as CreateScheduleKind }))}
                >
                  {supportsScheduleKind("daily") && <option value="daily">{T.daily}</option>}
                  {supportsScheduleKind("interval") && <option value="interval">{T.interval}</option>}
                  {supportsScheduleKind("once") && <option value="once">{T.once}</option>}
                  {supportsScheduleKind("cron") && <option value="cron">{T.cronExpr}</option>}
                </select>
              </label>
              {createForm.scheduleKind === "daily" ? (
                <label className="schedule-v2-field">
                  <span>{T.nextRun}</span>
                  <input
                    type="time"
                    value={createForm.dailyTime}
                    onChange={(e) => setCreateForm((f) => ({ ...f, dailyTime: e.target.value }))}
                  />
                </label>
              ) : createForm.scheduleKind === "interval" ? (
                <label className="schedule-v2-field">
                  <span>{T.interval}</span>
                  <input
                    type="number"
                    min={30}
                    step={30}
                    value={createForm.intervalMinutes}
                    onChange={(e) => setCreateForm((f) => ({ ...f, intervalMinutes: e.target.value }))}
                  />
                </label>
              ) : createForm.scheduleKind === "once" ? (
                <label className="schedule-v2-field">
                  <span>{T.once}</span>
                  <input
                    type="datetime-local"
                    value={createForm.runAt}
                    onChange={(e) => setCreateForm((f) => ({ ...f, runAt: e.target.value }))}
                  />
                </label>
              ) : (
                <label className="schedule-v2-field">
                  <span>{T.cronExpr}</span>
                  <input
                    value={createForm.cronExpr}
                    onChange={(e) => setCreateForm((f) => ({ ...f, cronExpr: e.target.value }))}
                    placeholder="0 9 * * *"
                  />
                </label>
              )}
              <label className="schedule-v2-field">
                <span>{T.deliveryChannel}</span>
                <select
                  value={createForm.channelId}
                  onChange={(e) => setCreateForm((f) => ({ ...f, channelId: e.target.value as CreateForm["channelId"] }))}
                >
                  <option value="web">{CHANNEL_LABEL.web}</option>
                  <option value="wechat">{CHANNEL_LABEL.wechat}</option>
                  <option value="feishu">{CHANNEL_LABEL.feishu}</option>
                  <option value="wecom" disabled>{CHANNEL_LABEL.wecom}\uff08\u5373\u5c06\u4e0a\u7ebf\uff09</option>
                </select>
              </label>
              <button className="schedule-v2-btn schedule-v2-btn--primary schedule-v2-create-submit ea-data-btn ea-data-btn--primary" onClick={createJob} disabled={createBusy}>
                <Plus size={14} /> {createBusy ? T.saving : T.saveTask}
              </button>
            </div>
          </div>
        )}

        <div className="schedule-v2-card ea-data-card">
          <div className="schedule-v2-header ea-data-header">
            <span>{T.task}</span>
            <span>{T.schedule}</span>
            <span>{T.delivery}</span>
            <span>{T.nextRun}</span>
            <span>{T.status}</span>
            <span>{T.actions}</span>
          </div>

          {loading ? <SkeletonRows /> : jobs.length === 0 ? (
            <div className="schedule-v2-empty ea-data-empty">
              <CalendarClock size={26} />
              <div>{T.emptyTitle}</div>
              <div className="schedule-v2-muted ea-data-muted">
                {T.emptyHint}
              </div>
              <button className="schedule-v2-btn schedule-v2-btn--primary ea-data-btn ea-data-btn--primary" onClick={() => setCreateOpen(true)} disabled={!aid}>
                <Plus size={14} /> {T.createTask}
              </button>
            </div>
          ) : jobs.map((job) => {
            const target = job.delivery?.targets?.[0];
            const latest = latestRunByJob.get(job.id);
            const activePreview = previewJobId === job.id;
            const outputExpanded = expandedRunJobIds.has(job.id) || runningJobId === job.id;
            const canRunNow = job.meta?.runNowSupported !== false && capabilities?.supportsRunNow !== false;
            const canToggle = job.meta?.updateSupported !== false && job.runtime !== "jiuwenclaw";
            const latestOutput = runOutputText(latest, runningJobId === job.id ? T.runningHint : T.noRunOutput);
            const latestCopyId = latest?.id || `${job.id}-latest`;
            return (
              <div className="schedule-v2-row-group" key={job.id}>
                <div
                  className={`schedule-v2-row schedule-v2-row--clickable ea-data-row ea-data-row--clickable${outputExpanded ? " schedule-v2-row--expanded ea-data-row--expanded" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleRunOutput(job.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleRunOutput(job.id);
                    }
                  }}
                  title="点击查看最近执行结果"
                >
                  <div className="schedule-v2-job">
                    <div className="schedule-v2-job-title ea-data-title">
                      <span className={job.enabled ? "schedule-v2-dot schedule-v2-dot--on" : "schedule-v2-dot"} />
                      <span>{job.name}</span>
                      <span className="schedule-v2-expand-icon">
                        {outputExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </div>
                    {job.description && <div className="schedule-v2-muted ea-data-muted">{job.description}</div>}
                  </div>

                  <div className="schedule-v2-cell ea-data-cell">
                    <Clock3 size={14} />
                    <span>{scheduleText(job)}</span>
                  </div>

                  <div className="schedule-v2-cell ea-data-cell">
                    <span className="schedule-v2-channel-icon">{channelIcon(target?.channelId)}</span>
                    <span>{target?.channelLabel || channelLabel(target?.channelId)}</span>
                    {target?.targetLabel && <span className="schedule-v2-muted ea-data-muted">· {target.targetLabel}</span>}
                  </div>

                  <div className="schedule-v2-cell ea-data-cell">{formatDate(job.state?.nextRunAt)}</div>

                  <div className="schedule-v2-cell ea-data-cell">
                    <StatusPill status={latest?.status || job.state?.lastStatus} />
                  </div>

                  <div className="schedule-v2-actions ea-data-actions" onClick={(event) => event.stopPropagation()}>
                    <button className="schedule-v2-icon-btn ea-data-icon-btn" onClick={() => runNow(job)} disabled={!canRunNow || runningJobId === job.id} title={T.runNow}>
                      <Play size={14} /> {T.run}
                    </button>
                    <button className="schedule-v2-icon-btn ea-data-icon-btn" onClick={() => togglePreview(job)} title={T.previewFuture}>
                      {activePreview ? <ChevronDown size={14} /> : <Eye size={14} />} {T.preview}
                    </button>
                    <button className="schedule-v2-icon-btn ea-data-icon-btn" onClick={() => toggleJob(job)} disabled={!canToggle} title={job.enabled ? T.disable : T.enable}>
                      <PauseCircle size={14} /> {job.enabled ? T.disable : T.enable}
                    </button>
                    <button className="schedule-v2-icon-btn schedule-v2-icon-btn--danger ea-data-icon-btn ea-data-icon-btn--danger" onClick={() => removeJob(job)} title={T.delete}>
                      <Trash2 size={14} /> {T.delete}
                    </button>
                  </div>
                </div>

                {outputExpanded && (
                  <div className="schedule-v2-run-output">
                    <div className="schedule-v2-run-output-head">
                      <div className="schedule-v2-preview-title">
                        <ChevronRight size={14} /> 最近执行结果
                      </div>
                      <button
                        type="button"
                        className="schedule-v2-run-copy"
                        onClick={() => copyRunOutput(latest, latestCopyId)}
                        disabled={!latest?.output && !latest?.summary && !latest?.errorMessage && !latest?.error}
                        title="复制执行结果"
                      >
                        {copiedRunId === latestCopyId ? <Check size={13} /> : <Copy size={13} />}
                        {copiedRunId === latestCopyId ? "已复制" : "复制"}
                      </button>
                    </div>
                    <div className="schedule-v2-run-output-meta">
                      <StatusPill status={latest?.status || (runningJobId === job.id ? "running" : undefined)} />
                      {latest?.startedAt && <span>{formatDate(latest.startedAt)}</span>}
                      {runDurationText(latest) && <span>{runDurationText(latest)}</span>}
                      {latest?.id && <span className="schedule-v2-run-output-id">{latest.id}</span>}
                    </div>
                    <div className="schedule-v2-run-output-text">
                      <ChatMarkdown content={latestOutput} />
                    </div>
                  </div>
                )}

                {activePreview && (
                  <div className="schedule-v2-preview">
                    <div className="schedule-v2-preview-title">
                      <ChevronRight size={14} /> {T.futureRuns}
                    </div>
                    {previewLoading === job.id ? (
                      <div className="schedule-v2-muted">{T.computing}</div>
                    ) : (previews[job.id] || []).length === 0 ? (
                      <div className="schedule-v2-muted">{T.noPreview}</div>
                    ) : (
                      <div className="schedule-v2-preview-list">
                        {(previews[job.id] || []).map((run, index) => (
                          <div className="schedule-v2-preview-item" key={`${run.runAt}-${index}`}>
                            <span>{index + 1}. {formatDate(run.runAt)}</span>
                            {run.wakeAt && <span className="schedule-v2-muted">{T.wake} {formatDate(run.wakeAt)}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </PageContainer>
  );
}
