import { useMemo, useState } from "react";
import {
  Brain,
  Check,
  Clock3,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
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

type MemoryMode = "learn_and_use" | "use_only" | "off";
type MemoryItem = {
  id: number;
  kind: "preference" | "instruction" | "entity" | "procedure";
  status: "active" | "candidate" | string;
  content: string;
  source: "explicit" | "automatic" | "feedback" | "legacy";
  evidenceCount: number;
  confidence: number;
  updatedAt: string;
};

const MODE_OPTIONS: Array<{ mode: MemoryMode; label: string; desc: string }> = [
  { mode: "learn_and_use", label: "使用并学习", desc: "使用已有偏好，并从后续协作中继续学习" },
  { mode: "use_only", label: "仅使用", desc: "继续使用已有偏好，不再学习新内容" },
  { mode: "off", label: "关闭", desc: "不学习，也不在回答中使用岗位偏好" },
];

const KIND_LABELS: Record<MemoryItem["kind"], string> = {
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

export function GrowthPage({ adoptId }: { adoptId: string }) {
  const [editor, setEditor] = useState<{ item?: MemoryItem; content: string } | null>(null);
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null);
  const view = trpc.claw.memoryView.useQuery(
    { adoptId },
    { enabled: Boolean(adoptId), retry: false, refetchOnWindowFocus: false },
  );
  const setMode = trpc.claw.setMemoryMode.useMutation({
    onSuccess: async () => {
      await view.refetch();
      toast.success("持续学习设置已更新");
    },
    onError: (error) => toast.error(error.message || "设置更新失败"),
  });
  const remember = trpc.claw.rememberMemory.useMutation({
    onSuccess: async () => {
      setEditor(null);
      await view.refetch();
      toast.success("岗位偏好已记住");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const update = trpc.claw.updateMemory.useMutation({
    onSuccess: async () => {
      setEditor(null);
      await view.refetch();
      toast.success("岗位偏好已更新");
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });
  const forget = trpc.claw.forgetMemory.useMutation({
    onSuccess: async () => {
      setForgetting(null);
      await view.refetch();
      toast.success("已忘记这条岗位偏好");
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  const items = (view.data?.items || []) as MemoryItem[];
  const activeItems = useMemo(() => items.filter((item) => item.status === "active"), [items]);
  const candidateItems = useMemo(() => items.filter((item) => item.status === "candidate"), [items]);
  const mode = (view.data?.mode || "learn_and_use") as MemoryMode;
  const saving = remember.isPending || update.isPending;

  const saveEditor = () => {
    if (!editor || editor.content.trim().length < 4) return;
    if (editor.item) {
      update.mutate({ adoptId, id: editor.item.id, content: editor.content.trim() });
    } else {
      remember.mutate({ adoptId, content: editor.content.trim(), kind: "preference" });
    }
  };

  const renderItem = (item: MemoryItem, candidate = false) => (
    <div key={item.id} className="growth-memory-row" data-status={item.status}>
      <span className="growth-memory-row__icon" aria-hidden="true">
        {candidate ? <Clock3 /> : item.kind === "procedure" ? <RotateCcw /> : <Brain />}
      </span>
      <span className="growth-memory-row__body">
        <span className="growth-memory-row__content">{item.content}</span>
        <span className="growth-memory-row__meta">
          <span>{KIND_LABELS[item.kind] || "岗位偏好"}</span>
          <i aria-hidden="true" />
          <span>{SOURCE_LABELS[item.source] || "持续学习"}</span>
          <i aria-hidden="true" />
          <span>{candidate ? `已出现 ${item.evidenceCount || 1} 次` : `更新于 ${formatDate(item.updatedAt)}`}</span>
        </span>
      </span>
      <span className="growth-memory-row__actions">
        <button type="button" title="编辑" aria-label="编辑岗位偏好" onClick={() => setEditor({ item, content: item.content })}>
          <Pencil />
        </button>
        <button type="button" title="忘记" aria-label="忘记岗位偏好" onClick={() => setForgetting(item)}>
          <Trash2 />
        </button>
      </span>
    </div>
  );

  return (
    <PageContainer title="成长记录">
      <div className="growth-page">
        <header className="growth-page__header">
          <div>
            <div className="growth-page__eyebrow"><Sparkles /> 持续学习</div>
            <h1>成长记录</h1>
            <p>记住你确认过的工作偏好，并在新的会话和已绑定频道中继续使用。</p>
          </div>
          <button type="button" className="growth-page__add" onClick={() => setEditor({ content: "" })} disabled={mode !== "learn_and_use"}>
            <Plus /> 添加偏好
          </button>
        </header>

        <section className="growth-mode" aria-label="持续学习模式">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              className="growth-mode__option"
              data-active={mode === option.mode ? "true" : "false"}
              disabled={setMode.isPending}
              onClick={() => setMode.mutate({ adoptId, mode: option.mode })}
            >
              <span className="growth-mode__check">{mode === option.mode ? <Check /> : null}</span>
              <span>
                <strong>{option.label}</strong>
                <small>{option.desc}</small>
              </span>
            </button>
          ))}
        </section>

        <div className="growth-summary" aria-label="学习概览">
          <span><strong>{view.data?.summary.active || 0}</strong> 已学会</span>
          <span><strong>{view.data?.summary.candidate || 0}</strong> 正在学习</span>
          <span><strong>{view.data?.summary.procedures || 0}</strong> 岗位流程</span>
          <small>默认按当前岗位隔离 · 实时业务数据仍从授权工具获取</small>
        </div>

        {view.isLoading ? (
          <div className="growth-empty">正在读取成长记录...</div>
        ) : view.error ? (
          <div className="growth-empty is-error">{view.error.message || "成长记录暂时不可用"}</div>
        ) : (
          <>
            <section className="growth-section">
              <div className="growth-section__heading">
                <div><h2>已学会</h2><p>这些内容会在相关任务中自动使用。</p></div>
                <span>{activeItems.length}</span>
              </div>
              <div className="growth-memory-list">
                {activeItems.length ? activeItems.map((item) => renderItem(item)) : (
                  <div className="growth-empty">
                    <Brain />
                    <strong>还没有岗位偏好</strong>
                    <span>在对话中说“以后先给结论，再展开依据”，智能体就能记住。</span>
                  </div>
                )}
              </div>
            </section>

            {candidateItems.length ? (
              <section className="growth-section">
                <div className="growth-section__heading">
                  <div><h2>正在学习</h2><p>同一偏好在不同会话中再次出现后才会生效。</p></div>
                  <span>{candidateItems.length}</span>
                </div>
                <div className="growth-memory-list is-candidate">
                  {candidateItems.map((item) => renderItem(item, true))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={Boolean(editor)} onOpenChange={(open) => { if (!open) setEditor(null); }}>
        <DialogContent className="growth-dialog sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editor?.item ? "编辑岗位偏好" : "添加岗位偏好"}</DialogTitle>
            <DialogDescription>只保存稳定的工作方式。客户数据、行情和产品状态会在使用时重新查询。</DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            value={editor?.content || ""}
            onChange={(event) => setEditor((current) => current ? { ...current, content: event.target.value.slice(0, 800) } : current)}
            placeholder="例如：生成客户方案时，先提示风险，再给产品建议。"
            rows={5}
          />
          <div className="growth-dialog__count">{editor?.content.length || 0}/800</div>
          <DialogFooter>
            <button type="button" className="growth-dialog__secondary" onClick={() => setEditor(null)}>取消</button>
            <button type="button" className="growth-dialog__primary" disabled={saving || (editor?.content.trim().length || 0) < 4} onClick={saveEditor}>
              {saving ? "保存中..." : "保存"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(forgetting)} onOpenChange={(open) => { if (!open) setForgetting(null); }}>
        <DialogContent className="growth-dialog sm:max-w-md">
          <DialogHeader>
            <DialogTitle>忘记这条偏好？</DialogTitle>
            <DialogDescription>删除后，智能体不会再在后续任务中使用它。</DialogDescription>
          </DialogHeader>
          <p className="growth-dialog__memory">{forgetting?.content}</p>
          <DialogFooter>
            <button type="button" className="growth-dialog__secondary" onClick={() => setForgetting(null)}>取消</button>
            <button type="button" className="growth-dialog__danger" disabled={forget.isPending} onClick={() => forgetting && forget.mutate({ adoptId, id: forgetting.id })}>
              {forget.isPending ? "处理中..." : "忘记"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
