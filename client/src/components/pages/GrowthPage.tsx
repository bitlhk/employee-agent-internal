import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  CheckCircle2,
  Clock3,
  History,
  MessageSquareText,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { PageContainer } from "@/components/console/PageContainer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemoryGraphView } from "@/components/pages/MemoryGraphView";

type MemoryMode = "learn_and_use" | "use_only" | "off";
type MemoryKind = "preference" | "instruction" | "entity" | "procedure";
type MemoryLayer = "evidence" | "facts" | "synthesis";
type MemoryItem = {
  id: number;
  kind: MemoryKind;
  status: "active" | "candidate" | string;
  content: string;
  source: "explicit" | "automatic" | "feedback" | "legacy";
  evidenceCount: number;
  confidence: number;
  lastUsedAt?: string | null;
  updatedAt: string;
};
type MemoryEvidence = {
  id: number;
  memoryId: number;
  sourceType: "explicit" | "conversation" | "feedback" | "legacy";
  channel: string;
  conversationId?: string | null;
  snippet?: string | null;
  observedAt: string;
};
type MemorySynthesisSlot = "profile" | "recent" | "playbook";
type MemorySynthesis = {
  id: number;
  slot: MemorySynthesisSlot;
  canonicalKey: string;
  content: string;
  memoryIds: number[];
  confidence: number;
  model: string;
  generatedAt: string;
};

const MODE_OPTIONS: Array<{ mode: MemoryMode; label: string; desc: string }> = [
  { mode: "learn_and_use", label: "使用并学习", desc: "使用已有记忆，并从后续协作中继续学习" },
  { mode: "use_only", label: "仅使用", desc: "继续使用已沉淀内容，不再学习新内容" },
  { mode: "off", label: "关闭", desc: "不学习，也不在回答中使用岗位记忆" },
];

const KIND_LABELS: Record<MemoryKind, string> = {
  preference: "表达偏好",
  instruction: "工作习惯",
  entity: "事项约定",
  procedure: "岗位流程",
};

const SOURCE_LABELS: Record<MemoryItem["source"], string> = {
  explicit: "你明确确认",
  automatic: "协作中学习",
  feedback: "根据反馈确认",
  legacy: "历史记忆",
};

const CHANNEL_LABELS: Record<string, string> = {
  web: "网页对话",
  feishu: "飞书",
  weixin: "微信",
  dingtalk: "钉钉",
  conversation: "对话",
  "web-settings": "手工添加",
};

