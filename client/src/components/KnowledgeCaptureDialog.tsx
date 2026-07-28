import { useEffect, useMemo, useState } from "react";
import { BookOpen, BookPlus, Check, FileText, Loader2, MessageSquareText } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type KnowledgeCaptureSource =
  | {
      type: "chat";
      title: string;
      answer: string;
      question?: string;
      conversationId?: string;
      messageId?: string;
      modelId?: string;
    }
  | {
      type: "workspace";
      title: string;
      workspacePath: string;
    };

export function KnowledgeCaptureDialog({
  open,
  onOpenChange,
  adoptId,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adoptId: string;
  source: KnowledgeCaptureSource | null;
}) {
  const utils = trpc.useUtils();
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [title, setTitle] = useState("");
  const [includeQuestion, setIncludeQuestion] = useState(false);
  const catalog = trpc.knowledge.list.useQuery(
    { adoptId },
    { enabled: Boolean(open && adoptId), retry: false, refetchOnWindowFocus: false },
  );
  const capture = trpc.knowledge.capture.useMutation();
  const personalBases = useMemo(() => (
    (catalog.data?.items || []).filter((base: any) => base.scope === "personal")
  ), [catalog.data?.items]);

  useEffect(() => {
    if (!open || !source) return;
    setKnowledgeBaseId("");
    setTitle(source.title);
    setIncludeQuestion(false);
  }, [open, source]);

  const submit = async () => {
    if (!source || !adoptId) return;
    try {
      const result = source.type === "chat"
        ? await capture.mutateAsync({
            sourceType: "chat",
            adoptId,
            ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
            title: title.trim(),
            answer: source.answer,
            question: source.question,
            includeQuestion,
            conversationId: source.conversationId,
            messageId: source.messageId,
            modelId: source.modelId,
          })
        : await capture.mutateAsync({
            sourceType: "workspace",
            adoptId,
            ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
            workspacePath: source.workspacePath,
          });
      await utils.knowledge.list.invalidate();
      onOpenChange(false);
      toast.success(result.duplicate
        ? `内容已存在于“${result.knowledgeBase.name}”`
        : `已加入“${result.knowledgeBase.name}”，正在整理知识`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加入知识库失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="knowledge-capture-dialog sm:max-w-lg">
        <DialogHeader>
          <div className="knowledge-capture-dialog__heading">
            <span><BookPlus aria-hidden="true" /></span>
            <div>
              <DialogTitle>沉淀为知识</DialogTitle>
              <DialogDescription>保存到个人知识库，后续对话可以检索和复用。</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {source?.type === "chat" ? (
          <label className="knowledge-capture-field">
            <span>知识标题</span>
            <input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="为这条知识起一个清晰的标题"
            />
          </label>
        ) : null}

        <label className="knowledge-capture-field">
          <span>保存到</span>
          <select value={knowledgeBaseId} onChange={(event) => setKnowledgeBaseId(event.target.value)}>
            <option value="">我的工作沉淀（默认）</option>
            {personalBases
              .filter((base: any) => base.name !== "我的工作沉淀")
              .map((base: any) => <option key={base.publicId} value={base.publicId}>{base.name}</option>)}
          </select>
          {!catalog.isLoading && personalBases.length === 0 ? <small>首次保存时会自动创建个人知识库。</small> : null}
        </label>

        {source?.type === "chat" ? (
          <div className="knowledge-capture-field">
            <span>保存范围</span>
            <div className="knowledge-capture-modes" role="radiogroup" aria-label="知识保存范围">
              <button type="button" role="radio" aria-checked={!includeQuestion} data-active={!includeQuestion} onClick={() => setIncludeQuestion(false)}>
                {!includeQuestion ? <Check /> : <MessageSquareText />}
                <span><strong>仅保存回复</strong><small>适合独立报告、总结和方案</small></span>
              </button>
              <button type="button" role="radio" aria-checked={includeQuestion} data-active={includeQuestion} onClick={() => setIncludeQuestion(true)}>
                {includeQuestion ? <Check /> : <MessageSquareText />}
                <span><strong>保存本轮问答</strong><small>同时保留问题背景</small></span>
              </button>
            </div>
          </div>
        ) : source ? (
          <div className="knowledge-capture-source">
            <FileText aria-hidden="true" />
            <span><strong>{source.title}</strong><small>{source.workspacePath}</small></span>
          </div>
        ) : null}

        <div className="knowledge-capture-note">
          <BookOpen aria-hidden="true" />
          <span>个人知识仅当前用户可编辑；岗位和企业知识仍由管理员维护。</span>
        </div>

        <DialogFooter>
          <button type="button" className="knowledge-dialog__secondary" onClick={() => onOpenChange(false)}>取消</button>
          <button
            type="button"
            className="knowledge-dialog__primary"
            disabled={capture.isPending || !source || (source.type === "chat" && !title.trim())}
            onClick={() => void submit()}
          >
            {capture.isPending ? <Loader2 className="is-spinning" /> : <BookPlus />}
            {capture.isPending ? "正在保存" : "加入知识库"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
