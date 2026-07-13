/**
 * WorkspacePage — agent workspace file browser (per-adoptId).
 *
 * Reads from /api/claw/files/list, supports inline preview + download.
 * Renders runtime-aware via /api/claw/files/capabilities (rule 5).
 *
 * MVP scope: list / preview / download. Upload + delete coming next.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { PageContainer } from "@/components/console/PageContainer";
import { Folder, FileText, Download, Eye, RefreshCw, ChevronRight, Loader2, Upload, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

type FileNode = { name: string; path: string; type: "file" | "directory"; size?: number; modifiedAt?: string };
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

function isPreviewable(name: string): boolean {
  const lower = name.toLowerCase();
  return /\.(md|txt|json|yaml|yml|csv|log|py|js|ts|tsx|jsx|html|css|sql|sh|xml|toml|ini|conf)$/.test(lower);
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

export function WorkspacePage({ adoptId }: { adoptId: string }) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [runtime, setRuntime] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState<{ name: string; path: string; content: string; modifiedAt?: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [currentPath, setCurrentPath] = useState<string>("");  // workspace-relative current dir, "" = root
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const inManagedSkillsDir = isManagedSkillsPath(currentPath);

  const load = async () => {
    if (!adoptId) return;
    setLoading(true);
    setError("");
    try {
      // 2026-04-20 review fix: 带 currentPath 给后端, 避免深层目录被 MAX_LIST_DEPTH=4 裁剪
      const params = new URLSearchParams({ adoptId });
      if (currentPath) params.set("path", currentPath);
      const r = await fetch("/api/claw/files/list?" + params.toString(), { credentials: "include" });
      if (!r.ok) throw new Error("list " + r.status);
      const d: ListResp = await r.json();
      setFiles(d.files || []);
      setCaps(d.capabilities);
      setRuntime(d.runtime);
    } catch (e: any) {
      setError(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [adoptId, currentPath]);

  const previewFile = async (file: FileNode) => {
    if (!isPreviewable(file.name)) return;
    setPreviewLoading(true);
    try {
      const r = await fetch(`/api/claw/files/read?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(file.path)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`read ${r.status}`);
      const d: any = await r.json();
      setPreviewing({ name: file.name, path: file.path, content: d.content || "", modifiedAt: d.modifiedAt });
    } catch (e: any) {
      setError(e?.message || "预览失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  const downloadUrl = (file: FileNode) => `/api/claw/files/download?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(file.path)}`;

  const uploadFile = async (file: File) => {
    if (!caps?.supportsUpload) return;
    if (file.size > caps.maxUploadBytes) {
      setUploadError(`文件超大 (${(file.size / 1024 / 1024).toFixed(1)}MB > ${caps.maxUploadBytes / 1024 / 1024}MB)`);
      return;
    }
    setUploading(true);
    setUploadError("");
    try {
      const buf = await file.arrayBuffer();
      // Base64 encode (chunked for large files)
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const r = await fetch("/api/claw/files/upload", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adoptId,
          path: currentPath || undefined,
          filename: file.name,
          contentBase64: base64,
        }),
      });
      const { data: d, errorText } = await readResponse(r);
      if (!r.ok) {
        setUploadError(d?.error || errorText || `upload ${r.status}`);
        return;
      }
      await load();
    } catch (e: any) {
      setUploadError(e?.message || "upload failed");
    } finally {
      setUploading(false);
    }
  };

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

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) uploadFile(f);
    e.target.value = "";  // reset so same file can be re-picked
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

  return (
    <PageContainer title="工作空间">
      <div className="ea-data-page workspace-data-page">
      <div className="ea-data-toolbar workspace-data-toolbar">
        <div className="ea-data-toolbar__actions">
        {caps?.supportsUpload && !inManagedSkillsDir && (
          <label className="inline-flex">
            <input type="file" className="hidden" onChange={handleFilePick} disabled={uploading} />
            <span className={`ea-data-btn ea-data-btn--primary ${uploading ? "pointer-events-none opacity-55" : ""}`} aria-disabled={uploading}>
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? "上传中" : "上传文件"}
            </span>
          </label>
        )}
        <button type="button" onClick={load} disabled={loading} className="ea-data-btn ea-data-btn--ghost">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          刷新
        </button>
        </div>
      </div>
      {uploadError && (
        <div className="mb-3 px-3 py-2 text-xs rounded-md" style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca" }}>
          上传失败: {uploadError}
        </div>
      )}
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
          <div className="ea-data-muted">让 Agent 帮你生成文件，或稍后启用上传功能</div>
        </div>
        </div>
      )}

      {sorted.length > 0 && (
        <div className="ea-data-card workspace-file-list" style={{ "--ea-data-columns": "minmax(240px, 1fr) 140px 120px minmax(200px, 0.5fr)" } as CSSProperties}>
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
                        <button type="button" onClick={(e) => { e.stopPropagation(); previewFile(f); }} className="ea-data-icon-btn">
                          <Eye className="w-3 h-3" /> 预览
                        </button>
                      )}
                      {f.type === "file" && caps?.supportsDownload && (
                        <a href={downloadUrl(f)} download={f.name} onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="ea-data-icon-btn">
                            <Download className="w-3 h-3" /> 下载
                          </button>
                        </a>
                      )}
                      {caps?.supportsDelete && !isProtectedRootFile(f) && !isManagedSkillsPath(f.path) && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); requestDeleteFile(f); }} className="ea-data-icon-btn ea-data-icon-btn--danger" title="删除">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                  </div>
                </div>
              ))}
        </div>
      )}
      </div>

      {/* Preview modal */}
      {previewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreviewing(null)}>
          <div className="bg-card text-card-foreground border border-border rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4" />
                <span className="font-mono text-sm">{previewing.path}</span>
                {previewing.modifiedAt && <span className="text-xs text-muted-foreground">· {formatTime(previewing.modifiedAt)}</span>}
              </div>
              <div className="flex gap-2">
                <a href={downloadUrl({ name: previewing.name, path: previewing.path, type: "file" })} download={previewing.name}>
                  <Button size="sm" variant="outline" className="gap-1"><Download className="w-3 h-3" /> 下载</Button>
                </a>
                <Button size="sm" variant="ghost" onClick={() => setPreviewing(null)}>关闭</Button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto bg-muted/40 p-4 text-xs font-mono text-foreground whitespace-pre-wrap">{previewing.content || "(空文件)"}</pre>
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
    </PageContainer>
  );
}