const SYNTHESIS_LABELS: Record<MemorySynthesisSlot, { title: string; desc: string }> = {
  profile: { title: "工作画像", desc: "稳定的表达习惯、协作偏好与关注重点" },
  recent: { title: "近期变化", desc: "最近确认或调整的工作方式" },
  playbook: { title: "岗位方法", desc: "可以在后续任务中复用的做事方法" },
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function memoryIcon(item: MemoryItem) {
  if (item.kind === "procedure") return <RotateCcw />;
  if (item.kind === "instruction") return <CheckCircle2 />;
  return <Brain />;
}

export function GrowthPage({ adoptId }: { adoptId: string }) {
  const [layer, setLayer] = useState<MemoryLayer>("synthesis");
  const [viewMode, setViewMode] = useState<"records" | "graph">("records");
  const [highlightedMemoryId, setHighlightedMemoryId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<{ item?: MemoryItem; content: string; kind: MemoryKind } | null>(null);
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null);
  const view = trpc.claw.memoryView.useQuery(
    { adoptId },
    {
      enabled: Boolean(adoptId),
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query) => (query.state.data as any)?.synthesisState?.status === "building" ? 2_000 : false,
    },
  );
  const refresh = async () => { await view.refetch(); };
  const setMode = trpc.claw.setMemoryMode.useMutation({
    onSuccess: async () => {
      await refresh();
      setSettingsOpen(false);
      toast.success("记忆设置已更新");
    },
    onError: (error) => toast.error(error.message || "设置更新失败"),
  });
  const remember = trpc.claw.rememberMemory.useMutation({
    onSuccess: async () => {
      setEditor(null);
      setLayer("facts");
      await refresh();
      toast.success("智能体已经记住");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const update = trpc.claw.updateMemory.useMutation({
    onSuccess: async () => {
      setEditor(null);
      setLayer("facts");
      await refresh();
      toast.success("记忆已更新");
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });
  const confirm = trpc.claw.confirmMemory.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("已沉淀为长期记忆");
    },
    onError: (error) => toast.error(error.message || "确认失败"),
  });
  const reject = trpc.claw.rejectMemory.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("已忽略这条候选记忆");
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });
  const forget = trpc.claw.forgetMemory.useMutation({
    onSuccess: async () => {
      setForgetting(null);
      await refresh();
      toast.success("已忘记这条记忆");
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });
  const refreshSynthesis = trpc.claw.refreshMemorySynthesis.useMutation({
    onSuccess: async () => {
      await refresh();
      setLayer("synthesis");
      toast.success("综合认知已更新");
    },
    onError: (error) => toast.error(error.message || "记忆整理失败"),
  });

  const items = (view.data?.items || []) as MemoryItem[];
  const evidence = (view.data?.evidence || []) as MemoryEvidence[];
  const syntheses = (view.data?.syntheses || []) as MemorySynthesis[];
  const synthesisState = view.data?.synthesisState as {
    status: "ready" | "building" | "failed";
    model?: string;
    errorMessage?: string | null;
    generatedAt?: string | null;
  } | undefined;
  const activeItems = useMemo(() => items.filter((item) => item.status === "active"), [items]);
  const candidateItems = useMemo(() => items.filter((item) => item.status === "candidate"), [items]);
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const groupedActive = useMemo(() => {
    return (Object.keys(KIND_LABELS) as MemoryKind[])
      .map((kind) => ({ kind, items: activeItems.filter((item) => item.kind === kind) }))
      .filter((group) => group.items.length > 0);
  }, [activeItems]);
  const groupedSyntheses = useMemo(() => {
    return (Object.keys(SYNTHESIS_LABELS) as MemorySynthesisSlot[])
      .map((slot) => ({ slot, items: syntheses.filter((item) => item.slot === slot) }))
      .filter((group) => group.items.length > 0);
  }, [syntheses]);
  const mode = (view.data?.mode || "learn_and_use") as MemoryMode;
  const saving = remember.isPending || update.isPending;

  const saveEditor = () => {
    if (!editor || editor.content.trim().length < 4) return;
    if (editor.item) {
      update.mutate({ adoptId, id: editor.item.id, content: editor.content.trim() });
    } else {
      remember.mutate({ adoptId, content: editor.content.trim(), kind: editor.kind });
    }
  };

  const revealMemory = (id: number) => {
    setViewMode("records");
    setLayer("facts");
    setHighlightedMemoryId(id);
  };

  useEffect(() => {
    if (!highlightedMemoryId || viewMode !== "records" || layer !== "facts") return;
    const timer = window.setTimeout(() => {
      document.getElementById(`memory-item-${highlightedMemoryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const clear = window.setTimeout(() => setHighlightedMemoryId(null), 2_200);
    return () => { window.clearTimeout(timer); window.clearTimeout(clear); };
  }, [highlightedMemoryId, layer, viewMode]);

  const renderActiveItem = (item: MemoryItem) => (
    <div key={item.id} id={`memory-item-${item.id}`} className="memory-record-row" data-highlighted={highlightedMemoryId === item.id}>
      <span className="memory-record-row__icon" aria-hidden="true">{memoryIcon(item)}</span>
      <span className="memory-record-row__body">
        <span className="memory-record-row__content">{item.content}</span>
        <span className="memory-record-row__meta">
          <span>{SOURCE_LABELS[item.source] || "持续学习"}</span>
          <i aria-hidden="true" />
          <span>{item.evidenceCount || 1} 条依据</span>
          <i aria-hidden="true" />
          <span>{item.lastUsedAt ? `最近使用 ${formatDate(item.lastUsedAt)}` : `更新于 ${formatDate(item.updatedAt)}`}</span>
        </span>
      </span>
      <span className="memory-record-row__actions">
        <button type="button" title="编辑" aria-label="编辑记忆" onClick={() => setEditor({ item, content: item.content, kind: item.kind })}><Pencil /></button>
        <button type="button" title="忘记" aria-label="忘记记忆" onClick={() => setForgetting(item)}><Trash2 /></button>
      </span>
    </div>
  );

  return (
    <PageContainer title="智能体记忆">
      <div className="memory-page" data-view={viewMode}>
        <header className="memory-page__header">
          <div>
            <div className="memory-page__eyebrow"><Sparkles /> 持续学习</div>
            <h1>智能体记忆</h1>
            <p>管理当前岗位智能体学习到的偏好、约定与工作方法。</p>
          </div>
          <div className="memory-page__header-actions">
            <button type="button" className="memory-page__secondary" onClick={() => setSettingsOpen(true)}><Settings2 />记忆设置</button>
            <button type="button" className="memory-page__primary" onClick={() => setEditor({ content: "", kind: "preference" })} disabled={mode !== "learn_and_use"}><Plus />添加记忆</button>
          </div>
        </header>

        <nav className="memory-view-tabs" aria-label="记忆视图">
          <button type="button" data-active={viewMode === "records"} onClick={() => setViewMode("records")}><Brain />记忆总览</button>
          <button type="button" data-active={viewMode === "graph"} onClick={() => setViewMode("graph")}><Network />记忆图谱</button>
        </nav>

        {viewMode === "records" ? <><nav className="memory-layers" aria-label="记忆形成层级">
          <button type="button" data-active={layer === "evidence"} onClick={() => setLayer("evidence")}>
            <span className="memory-layers__badge">L1</span>
            <span><strong>原始事件</strong><small>触发记忆形成的对话与确认记录</small></span>
            <b>{evidence.length}</b>
          </button>
          <span className="memory-layers__arrow" aria-hidden="true">→</span>
          <button type="button" data-active={layer === "facts"} onClick={() => setLayer("facts")}>
            <span className="memory-layers__badge">L2</span>
            <span><strong>记忆事实</strong><small>从事件中提取的稳定信息</small></span>
            <b>{items.length}</b>
          </button>
          <span className="memory-layers__arrow" aria-hidden="true">→</span>
          <button type="button" data-active={layer === "synthesis"} onClick={() => setLayer("synthesis")}>
            <span className="memory-layers__badge">L3</span>
            <span><strong>综合认知</strong><small>跨事实形成的工作画像与岗位方法</small></span>
            <b>{syntheses.length}</b>
          </button>
        </nav>

        {view.isLoading ? (
          <div className="memory-empty">正在读取智能体记忆...</div>
        ) : view.error ? (
          <div className="memory-empty is-error">{view.error.message || "智能体记忆暂时不可用"}</div>
        ) : layer === "evidence" ? (
          <section className="memory-panel">
            <div className="memory-panel__heading"><div><h2>原始事件</h2><p>展示触发记忆形成的对话与确认记录，不保留完整聊天正文。</p></div><span>{evidence.length}</span></div>
            <div className="memory-evidence-list">
              {evidence.length ? evidence.map((entry) => {
                const target = itemById.get(entry.memoryId);
                return (
                  <div key={entry.id} className="memory-evidence-row">
                    <span className="memory-evidence-row__rail"><i /></span>
                    <span className="memory-evidence-row__body">
                      <span className="memory-evidence-row__source"><MessageSquareText />{CHANNEL_LABELS[entry.channel] || entry.channel}<time>{formatDate(entry.observedAt)}</time></span>
                      <span className="memory-evidence-row__snippet">{entry.snippet || "这条依据已隐藏或来自明确确认。"}</span>
                      {target ? <button type="button" className="memory-evidence-row__target" onClick={() => revealMemory(target.id)}>形成事实：{target.content}</button> : null}
                    </span>
                  </div>
                );
              }) : <div className="memory-empty"><History /><strong>还没有协作依据</strong><span>智能体会从后续有效协作中逐步学习。</span></div>}
            </div>
          </section>
        ) : layer === "facts" ? (
          <section className="memory-panel">
            <div className="memory-panel__heading"><div><h2>记忆事实</h2><p>已确认事实会自动用于后续任务；学习中的规律需要再次出现或由你确认。</p></div><span>{activeItems.length} 已确认 · {candidateItems.length} 学习中</span></div>
            {candidateItems.length ? <div className="memory-kind-group is-candidate-group">
              <div className="memory-kind-group__title"><span>学习中</span><small>{candidateItems.length}</small></div>
              <div className="memory-candidate-list">
                {candidateItems.map((item) => (
                  <div key={item.id} id={`memory-item-${item.id}`} className="memory-candidate-row" data-highlighted={highlightedMemoryId === item.id}>
                    <span className="memory-record-row__icon is-candidate"><Clock3 /></span>
                    <span className="memory-record-row__body">
                      <span className="memory-record-row__content">{item.content}</span>
                      <span className="memory-record-row__meta"><span>{KIND_LABELS[item.kind]}</span><i /><span>已出现 {item.evidenceCount || 1} 次</span><i /><span>{SOURCE_LABELS[item.source]}</span></span>
                    </span>
                    <span className="memory-candidate-row__actions">
                      <button type="button" className="is-confirm" disabled={confirm.isPending || reject.isPending} onClick={() => confirm.mutate({ adoptId, id: item.id })}><Check />确认</button>
                      <button type="button" disabled={confirm.isPending || reject.isPending} onClick={() => reject.mutate({ adoptId, id: item.id })}><X />忽略</button>
                    </span>
                  </div>
                ))}
              </div>
            </div> : null}
            {groupedActive.length ? groupedActive.map((group) => (
              <div key={group.kind} className="memory-kind-group">
                <div className="memory-kind-group__title"><span>{KIND_LABELS[group.kind]}</span><small>{group.items.length}</small></div>
                <div className="memory-record-list">{group.items.map(renderActiveItem)}</div>
              </div>
            )) : candidateItems.length ? null : <div className="memory-empty"><Brain /><strong>还没有记忆事实</strong><span>在对话中说“以后先给结论，再展开依据”，智能体就能记住。</span></div>}
          </section>
        ) : (
          <section className="memory-panel">
            <div className="memory-panel__heading memory-panel__heading--synthesis">
              <div><h2>综合认知</h2><p>智能体跨多条已确认事实形成的工作画像和岗位方法，每条结论都可以追溯。</p></div>
              <button type="button" className="memory-synthesis-refresh" disabled={refreshSynthesis.isPending || synthesisState?.status === "building"} onClick={() => refreshSynthesis.mutate({ adoptId })}>
                <RefreshCw data-spinning={refreshSynthesis.isPending || synthesisState?.status === "building"} />
                {synthesisState?.status === "building" ? "正在整理" : "重新整理"}
              </button>
            </div>
            {synthesisState?.status === "building" && !syntheses.length ? (
              <div className="memory-empty"><RefreshCw className="is-spinning" /><strong>正在形成综合认知</strong><span>整理在后台完成，不影响继续对话。</span></div>
            ) : synthesisState?.status === "failed" && !syntheses.length ? (
              <div className="memory-empty is-error"><Brain /><strong>综合认知暂时没有整理完成</strong><span>{synthesisState.errorMessage || "可以稍后重新整理"}</span></div>
            ) : groupedSyntheses.length ? groupedSyntheses.map((group) => (
              <div key={group.slot} className="memory-synthesis-group">
                <div className="memory-synthesis-group__heading"><div><strong>{SYNTHESIS_LABELS[group.slot].title}</strong><span>{SYNTHESIS_LABELS[group.slot].desc}</span></div><small>{group.items.length}</small></div>
                <div className="memory-synthesis-list">
                  {group.items.map((item) => (
                    <article key={item.id} className="memory-synthesis-row">
                      <span className="memory-synthesis-row__node"><Network /></span>
                      <div className="memory-synthesis-row__body">
                        <p>{item.content}</p>
                        <div className="memory-synthesis-row__sources">
                          <span>依据 {item.memoryIds.length} 条事实</span>
                          {item.memoryIds.slice(0, 4).map((id) => {
                            const source = itemById.get(id);
                            return source ? <button key={id} type="button" onClick={() => revealMemory(id)}>{source.content}</button> : null;
                          })}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )) : <div className="memory-empty"><Network /><strong>还没有形成综合认知</strong><span>积累至少两条稳定事实后，智能体会自动整理工作画像和岗位方法。</span></div>}
          </section>
        )}</> : view.isLoading ? (
          <div className="memory-empty">正在生成记忆图谱...</div>
        ) : view.error ? (
          <div className="memory-empty is-error">{view.error.message || "智能体记忆暂时不可用"}</div>
        ) : (
          <MemoryGraphView items={items} evidence={evidence} syntheses={syntheses} onOpenMemory={revealMemory} />
        )}
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="memory-dialog sm:max-w-xl">
          <DialogHeader><DialogTitle>记忆设置</DialogTitle><DialogDescription>控制当前岗位智能体是否学习和使用长期记忆。</DialogDescription></DialogHeader>
          <div className="memory-mode-list">
            {MODE_OPTIONS.map((option) => (
              <button key={option.mode} type="button" data-active={mode === option.mode} disabled={setMode.isPending} onClick={() => setMode.mutate({ adoptId, mode: option.mode })}>
                <span className="memory-mode-list__check">{mode === option.mode ? <Check /> : null}</span>
                <span><strong>{option.label}</strong><small>{option.desc}</small></span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editor)} onOpenChange={(open) => { if (!open) setEditor(null); }}>
        <DialogContent className="memory-dialog sm:max-w-lg">
          <DialogHeader><DialogTitle>{editor?.item ? "编辑记忆" : "添加记忆"}</DialogTitle><DialogDescription>只保存稳定的工作方式。客户数据、行情和产品状态会在使用时重新查询。</DialogDescription></DialogHeader>
          {!editor?.item ? (
            <div className="memory-kind-picker" role="group" aria-label="记忆类型">
              {(Object.keys(KIND_LABELS) as MemoryKind[]).map((kind) => <button key={kind} type="button" data-active={editor?.kind === kind} onClick={() => setEditor((current) => current ? { ...current, kind } : current)}>{KIND_LABELS[kind]}</button>)}
            </div>
          ) : null}
          <textarea autoFocus value={editor?.content || ""} onChange={(event) => setEditor((current) => current ? { ...current, content: event.target.value.slice(0, 800) } : current)} placeholder="例如：生成客户方案时，先提示风险，再给产品建议。" rows={5} />
          <div className="memory-dialog__count">{editor?.content.length || 0}/800</div>
          <DialogFooter><button type="button" className="memory-dialog__secondary" onClick={() => setEditor(null)}>取消</button><button type="button" className="memory-dialog__primary" disabled={saving || (editor?.content.trim().length || 0) < 4} onClick={saveEditor}>{saving ? "保存中..." : "保存"}</button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(forgetting)} onOpenChange={(open) => { if (!open) setForgetting(null); }}>
        <DialogContent className="memory-dialog sm:max-w-md">
          <DialogHeader><DialogTitle>忘记这条记忆？</DialogTitle><DialogDescription>删除后，智能体不会再在后续任务中使用它。</DialogDescription></DialogHeader>
          <p className="memory-dialog__memory">{forgetting?.content}</p>
          <DialogFooter><button type="button" className="memory-dialog__secondary" onClick={() => setForgetting(null)}>取消</button><button type="button" className="memory-dialog__danger" disabled={forget.isPending} onClick={() => forgetting && forget.mutate({ adoptId, id: forgetting.id })}>{forget.isPending ? "处理中..." : "忘记"}</button></DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
