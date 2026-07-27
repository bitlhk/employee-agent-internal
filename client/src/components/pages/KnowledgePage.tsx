import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Building2,
  Download,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { PageContainer } from "@/components/console/PageContainer";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Scope = "personal" | "role" | "enterprise";
type BaseStatus = "empty" | "indexing" | "ready" | "failed";
type KnowledgeBaseItem = {
  id: number;
  publicId: string;
  ownerUserId: number;
  scope: Scope;
  isGlobal: boolean;
  name: string;
  description: string;
  status: BaseStatus;
  documentCount: number;
  chunkCount: number;
  lastError?: string | null;
  indexedAt?: string | null;
  updatedAt: string;
};
type KnowledgeDocument = {
  id: number;
  publicId: string;
  name: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploaded" | "indexing" | "ready" | "failed";
  chunkCount: number;
  lastError?: string | null;
  updatedAt: string;
};

const SCOPE_LABELS: Record<Scope, string> = { personal: "我的知识", role: "岗位知识", enterprise: "企业知识" };
const STATUS_LABELS: Record<BaseStatus, string> = { empty: "等待文档", indexing: "正在解析", ready: "可检索", failed: "处理失败" };
const SUPPORTED_EXTENSIONS = new Set(["md", "txt", "csv", "json", "yaml", "yml", "pdf", "docx", "xlsx", "pptx"]);

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function ScopeIcon({ scope }: { scope: Scope }) {
  if (scope === "enterprise") return <Building2 />;
  if (scope === "role") return <ShieldCheck />;
  return <UserRound />;
}

