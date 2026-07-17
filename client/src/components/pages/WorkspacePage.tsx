/**
 * WorkspacePage — agent workspace file browser (per-adoptId).
 *
 * Reads from /api/claw/files/list, supports inline preview + download.
 * Renders runtime-aware via /api/claw/files/capabilities (rule 5).
 *
 * MVP scope: list / preview / download. Upload + delete coming next.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { PageContainer } from "@/components/console/PageContainer";
import { Archive, Folder, FileCode2, FileImage, FileText, Download, Eye, ChevronRight, Loader2, Search, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type FileNode = { name: string; path: string; type: "file" | "directory"; size?: number; modifiedAt?: string };
export type WorkspaceTreeRow = FileNode & { depth: number };
type Capabilities = { supportsList: boolean; supportsRead: boolean; supportsDownload: boolean; supportsUpload: boolean; supportsDelete: boolean; maxUploadBytes: number };
type ListResp = { runtime: string; capabilities: Capabilities; files: FileNode[] };
const PROTECTED_ROOT_FILES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "MEMORY.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "USER.md",
]);

// Parse response safely: 当上游反代（nginx 413/502 等）返回 HTML 错误页时，
// 避免 r.json() 抛 "Unexpected token '<'"，改为提取可读信息。
async function readResponse(r: Response): Promise<{ data: any; errorText: string | null }> {
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return { data: await r.json(), errorText: null };
    } catch {
      return { data: null, errorText: `响应解析失败 (${r.status})` };
    }
  }
  const text = (await r.text().catch(() => "")).trim();
  const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
  const preview = titleMatch ? titleMatch[1] : (text.slice(0, 80) || r.statusText || "unknown");
  return { data: null, errorText: `${r.status} ${preview}` };
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`;
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

export type WorkspacePreviewKind = "text" | "pdf" | "image" | "html" | "none";

export function workspacePreviewKind(name: string): WorkspacePreviewKind {
  const lower = name.toLowerCase();
  if (/\.(md|txt|json|yaml|yml|csv|log|py|js|ts|tsx|jsx|css|sql|sh|xml|toml|ini|conf)$/.test(lower)) return "text";
  if (/\.pdf$/.test(lower)) return "pdf";
  if (/\.(png|jpe?g|gif|webp)$/.test(lower)) return "image";
  if (/\.html?$/.test(lower)) return "html";
  return "none";
}

function isPreviewable(name: string): boolean {
  return workspacePreviewKind(name) !== "none";
}

function isProtectedRootFile(file: FileNode): boolean {
  return file.type === "file" && !file.path.includes("/") && PROTECTED_ROOT_FILES.has(file.path);
}

function isManagedSkillsPath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized === "skills" || normalized.startsWith("skills/");
}

function fileSourceHint(file: FileNode): string {
  const path = file.path.toLowerCase();
  if (file.type === "directory") {
    if (path === "skills" || path.startsWith("skills/")) return "技能目录";
    if (path === "prompt_attachment" || path.startsWith("prompt_attachment/")) return "附件目录";
    if (path === "memory" || path.startsWith("memory/")) return "记忆目录";
    if (path.includes("output") || path.includes("sandbox")) return "产物目录";
    return "文件夹";
  }
  if (isProtectedRootFile(file) || file.name.startsWith(".")) return "系统文件";
  if (path.includes("prompt_attachment") || path.includes("upload")) return "上传附件";
  if (path.includes("output") || path.includes("sandbox") || path.includes("artifact")) return "任务产物";
  if (path.startsWith("skills/")) return "技能文件";
  return "工作文件";
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? "" : normalized.slice(0, separator);
}

export function buildWorkspaceTreeRows(
  files: FileNode[],
  expandedPaths: ReadonlySet<string>,
  filter: string,
): WorkspaceTreeRow[] {
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
  const children = new Map<string, FileNode[]>();
  for (const file of sortedFiles) {
    const parent = parentPath(file.path);
    children.set(parent, [...(children.get(parent) || []), file]);
  }

  const query = filter.trim().toLocaleLowerCase("zh-CN");
  let visiblePaths: Set<string> | null = null;
  if (query) {
    visiblePaths = new Set<string>();
    for (const file of sortedFiles) {
      const matches = file.name.toLocaleLowerCase("zh-CN").includes(query)
        || file.path.toLocaleLowerCase("zh-CN").includes(query);
      if (!matches) continue;

      visiblePaths.add(file.path);
      let ancestor = parentPath(file.path);
      while (ancestor) {
        visiblePaths.add(ancestor);
        ancestor = parentPath(ancestor);
      }
      if (file.type === "directory") {
        const prefix = `${file.path}/`;
        for (const descendant of sortedFiles) {
          if (descendant.path.startsWith(prefix)) visiblePaths.add(descendant.path);
        }
      }
    }
  }

  const rows: WorkspaceTreeRow[] = [];
  const walk = (path: string, depth: number) => {
    for (const file of children.get(path) || []) {
      if (visiblePaths && !visiblePaths.has(file.path)) continue;
      rows.push({ ...file, depth });
      if (file.type === "directory" && (query || expandedPaths.has(file.path))) {
        walk(file.path, depth + 1);
      }
    }
  };
  walk("", 0);
  return rows;
}

export type WorkspaceFileIconKind = "directory" | "markdown" | "json" | "pdf" | "image" | "code" | "archive" | "file";

export function workspaceFileIconKind(file: FileNode): WorkspaceFileIconKind {
  if (file.type === "directory") return "directory";
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "json") return "json";
  if (extension === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension || "")) return "image";
  if (["py", "js", "jsx", "ts", "tsx", "css", "scss", "html", "htm", "sh", "bash", "sql", "xml", "yaml", "yml", "toml", "ini", "conf"].includes(extension || "")) return "code";
  if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(extension || "")) return "archive";
  return "file";
}

function WorkspaceFileTypeIcon({ file }: { file: FileNode }) {
  const kind = workspaceFileIconKind(file);
  if (kind === "directory") return <Folder className="workspace-tree-folder-icon" />;
  if (kind === "markdown") return <span className="workspace-tree-type workspace-tree-type--md">M↓</span>;
  if (kind === "json") return <span className="workspace-tree-type workspace-tree-type--json">{"{ }"}</span>;
  if (kind === "pdf") return <span className="workspace-tree-type workspace-tree-type--pdf">PDF</span>;
  if (kind === "image") return <FileImage className="workspace-tree-file-icon workspace-tree-file-icon--image" />;
  if (kind === "code") return <FileCode2 className="workspace-tree-file-icon workspace-tree-file-icon--code" />;
  if (kind === "archive") return <Archive className="workspace-tree-file-icon" />;
  return <FileText className="workspace-tree-file-icon" />;
}

export function WorkspaceBrowser({
  adoptId,
  variant = "page",
  active = true,
}: {
  adoptId: string;
  variant?: "page" | "panel";
  active?: boolean;
}) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState<{
    name: string;
    path: string;
    kind: Exclude<WorkspacePreviewKind, "none">;
    content?: string;
    url?: string;
    modifiedAt?: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>("");  // workspace-relative current dir, "" = root
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const inManagedSkillsDir = isManagedSkillsPath(currentPath);
  const compact = variant === "panel";
  const loadSequenceRef = useRef(0);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!adoptId) return;
    const sequence = ++loadSequenceRef.current;
    if (!silent) setLoading(true);
    setError("");
    try {
      // 2026-04-20 review fix: 带 currentPath 给后端, 避免深层目录被 MAX_LIST_DEPTH=4 裁剪
      const params = new URLSearchParams({ adoptId });
      if (!compact && currentPath) params.set("path", currentPath);
      const r = await fetch("/api/claw/files/list?" + params.toString(), { credentials: "include" });
      if (!r.ok) throw new Error("list " + r.status);
      const d: ListResp = await r.json();
      if (sequence !== loadSequenceRef.current) return;
      setFiles(d.files || []);
      setCaps(d.capabilities);
    } catch (e: any) {
      if (sequence !== loadSequenceRef.current) return;
      setError(e?.message || "加载失败");
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [adoptId, compact, currentPath]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load({ silent: true });
    };
    const interval = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, load]);

  useEffect(() => {
    setFileFilter("");
    setExpandedPaths(new Set());
  }, [adoptId]);

  const previewFile = async (file: FileNode) => {
    const kind = workspacePreviewKind(file.name);
    if (kind === "none") return;
    setPreviewLoading(true);
    try {
      if (kind === "text") {
        const r = await fetch(`/api/claw/files/read?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(file.path)}`, { credentials: "include" });
        if (!r.ok) throw new Error(`read ${r.status}`);
        const d: any = await r.json();
        setPreviewing({ name: file.name, path: file.path, kind, content: d.content || "", modifiedAt: d.modifiedAt });
      } else {
        const params = new URLSearchParams({ adoptId, path: file.path, preview: "1" });
        setPreviewing({
          name: file.name,
          path: file.path,
          kind,
          url: `/api/claw/workspace/files/download?${params.toString()}`,
          modifiedAt: file.modifiedAt,
        });
      }
    } catch (e: any) {
      setError(e?.message || "预览失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  const downloadUrl = (file: FileNode) => `/api/claw/files/download?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(file.path)}`;

  const requestDeleteFile = (file: FileNode) => {
    if (!caps?.supportsDelete) return;
    if (isProtectedRootFile(file)) return;
    setDeleteTarget(file);
  };

  const deleteFile = async (file: FileNode) => {
    if (!caps?.supportsDelete) return;
    if (isProtectedRootFile(file)) return;
    try {
      const r = await fetch("/api/claw/files/delete", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId, path: file.path }),
      });
      const { data: d, errorText } = await readResponse(r);
      if (!r.ok) {
        setError(d?.error || errorText || `delete ${r.status}`);
        return;
      }
      await load();
      setDeleteTarget(null);
    } catch (e: any) {
      setError(e?.message || "delete failed");
    }
  };

  // 当前目录下的直接子项（不含孙子辈）+ dir 在前 + 文件按修改时间倒序
  const sorted = useMemo(() => {
    const prefix = currentPath ? currentPath + "/" : "";
    const filtered = files.filter((f) => {
      if (currentPath === "" ) return !f.path.includes("/");                       // root: 不含斜杠
      if (!f.path.startsWith(prefix)) return false;                                  // 必须在 currentPath 下
      return !f.path.slice(prefix.length).includes("/");                            // 不是孙子辈
    });
    return filtered.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      const ta = a.modifiedAt || "";
      const tb = b.modifiedAt || "";
      return tb.localeCompare(ta);
    });
  }, [files, currentPath]);

  const treeRows = useMemo(
    () => buildWorkspaceTreeRows(files, expandedPaths, fileFilter),
    [files, expandedPaths, fileFilter],
  );

  const toggleFolder = (path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // 面包屑路径段
  const crumbs = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split("/");
    return parts.map((seg, i) => ({ name: seg, path: parts.slice(0, i + 1).join("/") }));
  }, [currentPath]);

  const crumbBar = (
    <div className="workspace-crumb-bar">
      {currentPath ? (
        <button
          type="button"
          onClick={() => setCurrentPath("")}
          className="lingxia-soft-link lingxia-soft-link--accent"
        >
          根目录
        </button>
      ) : (
        <span className="workspace-crumb-current">根目录</span>
      )}
      {crumbs.map((c) => (
        <span key={c.path} className="inline-flex items-center gap-1">
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
          {c.path === currentPath ? (
            <span className="workspace-crumb-current">{c.name}</span>
          ) : (
            <button
              type="button"
              onClick={() => setCurrentPath(c.path)}
              className="lingxia-soft-link"
            >
              {c.name}
            </button>
          )}
        </span>
      ))}
    </div>
  );

  const drawerContent = (
    <div className="workspace-tree-layout">
      <label className="workspace-tree-filter">
        <Search aria-hidden="true" />
        <input
          value={fileFilter}
          onChange={(event) => setFileFilter(event.target.value)}
          placeholder="筛选文件…"
          aria-label="筛选工作空间文件"
        />
      </label>

      {error && <div className="workspace-tree-notice workspace-tree-notice--error">{error}</div>}

      <div className="workspace-tree-card" role="tree" aria-label="工作空间文件">
        {loading && files.length === 0 ? (
          <div className="workspace-tree-empty"><Loader2 className="animate-spin" />正在加载文件…</div>
        ) : treeRows.length === 0 ? (
          <div className="workspace-tree-empty">
            {fileFilter.trim() ? "没有匹配的文件" : "工作空间暂无文件"}
          </div>
        ) : (
          treeRows.map((file) => {
            const expanded = file.type === "directory" && (fileFilter.trim() !== "" || expandedPaths.has(file.path));
            return (
              <div
                key={file.path}
                className="workspace-tree-row"
                style={{ "--workspace-tree-depth": file.depth } as CSSProperties}
                role="treeitem"
                aria-expanded={file.type === "directory" ? expanded : undefined}
              >
                <button
                  type="button"
                  className="workspace-tree-row-main"
                  onClick={() => {
                    if (file.type === "directory") toggleFolder(file.path);
                    else if (isPreviewable(file.name) && caps?.supportsRead) void previewFile(file);
                  }}
                  title={file.path}
                >
                  <span className={`workspace-tree-chevron ${expanded ? "is-expanded" : ""}`} aria-hidden="true">
                    {file.type === "directory" && <ChevronRight />}
                  </span>
                  <WorkspaceFileTypeIcon file={file} />
                  <span className="workspace-tree-name">{file.name}</span>
                </button>
                <div className="workspace-tree-actions">
                  {file.type === "file" && isPreviewable(file.name) && caps?.supportsRead && (
                    <button type="button" onClick={() => void previewFile(file)} title="预览" aria-label={`预览 ${file.name}`}>
                      <Eye />
                    </button>
                  )}
                  {file.type === "file" && caps?.supportsDownload && (
                    <a href={downloadUrl(file)} download={file.name} title="下载" aria-label={`下载 ${file.name}`}>
                      <Download />
                    </a>
                  )}
                  {caps?.supportsDelete && !isProtectedRootFile(file) && !isManagedSkillsPath(file.path) && (
                    <button type="button" onClick={() => requestDeleteFile(file)} title="删除" aria-label={`删除 ${file.name}`}>
                      <Trash2 />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const pageContent = (
    <div className="ea-data-page workspace-data-page">
      {inManagedSkillsDir && (
        <div className="mb-3 px-3 py-2 text-xs rounded-md" style={{ background: "#f8fafc", color: "#475569", border: "1px solid #e2e8f0" }}>
          技能目录由平台管理。请在“我的技能”页面上传、卸载或删除技能。
        </div>
      )}
      {error && (
        <div className="mb-3 px-3 py-2 text-xs rounded-md" style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca" }}>
          {error}
        </div>
      )}
      {sorted.length === 0 && !loading && (
        <div className="ea-data-card workspace-file-list">
          {crumbBar}
          <div className="ea-data-empty">
            <Folder className="w-12 h-12 mx-auto mb-2 opacity-30" />
            <div>工作空间还是空的</div>
            <div className="ea-data-muted">让 Agent 帮你生成文件，任务产物会自动出现在这里</div>
          </div>
        </div>
      )}
      {sorted.length > 0 && (
        <div
          className="ea-data-card workspace-file-list"
          style={{ "--ea-data-columns": "minmax(240px, 1fr) 140px 120px minmax(200px, 0.5fr)" } as CSSProperties}
        >
          {crumbBar}
          <div className="ea-data-header">
            <span>名称</span>
            <span>修改时间</span>
            <span>来源</span>
            <span className="text-right">操作</span>
          </div>
          {sorted.map((f) => (
            <div
              key={f.path}
              className={`ea-data-row ea-data-row--clickable workspace-file-row ${f.type === "directory" ? "workspace-file-row--directory" : ""}`}
              onClick={() => f.type === "directory" && setCurrentPath(f.path)}
            >
              <div className="ea-data-title">
                {f.type === "directory" ? <Folder className="w-[18px] h-[18px] workspace-folder-icon" /> : <FileText className="w-[18px] h-[18px] text-gray-500" />}
                <span className="workspace-file-name">{f.name}</span>
              </div>
              <div className="ea-data-cell ea-data-muted">{formatTime(f.modifiedAt)}</div>
              <div className="ea-data-cell ea-data-muted">
                <span className="workspace-source-pill">{fileSourceHint(f)}</span>
              </div>
              <div className="ea-data-actions">
                {f.type === "file" && isPreviewable(f.name) && caps?.supportsRead && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); previewFile(f); }} className="ea-data-icon-btn" title="预览" aria-label={`预览 ${f.name}`}>
                    <Eye className="w-3 h-3" /> 预览
                  </button>
                )}
                {f.type === "file" && caps?.supportsDownload && (
                  <a href={downloadUrl(f)} download={f.name} onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="ea-data-icon-btn" title="下载" aria-label={`下载 ${f.name}`}>
                      <Download className="w-3 h-3" /> 下载
                    </button>
                  </a>
                )}
                {caps?.supportsDelete && !isProtectedRootFile(f) && !isManagedSkillsPath(f.path) && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); requestDeleteFile(f); }} className="ea-data-icon-btn ea-data-icon-btn--danger" title="删除" aria-label={`删除 ${f.name}`}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const body = (
    <>
      {compact ? drawerContent : pageContent}

      {/* Preview modal */}
      {previewing && (
        <div className="workspace-preview-overlay" onClick={() => setPreviewing(null)}>
          <div className="workspace-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览 ${previewing.name}`} onClick={(e) => e.stopPropagation()}>
            <div className="workspace-preview-header">
              <div className="workspace-preview-title">
                <FileText />
                <span title={previewing.path}>{previewing.path}</span>
                {previewing.modifiedAt && <small>· {formatTime(previewing.modifiedAt)}</small>}
              </div>
              <div className="workspace-preview-actions">
                <a
                  className="workspace-preview-action"
                  href={downloadUrl({ name: previewing.name, path: previewing.path, type: "file" })}
                  download={previewing.name}
                >
                  <Download />
                  下载
                </a>
                <button type="button" className="workspace-preview-action" onClick={() => setPreviewing(null)}>
                  关闭
                </button>
              </div>
            </div>
            <div className="workspace-preview-body">
              {previewing.kind === "image" && previewing.url ? (
                <img className="workspace-preview-image" src={previewing.url} alt={previewing.name} />
              ) : (previewing.kind === "pdf" || previewing.kind === "html") && previewing.url ? (
                <iframe
                  className="workspace-preview-frame"
                  src={previewing.url}
                  title={previewing.name}
                  sandbox={previewing.kind === "html" ? "" : undefined}
                />
              ) : (
                <pre className="workspace-preview-text">{previewing.content || "(空文件)"}</pre>
              )}
            </div>
          </div>
        </div>
      )}

      {previewLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Loader2 className="w-8 h-8 animate-spin text-white" />
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent
          className="max-w-[420px]"
          style={{
            background: "var(--oc-bg-surface)",
            borderColor: "var(--oc-border)",
            color: "var(--oc-text-primary)",
            boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              {deleteTarget?.type === "directory" ? "删除文件夹？" : "删除文件？"}
            </AlertDialogTitle>
            <AlertDialogDescription style={{ color: "var(--oc-text-secondary)" }}>
              {deleteTarget?.type === "directory"
                ? "该文件夹及其中所有内容都会被删除，此操作不可撤销。"
                : "该文件会被删除，此操作不可撤销。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget && (
            <div
              className="rounded-md px-3 py-2 text-xs font-mono break-all"
              style={{
                background: "color-mix(in oklab, var(--oc-bg) 82%, transparent)",
                border: "1px solid var(--oc-border)",
                color: "var(--oc-text-secondary)",
              }}
            >
              {deleteTarget.path}{deleteTarget.type === "directory" ? "/" : ""}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="lingxia-soft-action">取消</AlertDialogCancel>
            <AlertDialogAction
              className="lingxia-soft-action lingxia-soft-action--danger"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) void deleteFile(deleteTarget);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  if (compact) return <div className="workspace-panel-browser">{body}</div>;
  return <PageContainer title="工作空间">{body}</PageContainer>;
}

export function WorkspacePage({ adoptId }: { adoptId: string }) {
  return <WorkspaceBrowser adoptId={adoptId} />;
}
