import { useEffect, useState } from "react";
import { PageContainer } from "@/components/console/PageContainer";
import { FilesPanel } from "@/components/pages/agent/FilesPanel";
import type { CoreFileMeta } from "@/components/pages/agent/types";

export function AgentPage({ adoptId, skills }: { adoptId: string; skills?: { shared?: any[]; system?: any[]; private?: any[] } }) {
  const [coreFiles, setCoreFiles] = useState<CoreFileMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState("");

  const [fileName, setFileName] = useState("MEMORY.md");
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileEtag, setFileEtag] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [loadedFileKey, setLoadedFileKey] = useState("");

  const load = async () => {
    if (!adoptId) return;
    setLoading(true);
    setError("");
    try {
      const cf = await fetch(`/api/claw/core-files?adoptId=${encodeURIComponent(adoptId)}&t=${Date.now()}`, { cache: "no-store" });
      if (!cf.ok) throw new Error(`core-files ${cf.status}`);
      const cfd = await cf.json();
      setCoreFiles(cfd?.files || []);
    } catch (err: any) {
      setError(err?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCoreFiles([]);
    setFileName("MEMORY.md");
    setFileContent("");
    setSavedContent("");
    setFileEtag("");
    setFileFilter("");
    setPreviewOpen(false);
    setLoadedFileKey("");
  }, [adoptId]);

  useEffect(() => { load(); }, [adoptId]);

  const loadCoreFile = async (name: string) => {
    if (!adoptId) return;
    setFileName(name);
    setFileLoading(true);
    try {
      const r = await fetch(`/api/claw/core-files/read?adoptId=${encodeURIComponent(adoptId)}&name=${encodeURIComponent(name)}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`read ${r.status}`);
      const d = await r.json();
      setFileContent(d?.content || "");
      setSavedContent(d?.content || "");
      setFileEtag(d?.etag || "");
      setLoadedFileKey(`${adoptId}:${name}`);
    } catch (e: any) {
      setError(e?.message || "读取文件失败");
    } finally {
      setFileLoading(false);
    }
  };

  useEffect(() => {
    if (!adoptId || fileLoading || coreFiles.length === 0) return;
    const target =
      coreFiles.find((f) => f.name === fileName)?.name ||
      coreFiles.find((f) => f.name === "MEMORY.md")?.name ||
      coreFiles[0]?.name;
    if (!target) return;
    if (loadedFileKey === `${adoptId}:${target}`) return;
    void loadCoreFile(target);
  }, [adoptId, coreFiles, fileName, loadedFileKey, fileLoading]);

  const saveCoreFile = async () => {
    if (!adoptId || !fileName) return;
    setFileSaving(true);
    try {
      // 2026-04-20 review fix: runtime-aware save endpoint
      // - lgh- (legacy archived): SOUL/MEMORY/USER 走 memory/write, target 直接 filename
      // - lgc- (OpenClaw): MEMORY.md + memory:YYYY-MM-DD 走 memory/write (budget+audit)
      //                    其他 core files (SOUL/AGENTS/TOOLS/IDENTITY/STYLE/PLAN/KNOWLEDGE) 走 core-files/save
      const isLegacyArchived = String(adoptId).startsWith("lgh-");
      const dailyMemoryMatch = fileName.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);

      let r: Response;
      if (isLegacyArchived) {
        r = await fetch("/api/claw/memory/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, target: fileName, mode: "replace", content: fileContent, etag: fileEtag }),
        });
      } else if (fileName === "MEMORY.md" || dailyMemoryMatch) {
        const target = fileName === "MEMORY.md" ? "MEMORY.md" : ("memory:" + dailyMemoryMatch![1]);
        r = await fetch("/api/claw/memory/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, target, mode: "replace", content: fileContent, etag: fileEtag }),
        });
      } else if (fileName.startsWith("notes/")) {
        r = await fetch("/api/claw/memory/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, target: "notes:" + fileName.replace(/^notes\//, ""), mode: "replace", content: fileContent, etag: fileEtag }),
        });
      } else {
        // OpenClaw core files: SOUL/AGENTS/TOOLS/IDENTITY/STYLE/PLAN/KNOWLEDGE
        r = await fetch("/api/claw/core-files/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, name: fileName, content: fileContent, etag: fileEtag }),
        });
      }
      if (r.status === 409) throw new Error("文件已被更新，请刷新后重试");
      if (r.status === 429) { const d = await r.json(); throw new Error(`写入限制：${d?.error || "rate_limited"}`); }
      if (r.status === 413) { const d = await r.json(); throw new Error(`内容过大：${d?.error || "file_too_large"}`); }
      if (r.status === 400) { const d = await r.json(); throw new Error(`路径不允许：${d?.error || "path_not_allowed"}`); }
      if (!r.ok) throw new Error(`保存失败 (${r.status})`);
      const d = await r.json();
      setFileEtag(d?.etag || "");
      setSavedContent(fileContent);
      await load();
    } catch (e: any) {
      setError(e?.message || "保存失败");
    } finally {
      setFileSaving(false);
    }
  };

  const refreshAll = async () => {
    await load();
    if (fileName) await loadCoreFile(fileName);
  };

  const dirty = fileContent !== savedContent;

  return (
    <PageContainer title="记忆">
      {error && <div className="settings-card text-xs" style={{ color: "var(--banking-danger)" }}>{error}</div>}

      <FilesPanel
        coreFiles={coreFiles}
        fileFilter={fileFilter}
        setFileFilter={setFileFilter}
        refreshAll={refreshAll}
        previewOpen={previewOpen}
        setPreviewOpen={setPreviewOpen}
        fileName={fileName}
        loadCoreFile={loadCoreFile}
        fileContent={fileContent}
        setFileContent={setFileContent}
        saveCoreFile={saveCoreFile}
        fileSaving={fileSaving}
        fileLoading={fileLoading}
        dirty={dirty}
        resetLocal={() => setFileContent(savedContent)}
      />

    </PageContainer>
  );
}