export function KnowledgePage({ adoptId }: { adoptId: string }) {
  const [scopeFilter, setScopeFilter] = useState<"all" | Scope>("all");
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedDocument, setSelectedDocument] = useState<KnowledgeDocument | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({ name: "", description: "" });
  const [uploading, setUploading] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const list = trpc.knowledge.list.useQuery(
    { adoptId },
    { enabled: Boolean(adoptId), retry: false, refetchInterval: 5_000, refetchOnWindowFocus: false },
  );
  const detail = trpc.knowledge.detail.useQuery(
    { adoptId, knowledgeBaseId: selectedId },
    { enabled: Boolean(adoptId && selectedId), retry: false, refetchInterval: selectedId ? 4_000 : false, refetchOnWindowFocus: false },
  );
  const health = trpc.knowledge.serviceHealth.useQuery(undefined, { retry: false, refetchInterval: 15_000 });
  const searchResult = trpc.knowledge.search.useQuery(
    { adoptId, knowledgeBaseId: selectedId, query: searchQuery, limit: 8 },
    { enabled: Boolean(adoptId && selectedId && searchQuery), retry: false },
  );
  const create = trpc.knowledge.create.useMutation({
    onSuccess: async (base) => {
      setCreateOpen(false);
      setCreateDraft({ name: "", description: "" });
      await utils.knowledge.list.invalidate();
      setSelectedId(base.publicId);
      toast.success("知识库已创建");
    },
    onError: (error) => toast.error(error.message || "创建失败"),
  });
  const remove = trpc.knowledge.remove.useMutation({
    onSuccess: async () => {
      setSelectedId("");
      setSelectedDocument(null);
      await utils.knowledge.list.invalidate();
      toast.success("知识库已删除");
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });
  const reindex = trpc.knowledge.reindex.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.knowledge.list.invalidate(), utils.knowledge.detail.invalidate()]);
      toast.success("已开始重新整理知识");
    },
    onError: (error) => toast.error(error.message || "重建失败"),
  });

  const bases = (list.data?.items || []) as KnowledgeBaseItem[];
  const filteredBases = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase("zh-CN");
    return bases.filter((base) => {
      if (scopeFilter !== "all" && base.scope !== scopeFilter) return false;
      return !query || base.name.toLocaleLowerCase("zh-CN").includes(query) || base.description.toLocaleLowerCase("zh-CN").includes(query);
    });
  }, [bases, filter, scopeFilter]);
  const selectedBase = (detail.data?.base || bases.find((item) => item.publicId === selectedId)) as KnowledgeBaseItem | undefined;
  const documents = (detail.data?.documents || []) as KnowledgeDocument[];
  const canEdit = Boolean(selectedBase && selectedBase.scope === "personal");

  const uploadDocuments = async (files: FileList | null) => {
    if (!selectedId || !files?.length) return;
    const accepted = Array.from(files).filter((file) => SUPPORTED_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() || ""));
    if (!accepted.length) { toast.error("请选择支持的文档格式"); return; }
    setUploading(true);
    try {
      for (const file of accepted) {
        const response = await fetch("/api/knowledge/documents/upload", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, knowledgeBaseId: selectedId, filename: file.name, mimeType: file.type, contentBase64: await fileToBase64(file) }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || `${file.name} 上传失败`);
      }
      await Promise.all([utils.knowledge.list.invalidate(), utils.knowledge.detail.invalidate()]);
      toast.success(`已上传 ${accepted.length} 份文档，正在整理知识`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const deleteDocument = async (document: KnowledgeDocument) => {
    const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(document.publicId)}?adoptId=${encodeURIComponent(adoptId)}&knowledgeBaseId=${encodeURIComponent(selectedId)}`, { method: "DELETE", credentials: "include" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { toast.error(payload?.error || "删除失败"); return; }
    if (selectedDocument?.publicId === document.publicId) setSelectedDocument(null);
    await Promise.all([utils.knowledge.list.invalidate(), utils.knowledge.detail.invalidate()]);
    toast.success("文档已删除，正在更新知识索引");
  };

  if (selectedId && selectedBase) {
    const contentUrl = selectedDocument
      ? `/api/knowledge/documents/${encodeURIComponent(selectedDocument.publicId)}/content?adoptId=${encodeURIComponent(adoptId)}&knowledgeBaseId=${encodeURIComponent(selectedId)}`
      : "";
    const previewable = selectedDocument && ["pdf", "txt", "md", "csv", "json", "yaml", "yml"].includes(selectedDocument.extension);
    return (
      <PageContainer title="知识中心">
        <div className="knowledge-detail">
          <header className="knowledge-detail__header">
            <button type="button" className="knowledge-back" onClick={() => { setSelectedId(""); setSelectedDocument(null); setSearchQuery(""); }}><ArrowLeft />知识中心</button>
            <div className="knowledge-detail__title-row">
              <span className="knowledge-base-icon"><BookOpen /></span>
              <div><h1>{selectedBase.name}</h1><p>{selectedBase.description || "长期保存并可在对话中检索的资料。"}</p></div>
              <span className="knowledge-scope"><ScopeIcon scope={selectedBase.scope} />{SCOPE_LABELS[selectedBase.scope]}</span>
            </div>
            <div className="knowledge-detail__actions">
              <span className="knowledge-status" data-status={selectedBase.status}><i />{STATUS_LABELS[selectedBase.status]}</span>
              {canEdit ? <button type="button" onClick={() => reindex.mutate({ adoptId, knowledgeBaseId: selectedId })} disabled={reindex.isPending || selectedBase.status === "indexing"}><RefreshCw />重新整理</button> : null}
              {canEdit ? <button type="button" className="is-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}><Upload />{uploading ? "上传中..." : "上传文档"}</button> : null}
              <input ref={fileInputRef} type="file" multiple hidden accept=".md,.txt,.csv,.json,.yaml,.yml,.pdf,.docx,.xlsx,.pptx" onChange={(event) => void uploadDocuments(event.target.files)} />
            </div>
          </header>

          {!health.data?.ok ? <div className="knowledge-service-warning">知识检索服务暂时离线，文档仍可管理，恢复后可重新整理。</div> : null}

          <div className="knowledge-search-panel">
            <form onSubmit={(event) => { event.preventDefault(); setSearchQuery(searchInput.trim()); }}>
              <Search />
              <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="在当前知识库中搜索…" />
              <button type="submit" disabled={!searchInput.trim()}>搜索</button>
            </form>
            {searchQuery ? (
              <div className="knowledge-search-results">
                <div className="knowledge-search-results__head"><span>“{searchQuery}”的相关内容</span><button type="button" onClick={() => { setSearchQuery(""); setSearchInput(""); }}>关闭</button></div>
                {searchResult.isLoading ? <div className="knowledge-search-empty"><LoaderCircle className="is-spinning" />正在检索资料...</div> : searchResult.error ? <div className="knowledge-search-empty is-error">{searchResult.error.message}</div> : (searchResult.data?.results || []).length ? (searchResult.data?.results || []).map((result: any) => (
                  <button key={result.chunkId} type="button" className="knowledge-search-hit" onClick={() => setSelectedDocument(documents.find((doc) => doc.publicId === result.documentId) || null)}>
                    <span><strong>{result.documentName}</strong><small>{result.position}</small></span>
                    <p>{result.text}</p>
                  </button>
                )) : <div className="knowledge-search-empty">没有找到相关内容</div>}
              </div>
            ) : null}
          </div>

          <div className="knowledge-document-layout">
            <section className="knowledge-document-list">
              <div className="knowledge-document-list__head"><span>文件</span><small>{documents.length}</small></div>
              {detail.isLoading ? <div className="knowledge-document-empty"><LoaderCircle className="is-spinning" />正在加载文档...</div> : documents.length ? documents.map((document) => (
                <div key={document.publicId} role="button" tabIndex={0} className="knowledge-document-row" data-active={selectedDocument?.publicId === document.publicId} onClick={() => setSelectedDocument(document)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedDocument(document); } }}>
                  <span className="knowledge-document-row__icon"><FileTypeIcon name={document.name} /></span>
                  <span className="knowledge-document-row__body"><strong title={document.name}>{document.name}</strong><small>{formatSize(document.sizeBytes)} · {document.status === "ready" ? `${document.chunkCount} 个知识片段` : document.status === "failed" ? "处理失败" : "正在处理"}</small></span>
                  {canEdit ? <span className="knowledge-document-row__actions"><button type="button" title="删除" onClick={(event) => { event.stopPropagation(); void deleteDocument(document); }}><Trash2 /></button></span> : null}
                </div>
              )) : <div className="knowledge-document-empty"><FolderOpen /><strong>还没有文档</strong><span>上传资料后会自动解析并建立索引。</span></div>}
            </section>

            <section className="knowledge-preview">
              {selectedDocument ? (
                <>
                  <div className="knowledge-preview__head"><div><FileText /><span>{selectedDocument.name}</span></div><a href={`${contentUrl}&download=1`}><Download />下载</a></div>
                  {previewable ? <iframe src={contentUrl} title={selectedDocument.name} sandbox="" /> : <div className="knowledge-preview__empty"><FileTypeIcon name={selectedDocument.name} /><strong>该格式暂不支持网页预览</strong><span>文档已经参与知识检索，可以下载后查看原文件。</span><a href={`${contentUrl}&download=1`}><Download />下载文档</a></div>}
                </>
              ) : <div className="knowledge-preview__empty"><FileText /><strong>选择一份文档</strong><span>可在这里预览原文和核对知识来源。</span></div>}
            </section>
          </div>

          {canEdit ? <button type="button" className="knowledge-delete-base" onClick={() => { if (window.confirm(`确认删除知识库“${selectedBase.name}”？`)) remove.mutate({ adoptId, knowledgeBaseId: selectedId }); }}><Trash2 />删除知识库</button> : null}
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title="知识中心">
      <div className="knowledge-page">
        <header className="knowledge-page__header">
          <div><div className="knowledge-page__eyebrow"><BookOpen />长期知识</div><h1>知识中心</h1><p>集中管理个人、岗位与企业资料，让回答有依据、可核验。</p></div>
          <button type="button" className="knowledge-page__create" onClick={() => setCreateOpen(true)}><Plus />新建知识库</button>
        </header>

        <div className="knowledge-toolbar">
          <div className="knowledge-tabs">
            {(["all", "personal", "role", "enterprise"] as const).map((scope) => <button key={scope} type="button" data-active={scopeFilter === scope} onClick={() => setScopeFilter(scope)}>{scope === "all" ? "全部" : SCOPE_LABELS[scope]}</button>)}
          </div>
          <label className="knowledge-filter"><Search /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索知识库…" /></label>
        </div>

        {!health.isLoading && !health.data?.ok ? <div className="knowledge-service-warning">知识检索服务暂时离线，新文档将在服务恢复后完成整理。</div> : null}

        {list.isLoading ? <div className="knowledge-page-empty"><LoaderCircle className="is-spinning" />正在加载知识库...</div> : list.error ? <div className="knowledge-page-empty is-error">{list.error.message}</div> : filteredBases.length ? (
          <div className="knowledge-grid">
            {filteredBases.map((base) => (
              <button key={base.publicId} type="button" className="knowledge-card" onClick={() => setSelectedId(base.publicId)}>
                <span className="knowledge-card__top"><span className="knowledge-base-icon"><BookOpen /></span><span className="knowledge-card__title"><strong>{base.name}</strong><small><ScopeIcon scope={base.scope} />{SCOPE_LABELS[base.scope]}</small></span><span className="knowledge-status" data-status={base.status}><i />{STATUS_LABELS[base.status]}</span></span>
                <span className="knowledge-card__description">{base.description || "长期保存并可在对话中检索的资料。"}</span>
                <span className="knowledge-card__meta"><span>{base.documentCount} 份文档</span><span>{base.chunkCount} 个知识片段</span><time>{formatTime(base.updatedAt)}</time></span>
              </button>
            ))}
          </div>
        ) : <div className="knowledge-page-empty"><BookOpen /><strong>{filter || scopeFilter !== "all" ? "没有匹配的知识库" : "还没有知识库"}</strong><span>{filter || scopeFilter !== "all" ? "调整筛选条件后再试。" : "创建知识库并上传文档，智能体就能基于资料回答。"}</span>{!filter && scopeFilter === "all" ? <button type="button" onClick={() => setCreateOpen(true)}><Plus />新建知识库</button> : null}</div>}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="knowledge-dialog sm:max-w-lg">
          <DialogHeader><DialogTitle>新建知识库</DialogTitle><DialogDescription>第一版创建个人知识库。岗位和企业知识库由管理员统一配置。</DialogDescription></DialogHeader>
          <label><span>名称</span><input autoFocus value={createDraft.name} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value.slice(0, 120) }))} placeholder="例如：客户服务制度" /></label>
          <label><span>说明</span><textarea value={createDraft.description} onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value.slice(0, 500) }))} placeholder="简单说明这组资料包含什么内容" rows={4} /></label>
          <DialogFooter><button type="button" className="knowledge-dialog__secondary" onClick={() => setCreateOpen(false)}>取消</button><button type="button" className="knowledge-dialog__primary" disabled={create.isPending || !createDraft.name.trim()} onClick={() => create.mutate({ adoptId, name: createDraft.name.trim(), description: createDraft.description.trim() })}>{create.isPending ? "创建中..." : "创建"}</button></DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
