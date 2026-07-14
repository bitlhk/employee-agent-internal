import { BrandIcon } from "@/components/BrandIcon";
import { memo, useEffect, useMemo, useState, useRef } from "react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { AgentTaskCard, type AgentTask } from "@/components/AgentTaskCard";
import { cleanLeakedToolTags } from "@/lib/clean-leaked-tags";
import { formatModelName } from "@/lib/modelDisplay";
import { classifyToolName, type ToolVisualKind } from "@/lib/tool-presentation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  ChevronDown,
  Code2,
  Database,
  FileText,
  Globe2,
  Image as ImageIcon,
  Loader2,
  Plug,
  Puzzle,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ToolCallEntry = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  ts: number;
  executor?: "sandbox" | "native" | "none" | "gateway" | "jiuwenswarm" | "timeout";
  truncated?: boolean;
  suppressedOriginalResult?: boolean;
  policyDenyReason?: string;
  auditId?: string;
  outputFiles?: Array<{ name: string; size: number; wsPath?: string }>;
  adoptId?: string;
  _gateway?: boolean;
};

export type MessageEventEntry =
  | {
      type: "text";
      id?: string;
      content: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments?: string;
      result?: string;
      status?: "running" | "done" | "error";
      ts?: number;
      durationMs?: number;
      executor?: ToolCallEntry["executor"];
      truncated?: boolean;
      suppressedOriginalResult?: boolean;
      policyDenyReason?: string;
      auditId?: string;
      outputFiles?: ToolCallEntry["outputFiles"];
      adoptId?: string;
      _gateway?: boolean;
    }
  | {
      type: "permission_request";
      id: string;
      permission: JiuwenPermissionRequestCard;
    };

export type JiuwenPermissionRequestCard = {
  requestId: string;
  source: string;
  title: string;
  question: string;
  command?: string;
  toolName?: string;
  options?: Array<{ label: string; description?: string; value?: string }>;
  state?: "pending" | "submitting" | "approved" | "rejected" | "error";
  error?: string;
};

const TOOL_VISUAL_ICONS: Record<ToolVisualKind, LucideIcon> = {
  agent: Bot,
  browser: Globe2,
  code: Code2,
  database: Database,
  file: FileText,
  image: ImageIcon,
  mcp: Plug,
  skill: Puzzle,
  terminal: Terminal,
  web: Search,
  generic: Wrench,
};

function ToolTypeIcon({ name, className = "" }: { name: string; className?: string }) {
  const Icon = TOOL_VISUAL_ICONS[classifyToolName(name)];
  return <Icon className={className} size={13} strokeWidth={1.9} aria-hidden="true" />;
}

type ChatMessageProps = {
  role: "user" | "assistant";
  text: string;
  status?: string;
  isLast: boolean;
  isPlaceholder: boolean;
  streaming: boolean;
  displayName: string;
  modelId: string;
  timeLabel: string;
  toolCalls?: ToolCallEntry[];
  messageEvents?: MessageEventEntry[];
  agentTasks?: AgentTask[];
  showToolCalls?: boolean;
  usage?: { input: number; output: number };
  contextPercent?: number | null;
  onDelete?: () => void;
  jiuwenPermission?: JiuwenPermissionRequestCard;
  onJiuwenPermissionAnswer?: (request: JiuwenPermissionRequestCard, action: "allow_once" | "reject") => void;
};

function streamingMarkdownDelay(chars: number) {
  if (chars > 12_000) return 90;
  if (chars > 8_000) return 70;
  return 48;
}

function useThrottledText(value: string, delayMs: number, enabled: boolean) {
  const [throttled, setThrottled] = useState(value);
  const lastUpdateRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(value);
      lastUpdateRef.current = Date.now();
      return;
    }

    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;
    const run = () => {
      setThrottled(value);
      lastUpdateRef.current = Date.now();
      timerRef.current = null;
    };

    if (elapsed >= delayMs) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      run();
    } else if (timerRef.current == null) {
      timerRef.current = window.setTimeout(run, delayMs - elapsed);
    }

    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, delayMs, enabled]);

  return enabled ? throttled : value;
}

