import { useMemo, useState, type MouseEvent } from "react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import {
  AgentArtifactThumbnail,
  agentArtifactPreviewKind,
  type AgentArtifactView,
} from "@/components/AgentArtifactPanel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ChatMessageAttachment,
  ToolCallEntry,
} from "@/components/ChatMessage";
import { Download, Eye, Loader2 } from "lucide-react";
import { EA_ARTIFACT_SCHEMA } from "@shared/agent-artifact";

type AttachmentPreviewKind =
  | "html"
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "none";

const TEXT_PREVIEW_EXTENSIONS = new Set([
  "txt",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "log",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "bash",
  "sql",
  "css",
]);

function attachmentExtension(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

function attachmentPreviewKind(
  file: ChatMessageAttachment
): AttachmentPreviewKind {
  const ext = attachmentExtension(file.name);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (ext === "md" || ext === "markdown") {
    return file.size <= 2 * 1024 * 1024 ? "markdown" : "none";
  }
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) {
    return file.size <= 2 * 1024 * 1024 ? "text" : "none";
  }
  return "none";
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function collectMessageAttachments(
  toolCalls: ToolCallEntry[],
  attachments: ChatMessageAttachment[]
): ChatMessageAttachment[] {
  const files = new Map<string, ChatMessageAttachment>();
  for (const file of attachments) {
    if (!file.path || !file.adoptId) continue;
    files.set(`${file.adoptId}:${file.path}`, file);
  }
  for (const tool of toolCalls) {
    for (const file of tool.outputFiles || []) {
      const path = String(file.wsPath || `sandbox-files/${file.name}`).replace(
        /^workspace\//,
        ""
      );
      const adoptId = String(tool.adoptId || "");
      if (!path || !adoptId) continue;
      files.set(`${adoptId}:${path}`, {
        name: file.name,
        size: Number(file.size || 0),
        path,
        adoptId,
      });
    }
  }
  return Array.from(files.values()).slice(0, 20);
}

function RunFileButton({
  adoptId,
  filePath,
  fileName,
}: {
  adoptId: string;
  filePath: string;
  fileName: string;
}) {
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<{
    exitCode: number;
    stdout: string;
    stderr: string;
  } | null>(null);

  const handleRun = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setState("running");
    try {
      const response = await fetch("/api/claw/workspace/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ adoptId, path: filePath }),
      });
      const data = await response.json();
      if (!response.ok) {
        setResult({
          exitCode: 1,
          stdout: "",
          stderr: data.error || `HTTP ${response.status}`,
        });
      } else {
        setResult({
          exitCode: data.exitCode,
          stdout: data.stdout || "",
          stderr: data.stderr || "",
        });
      }
    } catch (error) {
      setResult({ exitCode: 1, stdout: "", stderr: String(error) });
    }
    setState("done");
  };

  const close = () => {
    setState("idle");
    setResult(null);
  };

  return (
    <>
      <button
        onClick={handleRun}
        type="button"
        disabled={state === "running"}
        title="在沙箱中运行"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          padding: "2px 8px",
          borderRadius: "var(--oc-radius-sm)",
          fontSize: "var(--oc-text-xs)",
          fontWeight: "var(--oc-weight-medium)",
          color: state === "running" ? "#9ca3af" : "#34d399",
          background:
            state === "running"
              ? "rgba(156,163,175,0.08)"
              : "rgba(52,211,153,0.10)",
          border: `1px solid ${
            state === "running"
              ? "rgba(156,163,175,0.2)"
              : "rgba(52,211,153,0.25)"
          }`,
          cursor: state === "running" ? "wait" : "pointer",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {state === "running" ? (
          <>
            <span className="animate-pulse">●</span> 运行中
          </>
        ) : (
          <>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="none"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>{" "}
            运行
          </>
        )}
      </button>
      {state === "done" && result ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={close}
        >
          <div
            style={{
              width: "min(640px, 92vw)",
              maxHeight: "80vh",
              background: "var(--oc-panel, #1a1a2e)",
              border: "1px solid var(--oc-border, #333)",
              borderRadius: "var(--oc-radius-lg)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={event => event.stopPropagation()}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--oc-border, #333)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  fontSize: "var(--oc-text-base)",
                  fontWeight: "var(--oc-weight-semibold)",
                  color: "var(--oc-text-primary, #e5e5e5)",
                }}
              >
                运行结果 · {fileName}
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: "var(--oc-text-xs)",
                    padding: "1px 6px",
                    borderRadius: 4,
                    background:
                      result.exitCode === 0
                        ? "rgba(34,197,94,0.15)"
                        : "rgba(239,68,68,0.15)",
                    color: result.exitCode === 0 ? "#4ade80" : "#f87171",
                  }}
                >
                  exit {result.exitCode}
                </span>
              </div>
              <button
                type="button"
                onClick={close}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--oc-text-secondary, #999)",
                  cursor: "pointer",
                  fontSize: 16,
                  padding: "0 4px",
                }}
              >
                ×
              </button>
            </div>
            <div style={{ padding: 16, overflow: "auto", flex: 1 }}>
              {result.stdout ? (
                <div style={{ marginBottom: result.stderr ? 12 : 0 }}>
                  <div
                    style={{
                      fontSize: "var(--oc-text-xs)",
                      color: "var(--oc-text-secondary)",
                      marginBottom: 4,
                    }}
                  >
                    stdout
                  </div>
                  <pre
                    style={{
                      fontSize: "var(--oc-text-sm)",
                      lineHeight: 1.5,
                      color: "var(--oc-text-primary, #e5e5e5)",
                      background: "rgba(0,0,0,0.2)",
                      borderRadius: "var(--oc-radius-md)",
                      padding: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 400,
                      overflow: "auto",
                      margin: 0,
                    }}
                  >
                    {result.stdout}
                  </pre>
                </div>
              ) : null}
              {result.stderr ? (
                <div>
                  <div
                    style={{
                      fontSize: "var(--oc-text-xs)",
                      color: "var(--oc-danger)",
                      marginBottom: 4,
                    }}
                  >
                    stderr
                  </div>
                  <pre
                    style={{
                      fontSize: "var(--oc-text-sm)",
                      lineHeight: 1.5,
                      color: "#fca5a5",
                      background: "rgba(239,68,68,0.06)",
                      borderRadius: "var(--oc-radius-md)",
                      padding: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 200,
                      overflow: "auto",
                      margin: 0,
                    }}
                  >
                    {result.stderr}
                  </pre>
                </div>
              ) : null}
              {!result.stdout && !result.stderr ? (
                <div
                  style={{
                    fontSize: "var(--oc-text-base)",
                    color: "var(--oc-text-secondary)",
                    textAlign: "center",
                    padding: 24,
                  }}
                >
                  (无输出)
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function MessageAttachments({
  toolCalls = [],
  attachments = [],
  variant = "assistant",
  onOpenArtifacts,
}: {
  toolCalls?: ToolCallEntry[];
  attachments?: ChatMessageAttachment[];
  variant?: "user" | "assistant";
  onOpenArtifacts?: (
    artifacts: AgentArtifactView[],
    artifactId?: string
  ) => void;
}) {
  const files = useMemo(
    () => collectMessageAttachments(toolCalls, attachments),
    [attachments, toolCalls]
  );
  const [downloading, setDownloading] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [preview, setPreview] = useState<{
    file: ChatMessageAttachment;
    kind: AttachmentPreviewKind;
    loading: boolean;
    url?: string;
    content?: string;
    error?: string;
  } | null>(null);
  const artifacts = useMemo<AgentArtifactView[]>(
    () =>
      files.map((file, index) => ({
        schema: EA_ARTIFACT_SCHEMA,
        id: `message-artifact-${index + 1}`,
        name: file.name,
        mimeType: "application/octet-stream",
        size: file.size,
        role: index === 0 ? "primary" : "supporting",
        path: file.path,
        adoptId: file.adoptId,
      })),
    [files]
  );
  const imagePreview =
    variant === "assistant"
      ? artifacts.find(
          artifact => agentArtifactPreviewKind(artifact) === "image"
        )
      : undefined;

  if (!files.length) return null;

  const requestDownloadUrl = async (file: ChatMessageAttachment) => {
    const response = await fetch("/api/claw/files/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ adoptId: file.adoptId, path: file.path }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.url) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return String(payload.url);
  };

  const downloadFile = async (file: ChatMessageAttachment) => {
    const key = `${file.adoptId}:${file.path}`;
    setDownloading(key);
    setDownloadError("");
    try {
      const url = await requestDownloadUrl(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error: any) {
      setDownloadError(String(error?.message || "下载失败"));
    } finally {
      setDownloading("");
    }
  };

  const previewFile = async (file: ChatMessageAttachment) => {
    const kind = attachmentPreviewKind(file);
    if (kind === "none") return;
    setPreview({ file, kind, loading: true });
    try {
      if (kind === "text" || kind === "markdown") {
        const params = new URLSearchParams({
          adoptId: file.adoptId,
          path: file.path,
        });
        const response = await fetch(
          `/api/claw/files/read?${params.toString()}`,
          { credentials: "include" }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        let content = String(payload?.content || "");
        if (attachmentExtension(file.name) === "json") {
          try {
            content = JSON.stringify(JSON.parse(content), null, 2);
          } catch {}
        }
        setPreview({ file, kind, loading: false, content });
      } else {
        const url = await requestDownloadUrl(file);
        setPreview({ file, kind, loading: false, url: `${url}&preview=1` });
      }
    } catch (error: any) {
      setPreview({
        file,
        kind,
        loading: false,
        error: String(error?.message || "预览失败"),
      });
    }
  };

  const openFile = (file: ChatMessageAttachment) => {
    const artifact = artifacts.find(
      item => item.path === file.path && item.adoptId === file.adoptId
    );
    if (artifact && onOpenArtifacts) {
      onOpenArtifacts(artifacts, artifact.id);
      return;
    }
    void previewFile(file);
  };

  return (
    <>
      <div
        className={`lingxia-message-attachments is-${variant}`}
        aria-label={variant === "user" ? "上传的附件" : "生成的附件"}
      >
        <div className="lingxia-message-attachments__label">
          {variant === "assistant" ? "本轮产物" : "附件"} · {files.length}
        </div>
        {imagePreview && onOpenArtifacts ? (
          <AgentArtifactThumbnail
            artifact={imagePreview}
            onOpen={() => onOpenArtifacts(artifacts, imagePreview.id)}
          />
        ) : null}
        <div className="lingxia-message-attachments__list">
          {files.map(file => {
            const key = `${file.adoptId}:${file.path}`;
            const kind = attachmentPreviewKind(file);
            const runnable = ["py", "js", "sh", "bash"].includes(
              attachmentExtension(file.name)
            );
            return (
              <div className="lingxia-message-attachment" key={key}>
                <button
                  type="button"
                  className="lingxia-message-attachment__main"
                  onClick={() =>
                    (kind !== "none" || onOpenArtifacts) && openFile(file)
                  }
                  disabled={kind === "none" && !onOpenArtifacts}
                  title={kind === "none" ? "打开文件信息" : `预览 ${file.name}`}
                >
                  <span className="lingxia-message-attachment__icon">
                    <FileTypeIcon name={file.name} />
                  </span>
                  <span className="lingxia-message-attachment__info">
                    <span className="lingxia-message-attachment__name">
                      {file.name}
                    </span>
                    <span className="lingxia-message-attachment__meta">
                      {formatAttachmentSize(file.size)}
                    </span>
                  </span>
                </button>
                <div className="lingxia-message-attachment__actions">
                  {kind !== "none" ? (
                    <button
                      type="button"
                      className="lingxia-message-attachment__action"
                      onClick={() => openFile(file)}
                      title="预览"
                    >
                      <Eye size={15} strokeWidth={1.9} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="lingxia-message-attachment__action"
                    onClick={() => void downloadFile(file)}
                    disabled={downloading === key}
                    title="下载"
                  >
                    {downloading === key ? (
                      <Loader2 className="animate-spin" size={15} />
                    ) : (
                      <Download size={15} strokeWidth={1.9} />
                    )}
                  </button>
                  {variant === "assistant" && runnable ? (
                    <RunFileButton
                      adoptId={file.adoptId}
                      filePath={file.path}
                      fileName={file.name}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {downloadError ? (
          <div className="lingxia-message-attachments__error">
            {downloadError}
          </div>
        ) : null}
      </div>

      <Dialog
        open={Boolean(preview)}
        onOpenChange={open => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="lingxia-attachment-preview" showCloseButton>
          {preview ? (
            <>
              <DialogHeader className="lingxia-attachment-preview__header">
                <DialogTitle className="lingxia-attachment-preview__title">
                  {preview.file.name}
                </DialogTitle>
                <span className="lingxia-attachment-preview__meta">
                  {formatAttachmentSize(preview.file.size)}
                </span>
              </DialogHeader>
              <div className="lingxia-attachment-preview__body">
                {preview.loading ? (
                  <div className="lingxia-attachment-preview__state">
                    <Loader2 className="animate-spin" size={20} />
                    正在加载预览...
                  </div>
                ) : preview.error ? (
                  <div className="lingxia-attachment-preview__state is-error">
                    {preview.error}
                  </div>
                ) : preview.kind === "image" && preview.url ? (
                  <img
                    className="lingxia-attachment-preview__image"
                    src={preview.url}
                    alt={preview.file.name}
                  />
                ) : (preview.kind === "html" || preview.kind === "pdf") &&
                  preview.url ? (
                  <iframe
                    className="lingxia-attachment-preview__frame"
                    src={preview.url}
                    title={preview.file.name}
                    sandbox={preview.kind === "html" ? "" : undefined}
                  />
                ) : preview.kind === "markdown" ? (
                  <div className="lingxia-attachment-preview__markdown">
                    <ChatMarkdown
                      content={preview.content || "(空文件)"}
                      phase="final"
                    />
                  </div>
                ) : (
                  <pre className="lingxia-attachment-preview__text">
                    {preview.content || "(空文件)"}
                  </pre>
                )}
              </div>
              <div className="lingxia-attachment-preview__footer">
                <button
                  type="button"
                  className="lingxia-attachment-preview__download"
                  onClick={() => void downloadFile(preview.file)}
                >
                  <Download size={14} strokeWidth={1.9} /> 下载
                </button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
