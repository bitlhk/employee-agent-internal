/**
 * AgentTaskCard.tsx
 *
 * Displays async business-agent tasks submitted through EA platform tools.
 * The card is intentionally self-contained: the main chat keeps local
 * JiuwenSwarm replies, while remote Agent progress and result live here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleCheck, CircleX, Clock3, Eye, Files, Loader2 } from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { AgentArtifactThumbnail, agentArtifactPreviewKind, type AgentArtifactView } from "@/components/AgentArtifactPanel";
import { parseAgentTaskArtifacts } from "@shared/agent-artifact";

export interface AgentToolStep {
  name: string;
  status: "running" | "done" | "error";
  durationMs?: number;
}

export type AgentTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "done";

export interface AgentTask {
  id: string;
  parentTaskId?: string | null;
  parent_task_id?: string | null;
  adoptId?: string;
  adopt_id?: string;
  agentId?: string;
  agent_id?: string;
  agentName?: string;
  agent_name?: string;
  prompt?: string;
  input?: string;
  status: AgentTaskStatus | string;
  steps?: AgentToolStep[];
  result?: string;
  resultMarkdown?: string | null;
  result_markdown?: string | null;
  errorMessage?: string | null;
  error_message?: string | null;
  remoteTaskId?: string | null;
  remote_task_id?: string | null;
  adapterProtocol?: string | null;
  adapter_protocol?: string | null;
  artifactsJson?: string | null;
  artifacts_json?: string | null;
  interactionJson?: string | null;
  interaction_json?: string | null;
  interactionStatus?: string | null;
  interaction_status?: string | null;
  interactionResponseJson?: string | null;
  interaction_response_json?: string | null;
  createdAt?: string | Date | null;
  created_at?: string | Date | null;
  startedAt?: string | Date | null;
  started_at?: string | Date | null;
  completedAt?: string | Date | null;
  completed_at?: string | Date | null;
  updatedAt?: string | Date | null;
  updated_at?: string | Date | null;
  durationMs?: number;
}

const STATUS_META: Record<string, { label: string; tone: string }> = {
  pending: { label: "处理中", tone: "pending" },
  running: { label: "处理中", tone: "running" },
  succeeded: { label: "已完成", tone: "success" },
  done: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "muted" },
};

function value<T>(primary: T | undefined | null, fallback: T | undefined | null): T | undefined {
  return primary ?? fallback ?? undefined;
}

function toTime(value: string | Date | null | undefined): number | undefined {
  if (!value) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function formatTime(value: string | Date | null | undefined): string {
  const time = toTime(value);
  if (!time) return "";
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function compactId(id: string | null | undefined): string {
  const s = String(id || "").trim();
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}...${s.slice(-6)}`;
}

function displayAgentName(agentId: string, name?: string): string {
  const raw = String(name || agentId || "").trim();
  return raw || "专家";
}

function parseRawEvents(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return `${parsed.length} 条远端事件`;
    if (parsed && typeof parsed === "object") return "已接收远端事件";
  } catch {}
  return undefined;
}

export function AgentTaskCard({
  task,
  onOpenArtifact,
  onResumeExpert,
}: {
  task: AgentTask;
  onOpenArtifact?: (artifacts: AgentArtifactView[], artifactId?: string) => void;
  onResumeExpert?: (task: AgentTask) => void;
}) {
  const normalized = useMemo(() => {
    const status = String(task.status || "pending");
    const result = value(task.resultMarkdown, task.result_markdown) || task.result || "";
    const error = value(task.errorMessage, task.error_message) || "";
    const input = task.input || task.prompt || "";
    const agentId = value(task.agentId, task.agent_id) || "";
    const agentName = displayAgentName(agentId, value(task.agentName, task.agent_name));
    const remoteTaskId = value(task.remoteTaskId, task.remote_task_id) || "";
    const adapterProtocol = value(task.adapterProtocol, task.adapter_protocol) || "";
    const createdAt = value(task.createdAt, task.created_at);
    const startedAt = value(task.startedAt, task.started_at);
    const completedAt = value(task.completedAt, task.completed_at);
    const updatedAt = value(task.updatedAt, task.updated_at);
    const interactionStatus = value(task.interactionStatus, task.interaction_status) || "";
    const isWaitingForInput = interactionStatus === "pending";
    const isActive = status === "pending" || status === "running";
    const isDone = status === "succeeded" || status === "done";
    const isFailed = status === "failed" || status === "cancelled";
    const artifacts = parseAgentTaskArtifacts(value(task.artifactsJson, task.artifacts_json)).map((artifact) => ({
      ...artifact,
      adoptId: String(task.adoptId || task.adopt_id || ""),
    }));

    return {
      status,
      result,
      error,
      input,
      agentId,
      agentName,
      remoteTaskId,
      adapterProtocol,
      createdAt,
      startedAt,
      completedAt,
      updatedAt,
      isActive,
      isDone,
      isFailed,
      interactionStatus,
      isWaitingForInput,
      artifacts,
      steps: task.steps || [],
    };
  }, [task]);

  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const autoExpandedRef = useRef(false);

  useEffect(() => {
    if (!normalized.isActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [normalized.isActive]);

  useEffect(() => {
    if (!normalized.isDone || autoExpandedRef.current) return;
    autoExpandedRef.current = true;
    setExpanded(true);
  }, [normalized.isDone]);

  const statusMeta = normalized.isWaitingForInput
    ? { label: "等待确认", tone: "pending" }
    : normalized.interactionStatus === "answered"
      ? { label: "已确认", tone: "success" }
      : STATUS_META[normalized.status] || { label: normalized.status || "未知", tone: "muted" };
  const startTime = toTime(normalized.startedAt) || toTime(normalized.createdAt) || now;
  const endTime = toTime(normalized.completedAt) || now;
  const elapsedMs = task.durationMs ?? Math.max(0, endTime - startTime);
  const remoteEventText = parseRawEvents((task as any).rawEventsJson || (task as any).raw_events_json);
  const metaItems = [
    `任务 ${compactId(task.id)}`,
    normalized.remoteTaskId ? `远端 ${compactId(normalized.remoteTaskId)}` : "",
    normalized.adapterProtocol || "",
    normalized.createdAt ? `提交 ${formatTime(normalized.createdAt)}` : "",
    normalized.updatedAt ? `更新 ${formatTime(normalized.updatedAt)}` : "",
  ].filter(Boolean);
  const subtitle = normalized.isWaitingForInput
    ? "需要你确认后继续"
    : normalized.interactionStatus === "answered"
      ? "本轮确认已提交"
      : normalized.status === "pending"
        ? "正在等待专家接收"
        : normalized.status === "running"
          ? "正在处理你的任务"
          : normalized.isDone
            ? normalized.artifacts.length > 0
              ? `已完成并生成 ${normalized.artifacts.length} 个产物`
              : "任务已经完成"
            : normalized.isFailed
              ? "任务未能完成"
              : "查看任务详情";
  const previewArtifact = normalized.artifacts.find((artifact) => (
    artifact.role === "preview" && agentArtifactPreviewKind(artifact) === "image"
  )) || normalized.artifacts.find((artifact) => agentArtifactPreviewKind(artifact) === "image");

  const Icon = normalized.isWaitingForInput
    ? Clock3
    : normalized.isDone
      ? CircleCheck
      : normalized.isFailed
        ? CircleX
        : normalized.isActive
          ? Loader2
          : Clock3;

  return (
    <section className={`agent-task-card agent-task-card--${statusMeta.tone}`}>
      <button type="button" className="agent-task-card__header" onClick={() => setExpanded((v) => !v)}>
        <span className="agent-task-card__icon">
          <Icon size={16} className={normalized.isActive ? "agent-task-card__spin" : undefined} />
        </span>
        <span className="agent-task-card__main">
          <span className="agent-task-card__title-row">
            <span className="agent-task-card__title">{normalized.isActive ? `${normalized.agentName}已接手` : normalized.agentName}</span>
            <span className={`agent-task-card__badge agent-task-card__badge--${statusMeta.tone}`}>{statusMeta.label}</span>
          </span>
          <span className="agent-task-card__subtitle">{subtitle}</span>
        </span>
        <span className="agent-task-card__elapsed">{formatElapsed(elapsedMs)}</span>
        <ChevronDown size={15} className={`agent-task-card__chevron ${expanded ? "is-open" : ""}`} />
      </button>

      {expanded ? (
        <div className="agent-task-card__body">
          <div className="agent-task-card__meta">
            {metaItems.map((item) => <span key={item}>{item}</span>)}
          </div>
          {normalized.steps.length > 0 ? (
            <div className="agent-task-card__steps">
              {normalized.steps.map((step, i) => (
                <div key={`${step.name}-${i}`} className={`agent-task-card__step agent-task-card__step--${step.status}`}>
                  <span>{step.status === "running" ? "运行中" : step.status === "done" ? "完成" : "异常"}</span>
                  <strong>{step.name}</strong>
                  {step.durationMs != null ? <em>{formatElapsed(step.durationMs)}</em> : null}
                </div>
              ))}
            </div>
          ) : null}

          {normalized.isActive ? (
            <div className="agent-task-card__progress">
              <span className="agent-task-card__progress-dot" />
              <span>{normalized.status === "pending" ? "任务已提交，等待专家接收。" : "专家正在处理，结果完成后会写回此卡片。"}</span>
              {remoteEventText ? <span className="agent-task-card__progress-extra">{remoteEventText}</span> : null}
            </div>
          ) : null}

          {normalized.isWaitingForInput ? (
            <div className="agent-task-card__progress">
              <span className="agent-task-card__progress-dot" />
              <span>专家需要继续确认，请在输入框中选择或补充。</span>
            </div>
          ) : null}

          {normalized.error ? (
            <div className="agent-task-card__error">{normalized.error}</div>
          ) : null}

          {normalized.result ? (
            <div className="agent-task-card__result">
              <ChatMarkdown content={normalized.result} />
            </div>
          ) : null}

          {previewArtifact && onOpenArtifact ? (
            <AgentArtifactThumbnail
              artifact={previewArtifact}
              onOpen={() => onOpenArtifact(normalized.artifacts, previewArtifact.id)}
            />
          ) : null}

          {normalized.artifacts.length > 0 ? (
            <div className="agent-task-card__artifacts">
              <span><Files size={14} /> 任务产物</span>
              <div>
                {normalized.artifacts.map((artifact) => (
                  <button
                    type="button"
                    key={`${artifact.id}:${artifact.path}`}
                    onClick={() => onOpenArtifact?.(normalized.artifacts, artifact.id)}
                    title={`查看 ${artifact.name}`}
                  >
                    <Eye size={13} />
                    <span>{artifact.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {normalized.isWaitingForInput && onResumeExpert ? (
            <button type="button" className="agent-task-card__resume" onClick={() => onResumeExpert(task)}>
              继续与{normalized.agentName}协作
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
