import { useEffect, useMemo, useState } from "react";
import {
  Download,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Music2,
  Presentation,
  Video,
  X,
} from "lucide-react";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import type { AgentTaskArtifact } from "@shared/agent-artifact";

export type AgentArtifactView = AgentTaskArtifact & { adoptId: string };

type PreviewKind = "image" | "pdf" | "markdown" | "text" | "html" | "audio" | "video" | "none";

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}
export function agentArtifactPreviewKind(artifact: Pick<AgentTaskArtifact, "name" | "mimeType">): PreviewKind {
  const mime = String(artifact.mimeType || "").toLowerCase();
  const ext = extension(artifact.name);
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime === "text/markdown" || ext === "md") return "markdown";
  if (mime === "text/html" || ["html", "htm"].includes(ext)) return "html";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  if (mime.startsWith("video/") || ["mp4", "webm"].includes(ext)) return "video";
  if (mime.startsWith("text/") || ["txt", "csv", "json", "yaml", "yml", "xml", "log"].includes(ext)) return "text";
  return "none";
}

function artifactIcon(artifact: Pick<AgentTaskArtifact, "name" | "mimeType">) {
  const kind = agentArtifactPreviewKind(artifact);
  const ext = extension(artifact.name);
  if (kind === "image") return FileImage;
  if (kind === "audio") return Music2;
  if (kind === "video") return Video;
  if (["ppt", "pptx"].includes(ext)) return Presentation;
  if (["xls", "xlsx", "csv"].includes(ext)) return FileSpreadsheet;
  if (["zip", "tar", "gz"].includes(ext)) return FileArchive;
  if (["html", "htm", "json", "xml", "yaml", "yml"].includes(ext)) return FileCode2;
  return FileText;
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function requestArtifactUrl(artifact: AgentArtifactView): Promise<string> {
  const response = await fetch("/api/claw/files/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ adoptId: artifact.adoptId, path: artifact.path }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.url) throw new Error(payload?.error || `HTTP ${response.status}`);
  return String(payload.url);
}

function previewUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}preview=1`;
}

export function AgentArtifactThumbnail({
  artifact,
  onOpen,
}: {
  artifact: AgentArtifactView;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let active = true;
    if (agentArtifactPreviewKind(artifact) !== "image") return undefined;
    void requestArtifactUrl(artifact)
      .then((value) => { if (active) setUrl(previewUrl(value)); })
      .catch(() => { if (active) setUrl(""); });
    return () => { active = false; };
  }, [artifact]);

  if (!url) return null;
  return (
    <button type="button" className="agent-artifact-thumbnail" onClick={onOpen} title={`预览 ${artifact.name}`}>
      <img src={url} alt={artifact.name} />
      <span>查看产物</span>
    </button>
  );
}

export function AgentArtifactPanel({
  artifacts,
  initialArtifactId,
  onClose,
}: {
  artifacts: AgentArtifactView[];
  initialArtifactId?: string;
  onClose: () => void;
}) {
  const ordered = useMemo(() => artifacts.slice().sort((left, right) => {
    const rank = (artifact: AgentArtifactView) => artifact.role === "preview" ? 0 : artifact.role === "primary" ? 1 : 2;
    return rank(left) - rank(right) || left.name.localeCompare(right.name, "zh-CN");
  }), [artifacts]);
  const [selectedId, setSelectedId] = useState(initialArtifactId || ordered[0]?.id || "");
  const selected = ordered.find((artifact) => artifact.id === selectedId) || ordered[0];
  const [preview, setPreview] = useState<{ loading: boolean; url?: string; content?: string; error?: string }>({ loading: true });
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (initialArtifactId && ordered.some((artifact) => artifact.id === initialArtifactId)) setSelectedId(initialArtifactId);
  }, [initialArtifactId, ordered]);

  useEffect(() => {
    let active = true;
    if (!selected) {
      setPreview({ loading: false, error: "没有可预览的产物" });
      return undefined;
    }
    const kind = agentArtifactPreviewKind(selected);
    setPreview({ loading: true });
    const load = async () => {
      if (kind === "markdown" || kind === "text") {
        const params = new URLSearchParams({ adoptId: selected.adoptId, path: selected.path });
        const response = await fetch(`/api/claw/files/read?${params.toString()}`, { credentials: "include" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        let content = String(payload?.content || "");
        if (extension(selected.name) === "json") {
          try { content = JSON.stringify(JSON.parse(content), null, 2); } catch {}
        }
        return { loading: false, content };
      }
      if (kind === "none") return { loading: false };
      const url = await requestArtifactUrl(selected);
      return { loading: false, url: previewUrl(url) };
    };
    void load()
      .then((value) => { if (active) setPreview(value); })
      .catch((error) => { if (active) setPreview({ loading: false, error: error instanceof Error ? error.message : "预览失败" }); });
    return () => { active = false; };
  }, [selected]);

  const download = async () => {
    if (!selected || downloading) return;
    setDownloading(true);
    try {
      const url = await requestArtifactUrl(selected);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selected.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      setDownloading(false);
    }
  };

  const kind = selected ? agentArtifactPreviewKind(selected) : "none";
  return (
    <div className="agent-artifact-panel">
      <header className="agent-artifact-panel__header">
        <div>
          <strong>任务产物</strong>
          <span>{ordered.length} 个文件</span>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭产物预览" title="关闭">
          <X size={16} />
        </button>
      </header>

      <div className="agent-artifact-panel__tabs" role="tablist" aria-label="任务产物">
        {ordered.map((artifact) => {
          const Icon = artifactIcon(artifact);
          return (
            <button
              type="button"
              key={`${artifact.id}:${artifact.path}`}
              className={artifact.id === selected?.id ? "is-active" : ""}
              onClick={() => setSelectedId(artifact.id)}
              role="tab"
              aria-selected={artifact.id === selected?.id}
              title={artifact.name}
            >
              <Icon size={15} />
              <span>{artifact.name}</span>
            </button>
          );
        })}
      </div>

      <div className="agent-artifact-panel__viewer">
        {preview.loading ? (
          <div className="agent-artifact-panel__state"><Loader2 className="animate-spin" size={20} /> 正在加载预览...</div>
        ) : preview.error ? (
          <div className="agent-artifact-panel__state is-error">{preview.error}</div>
        ) : kind === "image" && preview.url ? (
          <img src={preview.url} alt={selected?.name || "任务产物"} />
        ) : kind === "pdf" && preview.url ? (
          <iframe src={preview.url} title={selected?.name || "PDF 预览"} />
        ) : kind === "html" && preview.url ? (
          <iframe src={preview.url} title={selected?.name || "HTML 预览"} sandbox="" />
        ) : kind === "audio" && preview.url ? (
          <audio src={preview.url} controls />
        ) : kind === "video" && preview.url ? (
          <video src={preview.url} controls />
        ) : kind === "markdown" ? (
          <div className="agent-artifact-panel__markdown"><ChatMarkdown content={preview.content || "(空文件)"} phase="final" /></div>
        ) : kind === "text" ? (
          <pre>{preview.content || "(空文件)"}</pre>
        ) : (
          <div className="agent-artifact-panel__state">该格式暂不支持在线预览，请下载后查看。</div>
        )}
      </div>

      {selected ? (
        <footer className="agent-artifact-panel__footer">
          <span>{selected.name}{formatSize(selected.size) ? ` · ${formatSize(selected.size)}` : ""}</span>
          <button type="button" onClick={() => void download()} disabled={downloading}>
            {downloading ? <Loader2 className="animate-spin" size={15} /> : <Download size={15} />}
            下载
          </button>
        </footer>
      ) : null}
    </div>
  );
}