function repairStreamingMarkdown(content: string) {
  const text = String(content || "");
  const fenceCount = (text.match(/```/g) || []).length;
  return fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
}

// ── Gateway 内部工具内联状态（web_search / memory_search 等）──
const GATEWAY_TOOL_META: Record<string, { icon: string; label: string }> = {
  web_search:    { icon: "🔍", label: "搜索网页" },
  web_fetch:     { icon: "🌐", label: "获取网页" },
  memory_search: { icon: "🧠", label: "查找记忆" },
  read:          { icon: "📄", label: "读取文件" },
  read_file:     { icon: "📄", label: "读取文件" },
  thinking:      { icon: "💭", label: "深度思考" },
  bash:          { icon: "⌘", label: "执行命令" },
  shell:         { icon: "⌘", label: "执行命令" },
  write:         { icon: "✎", label: "写入文件" },
  write_file:    { icon: "✎", label: "写入文件" },
  edit:          { icon: "✎", label: "编辑文件" },
  edit_file:     { icon: "✎", label: "编辑文件" },
  list_files:    { icon: "📂", label: "列出文件" },
  grep:          { icon: "⌕", label: "搜索文件" },
  glob:          { icon: "⌕", label: "查找路径" },
};

function RunFileButton({ adoptId, filePath, fileName }: { adoptId: string; filePath: string; fileName: string }) {
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);

  const handleRun = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState("running");
    try {
      const resp = await fetch("/api/claw/workspace/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ adoptId, path: filePath }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setResult({ exitCode: 1, stdout: "", stderr: data.error || `HTTP ${resp.status}` });
      } else {
        setResult({ exitCode: data.exitCode, stdout: data.stdout || "", stderr: data.stderr || "" });
      }
    } catch (err) {
      setResult({ exitCode: 1, stdout: "", stderr: String(err) });
    }
    setState("done");
  };

  return (
    <>
      <button
        onClick={handleRun}
        type="button"
        disabled={state === "running"}
        title="在沙箱中运行"
        style={{
          display: "inline-flex", alignItems: "center", gap: 3,
          padding: "2px 8px", borderRadius: "var(--oc-radius-sm)", fontSize: "var(--oc-text-xs)", fontWeight: "var(--oc-weight-medium)",
          color: state === "running" ? "#9ca3af" : "#34d399",
          background: state === "running" ? "rgba(156,163,175,0.08)" : "rgba(52,211,153,0.10)",
          border: `1px solid ${state === "running" ? "rgba(156,163,175,0.2)" : "rgba(52,211,153,0.25)"}`,
          cursor: state === "running" ? "wait" : "pointer",
          whiteSpace: "nowrap", flexShrink: 0,
        }}
      >
        {state === "running" ? (
          <><span className="animate-pulse">●</span> 运行中</>
        ) : (
          <><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> 运行</>
        )}
      </button>
      {state === "done" && result && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => { setState("idle"); setResult(null); }}
        >
          <div
            style={{
              width: "min(640px, 92vw)", maxHeight: "80vh", background: "var(--oc-panel, #1a1a2e)",
              border: "1px solid var(--oc-border, #333)", borderRadius: "var(--oc-radius-lg)",
              display: "flex", flexDirection: "column", overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: "12px 16px", borderBottom: "1px solid var(--oc-border, #333)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ fontSize: "var(--oc-text-base)", fontWeight: "var(--oc-weight-semibold)", color: "var(--oc-text-primary, #e5e5e5)" }}>
                运行结果 · {fileName}
                <span style={{
                  marginLeft: 8, fontSize: "var(--oc-text-xs)", padding: "1px 6px", borderRadius: 4,
                  background: result.exitCode === 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                  color: result.exitCode === 0 ? "#4ade80" : "#f87171",
                }}>
                  exit {result.exitCode}
                </span>
              </div>
              <button onClick={() => { setState("idle"); setResult(null); }} style={{
                background: "none", border: "none", color: "var(--oc-text-secondary, #999)",
                cursor: "pointer", fontSize: 16, padding: "0 4px",
              }}>×</button>
            </div>
            <div style={{ padding: 16, overflow: "auto", flex: 1 }}>
              {result.stdout && (
                <div style={{ marginBottom: result.stderr ? 12 : 0 }}>
                  <div style={{ fontSize: "var(--oc-text-xs)", color: "var(--oc-text-secondary)", marginBottom: 4 }}>stdout</div>
                  <pre style={{
                    fontSize: "var(--oc-text-sm)", lineHeight: 1.5, color: "var(--oc-text-primary, #e5e5e5)",
                    background: "rgba(0,0,0,0.2)", borderRadius: "var(--oc-radius-md)", padding: 12,
                    whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 400, overflow: "auto",
                    margin: 0,
                  }}>{result.stdout}</pre>
                </div>
              )}
              {result.stderr && (
                <div>
                  <div style={{ fontSize: "var(--oc-text-xs)", color: "var(--oc-danger)", marginBottom: 4 }}>stderr</div>
                  <pre style={{
                    fontSize: "var(--oc-text-sm)", lineHeight: 1.5, color: "#fca5a5",
                    background: "rgba(239,68,68,0.06)", borderRadius: "var(--oc-radius-md)", padding: 12,
                    whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200, overflow: "auto",
                    margin: 0,
                  }}>{result.stderr}</pre>
                </div>
              )}
              {!result.stdout && !result.stderr && (
                <div style={{ fontSize: "var(--oc-text-base)", color: "var(--oc-text-secondary)", textAlign: "center", padding: 24 }}>
                  (无输出)
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function formatToolArguments(rawArguments: string) {
  let argsDisplay = rawArguments;
  try {
    const parsed = JSON.parse(rawArguments);
    argsDisplay = JSON.stringify(parsed, null, 2);
  } catch {}
  return argsDisplay;
}

function toolResultSnippet(tc: ToolCallEntry): string {
  if (!tc.result || tc.status === "running") return "";
  const text = String(tc.result)
    .replace(/\s+/g, " ")
    .replace(/[{}"]/g, "")
    .trim();
  if (!text) return "";
  return text.length > 78 ? `${text.slice(0, 78)}...` : text;
}

function CopyableToolBlock({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = String(value || "");
  const isLong = text.length > 900 || text.split("\n").length > 14;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <div className="lingxia-toolcard__section">
      <div className="lingxia-toolcard__section-head">
        <div className="lingxia-toolcard__label">{label}</div>
        <div className="lingxia-toolcard__section-actions">
          {isLong ? (
            <button type="button" className="lingxia-toolcard__mini-btn" onClick={() => setExpanded((current) => !current)}>
              {expanded ? "收起" : "展开"}
            </button>
          ) : null}
          <button type="button" className="lingxia-toolcard__mini-btn" onClick={copy}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre className={`lingxia-toolcard__pre ${danger ? "lingxia-toolcard__pre--danger" : ""}`} data-expanded={expanded ? "true" : "false"}>
        {text || "(无输出)"}
      </pre>
    </div>
  );
}

function ToolCallDetailBody({ tc }: { tc: ToolCallEntry }) {
  const isRunning = tc.status === "running";
  const isError = tc.status === "error";
  const argsDisplay = formatToolArguments(tc.arguments);

  return (
    <div className="lingxia-toolcard__body">
      {argsDisplay && (
        <CopyableToolBlock label="参数" value={argsDisplay} />
      )}

      {!isRunning && (
        <CopyableToolBlock label={isError ? "错误" : "结果"} value={tc.result || "(无输出)"} danger={isError} />
      )}

      {tc.outputFiles && tc.outputFiles.length > 0 && (
        <div className="lingxia-toolcard__section">
          <div className="lingxia-toolcard__label">产出文件</div>
          <div className="lingxia-toolcard__files">
            {tc.outputFiles.map((f) => {
              const sizeStr =
                f.size > 1024 * 1024
                  ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                  : f.size > 1024
                  ? `${(f.size / 1024).toFixed(1)} KB`
                  : `${f.size} B`;

              const wsPath = (f as any).wsPath as string | undefined;
              const adoptId = tc.adoptId || "";

              const handleDownload = async (e: React.MouseEvent) => {
                e.preventDefault();
                try {
                  const path = wsPath ? wsPath : `sandbox-files/${f.name}`;
                  const resp = await fetch("/api/claw/files/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ adoptId, path }),
                  });
                  if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    alert(`下载失败：${err.error || resp.status}`);
                    return;
                  }
                  const { url } = await resp.json();
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = f.name;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                } catch (err) {
                  alert(`下载异常：${String(err)}`);
                }
              };

              const isHtmlFile = /\.html?$/i.test(f.name);
              const isRunnable = /\.(py|js|ts|sh|bash)$/i.test(f.name);

              const handlePreview = async (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  const path = wsPath ? wsPath : `sandbox-files/${f.name}`;
                  const resp = await fetch("/api/claw/files/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ adoptId, path }),
                  });
                  if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    alert(`预览失败：${err.error || resp.status}`);
                    return;
                  }
                  const { url } = await resp.json();
                  window.open(url + "&preview=1", "_blank", "noopener");
                } catch (err) {
                  alert(`预览异常：${String(err)}`);
                }
              };

              return (
                <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <a href="#" onClick={handleDownload} className="lingxia-toolcard__file" style={{ flex: 1 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span>{f.name}</span>
                    <span style={{ opacity: 0.6 }}>({sizeStr})</span>
                  </a>
                  {isHtmlFile && (
                    <button
                      onClick={handlePreview}
                      type="button"
                      title="在新标签页预览"
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 3,
                        padding: "2px 8px", borderRadius: "var(--oc-radius-sm)", fontSize: "var(--oc-text-xs)", fontWeight: "var(--oc-weight-medium)",
                        color: "#a78bfa", background: "rgba(124,58,237,0.10)",
                        border: "1px solid rgba(124,58,237,0.25)", cursor: "pointer",
                        whiteSpace: "nowrap", flexShrink: 0,
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      预览
                    </button>
                  )}
                  {isRunnable && (
                    <RunFileButton adoptId={adoptId} filePath={wsPath || `sandbox-files/${f.name}`} fileName={f.name} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tc }: { tc: ToolCallEntry }) {
  const isRunning = tc.status === "running";
  const isDone    = tc.status === "done";
  const isError   = tc.status === "error";

  const duration = tc.durationMs != null ? `${tc.durationMs}ms` : null;

  return (
    <details className="lingxia-toolcard" >
      <summary className="lingxia-toolcard__header" style={{ cursor: "pointer", listStyle: "none" }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 4, background: isRunning ? "rgba(239,68,68,0.12)" : isDone ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)", flexShrink: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isRunning ? "#ef4444" : isDone ? "#22c55e" : "#ef4444"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </span>
        <span className="lingxia-toolcard__title">{toolCallLabel(tc)}</span>
        <span className="lingxia-toolcard__status">
          {isRunning && <span className="animate-pulse">执行中…</span>}
          {isDone    && "✓"}
          {isError   && "✕"}
        </span>
        <div className="lingxia-toolcard__meta">
          {tc.executor === "sandbox" && (
            <span className="lingxia-toolcard__chip lingxia-toolcard__chip--sandbox">沙箱</span>
          )}
          {tc.truncated && (
            <span className="lingxia-toolcard__chip lingxia-toolcard__chip--warn">输出已截断</span>
          )}
          {tc.policyDenyReason && (
            <span className="lingxia-toolcard__chip lingxia-toolcard__chip--danger">安全策略拒绝</span>
          )}
          {duration && <span className="lingxia-toolcard__status">{duration}</span>}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4, opacity: 0.4, transition: "transform 0.2s" }} className="lingxia-toolcard__chevron"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </summary>

      <ToolCallDetailBody tc={tc} />
    </details>
  );
}

function toolCallLabel(tc: ToolCallEntry): string {
  const rawName = String(tc.name || "tool");
  const lower = rawName.toLowerCase();
  if (GATEWAY_TOOL_META[rawName]) return GATEWAY_TOOL_META[rawName].label;
  if (GATEWAY_TOOL_META[lower]) return GATEWAY_TOOL_META[lower].label;
  if (rawName === "[产出文件]" || lower.includes("workspace_files")) return "产出文件";
  if (lower === "load_tools") return "加载工具";
  if (lower.includes("weather")) return "查询天气";
  if (lower.includes("search")) return "检索信息";
  if (lower.includes("skill")) return "调用技能";
  if (lower.includes("mcp")) return "调用 MCP 工具";
  if (lower.includes("bash") || lower.includes("shell")) return "执行命令";
  return rawName.replace(/[_-]+/g, " ");
}

function toolCallDurationLabel(tc: ToolCallEntry): string {
  const duration = tc.durationMs ?? (tc.status === "running" ? Date.now() - tc.ts : 0);
  if (!duration || duration < 1000) return "";
  const seconds = Math.round(duration / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function toolCallStatusLabel(status: ToolCallEntry["status"]): string {
  return status === "running" ? "执行中" : status === "error" ? "失败" : "完成";
}

function toolTimelineActivityLabel(status: string | undefined, calls: ToolCallEntry[]): string {
  const clean = String(status || "").trim();
  if (!clean || calls.some((tc) => tc.status === "running")) return "";
  if (/^正在调用工具\s*[:：]/.test(clean)) return "";
  return clean;
}

function toolCallSummaryLabel(calls: ToolCallEntry[], activityLabel = ""): string {
  if (calls.length === 1) {
    const call = calls[0];
    const duration = toolCallDurationLabel(call);
    return [
      toolCallLabel(call),
      activityLabel,
      toolCallStatusLabel(call.status),
      duration,
      call.outputFiles?.length ? `${call.outputFiles.length} 个文件` : "",
    ].filter(Boolean).join(" · ");
  }

  const running = calls.filter((tc) => tc.status === "running").length;
  const errors = calls.filter((tc) => tc.status === "error").length;
  const done = calls.filter((tc) => tc.status === "done").length;
  const files = calls.reduce((total, tc) => total + (tc.outputFiles?.length || 0), 0);
  return [
    `调用 ${calls.length} 个工具`,
    activityLabel,
    running ? `${running} 执行中` : "",
    done ? `${done} 完成` : "",
    errors ? `${errors} 失败` : "",
    files ? `${files} 个文件` : "",
  ].filter(Boolean).join(" · ");
}

function ToolTimelineStep({ tc, index, total }: { tc: ToolCallEntry; index: number; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());
  const duration = toolCallDurationLabel(tc);
  const snippet = toolResultSnippet(tc);
  const meta = [
    toolCallStatusLabel(tc.status),
    duration,
    tc.outputFiles?.length ? `${tc.outputFiles.length} 个文件` : "",
    snippet,
  ].filter(Boolean).join(" · ");
  const rowContent = (
    <>
      <span className="lingxia-tool-step__rail" aria-hidden="true">
        <span className="lingxia-tool-step__dot" />
        {index < total - 1 ? <span className="lingxia-tool-step__line" /> : null}
      </span>
      <span className="lingxia-tool-step__body">
        <span className="lingxia-tool-step__title-row">
          <ToolTypeIcon name={tc.name} className="lingxia-tool-step__icon" />
          <span className="lingxia-tool-step__title">{toolCallLabel(tc)}</span>
        </span>
        <span className="lingxia-tool-step__meta">{meta}</span>
      </span>
    </>
  );

  if (tc._gateway) {
    return (
      <div className={`lingxia-tool-step is-${tc.status}`}>
        {rowContent}
      </div>
    );
  }

  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div
      className={`lingxia-tool-step-detail is-${tc.status}`}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        className="lingxia-tool-step-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {rowContent}
        <ChevronDown className="lingxia-tool-step__chevron" size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="tool-step-detail"
            className="lingxia-tool-step-detail__collapse"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
          >
            <div className="lingxia-tool-step-detail__body">
              <ToolCallDetailBody tc={tc} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ToolCallTimeline({ toolCalls, status }: { toolCalls: ToolCallEntry[]; status?: string }) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());
  const visibleCalls = toolCalls.filter((tc) => tc?.id && tc?.name);
  if (visibleCalls.length === 0) return null;
  const hasError = visibleCalls.some((tc) => tc.status === "error");
  const hasRunning = visibleCalls.some((tc) => tc.status === "running");
  const activityLabel = toolTimelineActivityLabel(status, visibleCalls);
  const isActive = hasRunning || Boolean(activityLabel);
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div className="lingxia-tool-timeline-wrap" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className={`lingxia-tool-summary ${isActive ? "is-running" : hasError ? "is-error" : "is-done"}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="lingxia-tool-summary__icon" aria-hidden="true">
          {isActive ? (
            <Loader2 className="lingxia-tool-summary__loader" size={13} strokeWidth={2} />
          ) : visibleCalls.length === 1 ? (
            <ToolTypeIcon name={visibleCalls[0].name} />
          ) : (
            <Wrench size={13} strokeWidth={1.9} />
          )}
        </span>
        <span className="lingxia-tool-summary__text" aria-live="polite">
          {toolCallSummaryLabel(visibleCalls, activityLabel)}
        </span>
        <span className="lingxia-tool-summary__action">{expanded ? "收起" : "详情"}</span>
        <ChevronDown className="lingxia-tool-summary__chevron" size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="tool-timeline-panel"
            className="lingxia-tool-timeline-panel"
            initial={{ height: 0, opacity: 0, y: -2 }}
            animate={{ height: "auto", opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: -2 }}
            transition={transition}
          >
            <div className="lingxia-tool-timeline" aria-label="工具调用记录">
              {visibleCalls.map((tc, index) => (
                <ToolTimelineStep key={tc.id} tc={tc} index={index} total={visibleCalls.length} />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function toolCallsRenderSignature(toolCalls?: ToolCallEntry[]): string {
  if (!toolCalls?.length) return "";
  return toolCalls
    .map((tc) => [
      tc.id,
      tc.name,
      tc.status,
      tc.durationMs ?? "",
      tc.result ? tc.result.length : 0,
      tc.outputFiles?.length ?? 0,
      tc.truncated ? "truncated" : "",
      tc.policyDenyReason || "",
    ].join(":"))
    .join("|");
}

function toolCallFromMessageEvent(event: MessageEventEntry): ToolCallEntry | null {
  if (event.type !== "tool_call") return null;
  const id = String(event.id || "").trim();
  const name = String(event.name || "").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    arguments: String(event.arguments || "{}"),
    result: event.result,
    status: event.status || (event.result != null ? "done" : "running"),
    ts: Number(event.ts || Date.now()),
    durationMs: event.durationMs,
    executor: event.executor,
    truncated: event.truncated,
    suppressedOriginalResult: event.suppressedOriginalResult,
    policyDenyReason: event.policyDenyReason,
    auditId: event.auditId,
    outputFiles: event.outputFiles,
    adoptId: event.adoptId,
    _gateway: event._gateway,
  };
}

function toolCallsFromMessageEvents(events?: MessageEventEntry[]): ToolCallEntry[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const byId = new Map<string, ToolCallEntry>();
  for (const event of events) {
    const toolCall = toolCallFromMessageEvent(event);
    if (!toolCall) continue;
    const existing = byId.get(toolCall.id);
    byId.set(toolCall.id, existing ? { ...existing, ...toolCall } : toolCall);
  }
  return Array.from(byId.values());
}

function messageEventsRenderSignature(events?: MessageEventEntry[]): string {
  if (!events?.length) return "";
  return events
    .map((event) => {
      if (event.type === "tool_call") {
        return [
          event.type,
          event.id,
          event.name,
          event.status || "",
          event.durationMs ?? "",
          event.result ? event.result.length : 0,
          event.outputFiles?.length ?? 0,
        ].join(":");
      }
      if (event.type === "permission_request") return `${event.type}:${event.id}:${event.permission.state || ""}`;
      return `${event.type}:${event.content.length}`;
    })
    .join("|");
}

function agentTasksRenderSignature(tasks?: AgentTask[]): string {
  if (!tasks?.length) return "";
  return tasks
    .map((task) => [
      task.id,
      task.status,
      task.resultMarkdown || task.result_markdown || task.result || "",
      task.errorMessage || task.error_message || "",
      task.remoteTaskId || task.remote_task_id || "",
      task.updatedAt || task.updated_at || "",
    ].join(":"))
    .join("|");
}

function ChatMessageInner({
  role,
  text,
  status,
  isLast,
  isPlaceholder,
  streaming,
  displayName,
  modelId,
  timeLabel,
  toolCalls,
  messageEvents,
  agentTasks,
  showToolCalls = true,
  usage,
  contextPercent,
  onDelete,
  jiuwenPermission,
  onJiuwenPermissionAnswer,
}: ChatMessageProps) {
  const eventToolCalls = toolCallsFromMessageEvents(messageEvents);
  const effectiveToolCalls = toolCalls && toolCalls.length > 0 ? toolCalls : eventToolCalls;
  const showToolTimeline = showToolCalls && effectiveToolCalls.length > 0;

  if (role === "user") {
    return (
      <div className="flex items-start gap-3 justify-end lingxia-msg-fade">
        <div className="lingxia-user-bubble">
          <div className="rounded-2xl rounded-tr-sm px-4 py-3 text-sm whitespace-pre-wrap lingxia-user-msg-text lingxia-bubble-user">
            {text}
          </div>
          <p className="text-[10px] mt-1 px-1 text-right" style={{ color: "var(--oc-text-tertiary)" }}>You · {timeLabel}</p>
        </div>
        <div
          className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center"
          style={{
            marginTop: 2,
            background: "linear-gradient(135deg, #be1e2d, #8b1520)",
            border: "1px solid rgba(190,30,45,0.5)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="white">
            <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
          </svg>
        </div>
      </div>
    );
  }

  if (isPlaceholder) {
    return (
      <div className="flex items-start gap-3 lingxia-ai-bubble-wrap lingxia-msg-fade">
        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center lingxia-avatar-ai" style={{ marginTop: 2 }}><BrandIcon size={22} /></div>
        <div>
          {showToolTimeline && (
            <div className="mb-2">
              <ToolCallTimeline toolCalls={effectiveToolCalls} status={streaming ? status : undefined} />
            </div>
          )}
          {!showToolTimeline ? (
            <div className="rounded-2xl rounded-tl-sm px-4 py-3 text-sm flex items-center gap-2 lingxia-bubble-ai" style={{ color: "var(--oc-text-tertiary)" }}>
              <span className="lingxia-typing-dots flex items-center gap-1.5" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {status ? <span>{status}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const [copied, setCopied] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const throttleStreamingText = Boolean(isLast && streaming);
  const throttledSourceText = useThrottledText(
    text,
    streamingMarkdownDelay(text.length),
    throttleStreamingText,
  );
  const displayedSourceText = throttleStreamingText ? throttledSourceText : text;
  const displayText = useMemo(() => cleanLeakedToolTags(displayedSourceText), [displayedSourceText]);
  const renderedDisplayText = throttleStreamingText ? repairStreamingMarkdown(displayText) : displayText;
  const onCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(displayText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="flex items-start gap-3 lingxia-ai-bubble-wrap lingxia-msg-fade">
      <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center lingxia-avatar-ai" style={{ marginTop: 2 }}><BrandIcon size={22} /></div>
      <div className="min-w-0 flex-1">
        {showToolTimeline && (
          <div className="mb-2">
            <ToolCallTimeline toolCalls={effectiveToolCalls} status={streaming ? status : undefined} />
          </div>
        )}
        {streaming && status && !showToolTimeline ? (
          <div className="mb-2 text-xs" style={{ color: "var(--oc-text-tertiary)" }} role="status">
            {status}
          </div>
        ) : null}
        <div className="relative group">
          <div
            className={`relative rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed lingxia-bubble-ai ${(isLast && streaming && text) ? "lingxia-token-active" : ""}`}
          >
            {/* 复制按钮 — 气泡右上角 */}
            {!streaming && text && (
              <div className="lingxia-msg-copy absolute top-2 right-2 z-10 flex items-center gap-0.5">
                <button
                  onClick={onCopyMarkdown}
                  type="button"
                  title="复制"
                  className="lingxia-msg-action-btn"
                  style={{ color: copied ? "#4ade80" : undefined }}
                >
                  {copied ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  )}
                </button>
              </div>
            )}
            <ChatMarkdown content={renderedDisplayText} phase={isLast && streaming ? "streaming" : "final"} />
            {isLast && streaming && <span className="animate-pulse ml-0.5" style={{ color: "var(--oc-text-tertiary)" }}>▌</span>}
          </div>
        </div>
        {jiuwenPermission && (
          <div
            className="mt-2 rounded-xl px-3 py-3 text-xs"
            style={{
              background: "color-mix(in oklab, var(--oc-card) 72%, transparent)",
              border: "1px solid var(--oc-border)",
              color: "var(--oc-text-primary)",
              maxWidth: 720,
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div style={{ fontSize: 13, fontWeight: 600 }}>{jiuwenPermission.title || "权限审批"}</div>
                <div className="mt-0.5 truncate" style={{ color: "var(--oc-text-secondary)" }}>
                  {jiuwenPermission.toolName ? `工具：${jiuwenPermission.toolName}` : "JiuwenSwarm 请求授权后继续执行"}
                </div>
              </div>
              <span
                className="shrink-0 rounded-full px-2 py-0.5"
                style={{
                  background: "color-mix(in oklab, var(--oc-bg-secondary) 80%, transparent)",
                  color: "var(--oc-text-tertiary)",
                  fontSize: 11,
                }}
              >
                {jiuwenPermission.state === "approved" ? "已允许" : jiuwenPermission.state === "rejected" ? "已拒绝" : jiuwenPermission.state === "submitting" ? "提交中" : "待确认"}
              </span>
            </div>
            {jiuwenPermission.command ? (
              <pre
                className="mt-2 overflow-auto rounded-lg px-2.5 py-2"
                style={{
                  background: "color-mix(in oklab, var(--oc-bg) 78%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--oc-border) 72%, transparent)",
                  color: "var(--oc-text-secondary)",
                  maxHeight: 140,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {jiuwenPermission.command}
              </pre>
            ) : null}
            {jiuwenPermission.error ? (
              <div className="mt-2" style={{ color: "#ef4444" }}>{jiuwenPermission.error}</div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected"}
                onClick={() => onJiuwenPermissionAnswer?.(jiuwenPermission, "allow_once")}
                className="rounded-lg px-3 py-1.5"
                style={{
                  background: jiuwenPermission.state === "approved" ? "rgba(29,158,117,0.12)" : "var(--oc-text-primary)",
                  color: jiuwenPermission.state === "approved" ? "#1d9e75" : "var(--oc-bg)",
                  border: "1px solid transparent",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected" ? "default" : "pointer",
                }}
              >
                {jiuwenPermission.state === "approved" ? "已允许" : jiuwenPermission.state === "submitting" ? "提交中..." : "本次允许"}
              </button>
              <button
                type="button"
                disabled={jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected"}
                onClick={() => onJiuwenPermissionAnswer?.(jiuwenPermission, "reject")}
                className="rounded-lg px-3 py-1.5"
                style={{
                  background: "transparent",
                  color: jiuwenPermission.state === "rejected" ? "#ef4444" : "var(--oc-text-secondary)",
                  border: "1px solid var(--oc-border)",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected" ? "default" : "pointer",
                }}
              >
                {jiuwenPermission.state === "rejected" ? "已拒绝" : "拒绝"}
              </button>
            </div>
          </div>
        )}
        {agentTasks && agentTasks.length > 0 ? (
          <div className="agent-task-card-list agent-task-card-list--inline">
            {agentTasks.map((task) => <AgentTaskCard key={task.id} task={task} />)}
          </div>
        ) : null}
        {/* 时间戳行 + 朗读/删除 */}
        <p className="text-[10px] mt-1 px-1 font-mono flex items-center gap-1.5 flex-wrap" style={{ color: "var(--oc-text-tertiary)" }}>
          <span>
            {displayName} · {formatModelName(modelId)} · {timeLabel}
            {usage && usage.input + usage.output > 0 && (
              <> · ↑{usage.input} ↓{usage.output}</>
            )}
            {contextPercent != null && (
              <> · {contextPercent}% ctx</>
            )}
          </span>
          {!streaming && text && (
            <>
              <button
                onClick={() => {
                  if (ttsPlaying) { ttsAudioRef.current?.pause(); setTtsPlaying(false); return; }
                  setTtsPlaying(true);
                  fetch("/api/claw/voice/tts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: text.slice(0, 2000) }),
                  })
                    .then(r => { if (!r.ok) throw new Error("TTS failed"); return r.blob(); })
                    .then(blob => {
                      const url = URL.createObjectURL(blob);
                      const audio = new Audio(url);
                      ttsAudioRef.current = audio;
                      audio.onended = () => { setTtsPlaying(false); URL.revokeObjectURL(url); };
                      audio.onerror = () => { setTtsPlaying(false); URL.revokeObjectURL(url); };
                      audio.play();
                    })
                    .catch(() => setTtsPlaying(false));
                }}
                type="button"
                title={ttsPlaying ? "停止朗读" : "朗读"}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: ttsPlaying ? "var(--oc-accent)" : "#5f667b", lineHeight: 1 }}
              >
                {ttsPlaying ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                )}
              </button>
              {onDelete && (
                <button
                  onClick={onDelete}
                  type="button"
                  title="删除此消息"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: "var(--oc-text-tertiary)", lineHeight: 1 }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6M14 11v6"/>
                    <path d="M9 6V4h6v2"/>
                  </svg>
                </button>
              )}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export const ChatMessage = memo(ChatMessageInner, (prev, next) => {
  return (
    prev.role === next.role &&
    prev.text === next.text &&
    prev.status === next.status &&
    prev.isLast === next.isLast &&
    prev.isPlaceholder === next.isPlaceholder &&
    prev.streaming === next.streaming &&
    prev.displayName === next.displayName &&
    prev.modelId === next.modelId &&
    prev.timeLabel === next.timeLabel &&
    prev.showToolCalls === next.showToolCalls &&
    toolCallsRenderSignature(prev.toolCalls) === toolCallsRenderSignature(next.toolCalls) &&
    messageEventsRenderSignature(prev.messageEvents) === messageEventsRenderSignature(next.messageEvents) &&
    agentTasksRenderSignature(prev.agentTasks) === agentTasksRenderSignature(next.agentTasks) &&
    JSON.stringify(prev.jiuwenPermission || null) === JSON.stringify(next.jiuwenPermission || null) &&
    prev.usage?.input === next.usage?.input &&
    prev.usage?.output === next.usage?.output &&
    prev.contextPercent === next.contextPercent
  );
});
