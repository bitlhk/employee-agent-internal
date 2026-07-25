/**
 * AgentTaskCard.tsx
 *
 * Displays async business-agent tasks submitted through EA platform tools.
 * The card is intentionally self-contained: the main chat keeps local
 * JiuwenSwarm replies, while remote Agent progress and result live here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Database, Eye, FileCheck2, Files, ShieldCheck, Square } from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ExpertAvatar, ExpertMemberAvatar, ExpertTeamAvatar, isInvestmentTeamExpert, isInvestmentTeamMember } from "@/components/ExpertAvatar";
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
  rawEventsJson?: string | null;
  raw_events_json?: string | null;
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

type TeamProgress = {
  memberId: string;
  memberName: string;
  status: "running" | "done" | "error" | string;
  summary: string;
  stage: string;
  reason: string;
  memberIds: string[];
};

function parseTeamProgress(raw: string | null | undefined): TeamProgress[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const latest = new Map<string, TeamProgress>();
    for (const item of parsed) {
      const progress = item?.progress;
      const memberId = String(progress?.memberId || "").trim();
      const memberName = String(progress?.memberName || "").trim();
      if (!memberId || !memberName) continue;
      latest.set(memberId, {
        memberId,
        memberName,
        status: String(progress?.status || "running"),
        summary: String(progress?.summary || "").trim(),
        stage: String(progress?.stage || "").trim(),
        reason: String(progress?.reason || "").trim(),
        memberIds: Array.isArray(progress?.memberIds)
          ? progress.memberIds.map((memberId: unknown) => String(memberId || "").trim()).filter(Boolean)
          : [],
      });
    }
    return Array.from(latest.values());
  } catch {
    return [];
  }
}

export function AgentTaskCard({
  task,
  onOpenArtifact,
  onResumeExpert,
  onCancel,
}: {
  task: AgentTask;
  onOpenArtifact?: (artifacts: AgentArtifactView[], artifactId?: string) => void;
  onResumeExpert?: (task: AgentTask) => void;
  onCancel?: (task: AgentTask) => Promise<void> | void;
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
  const [taskDetailsExpanded, setTaskDetailsExpanded] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const autoExpandedRef = useRef(false);
  const teamAutoExpandedRef = useRef(false);

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
  const rawEventsJson = value(task.rawEventsJson, task.raw_events_json);
  const remoteEventText = parseRawEvents(rawEventsJson);
  const teamProgress = useMemo(() => parseTeamProgress(rawEventsJson), [rawEventsJson]);
  const isInvestmentTeam = isInvestmentTeamExpert(normalized.agentId, normalized.agentName);
  const teamPlan = teamProgress.find((item) => item.memberId === "team_planner");
  const selectedTeamProgress = teamProgress.filter((item) => isInvestmentTeamMember(item.memberId));
  const dataProgress = teamProgress.find((item) => item.memberId === "data");
  const workflowProgress = teamProgress.filter((item) => ["risk_manager", "committee_chair"].includes(item.memberId));
  const completedTeamSteps = selectedTeamProgress.filter((item) => item.status === "done").length;
  const plannedTeamMemberIds = teamPlan?.memberIds.length
    ? teamPlan.memberIds
    : selectedTeamProgress.map((item) => item.memberId);
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

  useEffect(() => {
    if (!normalized.isActive || teamProgress.length === 0 || teamAutoExpandedRef.current) return;
    teamAutoExpandedRef.current = true;
    setExpanded(true);
  }, [normalized.isActive, teamProgress.length]);

  return (
    <section className={`agent-task-card agent-task-card--${statusMeta.tone}`} data-team={isInvestmentTeam ? "true" : "false"}>
      <button type="button" className="agent-task-card__header" onClick={() => setExpanded((v) => !v)}>
        <span className="agent-task-card__icon">
          {isInvestmentTeam
            ? <ExpertTeamAvatar memberIds={plannedTeamMemberIds} animated={normalized.isActive} />
            : <ExpertAvatar agentId={normalized.agentId} agentName={normalized.agentName} />}
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
          <button
            type="button"
            className="agent-task-card__details-toggle"
            aria-expanded={taskDetailsExpanded}
            onClick={() => setTaskDetailsExpanded((current) => !current)}
          >
            <span>任务详情</span>
            <ChevronDown size={14} className={taskDetailsExpanded ? "is-open" : ""} />
          </button>
          {taskDetailsExpanded ? (
            <div className="agent-task-card__meta">
              {metaItems.map((item) => <span key={item}>{item}</span>)}
            </div>
          ) : null}
          {teamPlan ? (
            <div className="agent-task-card__team-plan">
              <span className="agent-task-card__team-plan-avatar">
                <ExpertTeamAvatar memberIds={plannedTeamMemberIds} animated={normalized.isActive} />
              </span>
              <div>
                <strong>动态组队</strong>
                <p>{teamPlan.summary}</p>
                {teamPlan.reason ? <small>{teamPlan.reason}</small> : null}
              </div>
            </div>
          ) : null}
          {dataProgress ? (
            <div className="agent-task-card__data" data-status={dataProgress.status}>
              <span><Database aria-hidden="true" /></span>
              <div>
                <strong>{dataProgress.memberName}</strong>
                <p>{dataProgress.summary || (dataProgress.status === "done" ? "研究数据已准备完成" : "正在准备研究数据")}</p>
              </div>
            </div>
          ) : null}
          {selectedTeamProgress.length > 0 ? (
            <div className="agent-task-card__team" aria-label="专家团进度">
              <div className="agent-task-card__team-heading">
                <strong>本轮专家</strong>
                <span>{completedTeamSteps}/{selectedTeamProgress.length} 完成</span>
              </div>
              <div className="agent-task-card__team-list">
                {selectedTeamProgress.map((item) => (
                  <div key={item.memberId} className={`agent-task-card__team-item is-${item.status}`}>
                    <span className="agent-task-card__team-visual">
                      <ExpertMemberAvatar memberId={item.memberId} />
                      <span className="agent-task-card__team-dot" />
                    </span>
                    <span className="agent-task-card__team-copy">
                      <strong>{item.memberName}</strong>
                      {item.reason ? <small>{item.reason}</small> : null}
                      <span>{item.summary || (item.status === "done" ? "已完成" : item.status === "error" ? "未完成" : "处理中")}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {workflowProgress.length > 0 ? (
            <div className="agent-task-card__workflow" aria-label="复核与交付">
              <div className="agent-task-card__team-heading">
                <strong>复核与交付</strong>
              </div>
              {workflowProgress.map((item) => (
                <span key={item.memberId} data-status={item.status}>
                  <i aria-hidden="true">
                    {item.memberId === "risk_manager" ? <ShieldCheck /> : <FileCheck2 />}
                  </i>
                  <strong>{item.memberName}</strong>
                  <em>{item.summary || (item.status === "done" ? "已完成" : "处理中")}</em>
                </span>
              ))}
            </div>
          ) : null}
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
            <div className="agent-task-card__active-row">
              <div className="agent-task-card__progress">
                <span className="agent-task-card__progress-dot" />
                <span>{normalized.status === "pending" ? "任务已提交，等待专家接收。" : "专家正在处理，结果完成后会写回此卡片。"}</span>
                {remoteEventText ? <span className="agent-task-card__progress-extra">{remoteEventText}</span> : null}
              </div>
              {onCancel ? (
                <button
                  type="button"
                  className="agent-task-card__cancel"
                  disabled={cancelPending}
                  onClick={async (event) => {
                    event.stopPropagation();
                    setCancelPending(true);
                    try {
                      await onCancel(task);
                    } finally {
                      setCancelPending(false);
                    }
                  }}
                >
                  <Square size={11} fill="currentColor" />
                  {cancelPending ? "停止中" : "停止任务"}
                </button>
              ) : null}
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
