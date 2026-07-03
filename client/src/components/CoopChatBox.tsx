/**
 * CoopChatBox — 协作子任务的接收方"工作台" mini chat
 *
 * 接受任务后，接收方在协作页面里直接 chat，跟自己的岗位智能体对话完成子任务，
 * 用 epochLabel = `coop-{sid}-u{uid}` 跟主聊天物理隔离（claw-chat.ts:312 已支持）。
 *
 * 演示前 Phase 1 简化：
 *   - 不调 task-xxx（接收方需要时自行执行，回来再附文件）
 *   - 提交 = 简版（拼接最后 N 条 AI 输出 → 弹 prompt 编辑 → 提交）
 *   - 不污染虾记忆（默认 skipMemoryWrite=true）
 *
 * Day 3 会扩展提交 Modal（附件勾选 + "从我的 task 产物里选"）
 */
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Sparkles, Square } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CoopSubmitModal, type SubmitAttachment } from "@/components/CoopSubmitModal";

type ChatMsg = {
  role: "user" | "assistant";
  text: string;
};

interface CoopChatBoxProps {
  sessionId: string;       // 协作 session id（如 cs-xxx）
  requestId: number;       // 协作子任务 request id
  subtask: string;         // 子任务文本（预填到 textarea，可改）
  coopTitle?: string;      // 协作标题（Modal 顶部显示）
  onSubmitted?: () => void; // 提交成功回调（让父组件 refetch）
}

export function CoopChatBox({ sessionId, requestId, subtask, coopTitle, onSubmitted }: CoopChatBoxProps) {
  const { user } = useAuth();
  // claw.me 返回 { hasClaw, adoption: { adoptId, ... } } —— adoption 才是虾对象
  const { data: myClaw, isLoading: clawLoading } = trpc.claw.me.useQuery(undefined, { retry: false });
  const myAdoptId = (myClaw as any)?.adoption?.adoptId as string | undefined;
  const myUserId = user?.id;

  const [input, setInput] = useState(subtask || "");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const msgsEndRef = useRef<HTMLDivElement>(null);

  // 协作 chat 的 epochLabel：sessionKey = agent:trial_xxx:main:coop-{sid}-u{uid}
  // 跟主聊天 e{epoch} 物理隔离，不污染主聊天 sandbox
  const epochLabel = `coop-${sessionId}-u${myUserId || "self"}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs.length, streaming]);

  const sendMessage = async () => {
    if (streaming || !myAdoptId) return;
    const text = input.trim();
    if (!text) return;

    setMsgs((prev) => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: "" }, // placeholder
    ]);
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const apiBase = (import.meta as any).env?.VITE_API_URL || "";
      const resp = await fetch(`${apiBase}/api/claw/chat-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          adoptId: myAdoptId,
          message: text,
          epochLabel, // ← 关键：协作专属 sessionKey
        }),
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`请求失败 (${resp.status})`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let done = false;

      while (!done) {
        const { done: rd, value } = await reader.read();
        if (rd) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) { currentEvent = line.slice(7).trim(); continue; }
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") { done = true; break; }
          try {
            const chunk = JSON.parse(raw);
            // 跳过非 content 事件（performance/heartbeat/tool/etc）
            if (chunk?.__perf || currentEvent === "agent_status") { currentEvent = ""; continue; }
            // OpenAI-style chat completion delta
            const delta =
              chunk?.choices?.[0]?.delta?.content ||
              chunk?.delta?.content ||
              chunk?.content ||
              "";
            if (delta) {
              setMsgs((prev) => {
                if (!prev.length || prev[prev.length - 1].role !== "assistant") return prev;
                const next = [...prev];
                next[next.length - 1] = { ...next[next.length - 1], text: next[next.length - 1].text + delta };
                return next;
              });
            }
            currentEvent = "";
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        toast.error("发送失败: " + (e?.message || "未知"));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const submitMut = trpc.coop.submitResult.useMutation({
    onSuccess: () => {
      toast.success("已提交协作结果");
      setSubmitting(false);
      onSubmitted?.();
    },
    onError: (e) => {
      toast.error(e.message || "提交失败");
      setSubmitting(false);
    },
  });

  // 收集本会话所有 assistant text（提交 Modal 用来生成草稿）
  const assistantTexts = msgs
    .filter((m) => m.role === "assistant")
    .map((m) => m.text);

  // 解析本会话所有 __files: marker → 提交 Modal 的附件 checkbox 列表
  const parsedFiles: SubmitAttachment[] = (() => {
    const fileSet = new Map<string, SubmitAttachment>();
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      const matches = m.text.matchAll(/<!--\s*__files:\s*(\[.*?\])\s*-->/gs);
      for (const mt of matches) {
        try {
          const arr = JSON.parse(mt[1]);
          if (Array.isArray(arr)) {
            for (const f of arr) {
              if (f?.name && f?.url) {
                fileSet.set(String(f.url), {
                  name: String(f.name),
                  url: String(f.url),
                  source: "chat",
                  size: typeof f.size === "number" ? f.size : undefined,
                });
              }
            }
          }
        } catch {}
      }
    }
    return Array.from(fileSet.values());
  })();

  const handleSubmitConfirm = async (data: { resultText: string; attachments: SubmitAttachment[] }) => {
    setSubmitting(true);
    await submitMut.mutateAsync({
      requestId,
      resultText: data.resultText,
      attachments: data.attachments,
    }).then(() => {
      setModalOpen(false);
    }).catch(() => {/* onError toast 已弹 */});
  };

  if (clawLoading) {
    return <div className="flex items-center justify-center py-8 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin mr-2" /> 加载中</div>;
  }
  if (!myAdoptId) {
    return <div className="py-6 text-center text-xs text-muted-foreground">需要先创建岗位智能体才能在这里完成子任务</div>;
  }

  return (
    <div className="mt-3 border border-border/60 rounded-lg bg-card" style={{ overflow: "hidden" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-primary/5 border-b border-border/40">
        <div className="text-xs text-foreground">
          <span className="font-semibold">🤝 协作工作台</span>
          <span className="ml-2 text-muted-foreground">独立 sandbox · 不污染主聊天</span>
        </div>
        <Button
          size="sm"
          className="h-7 text-xs text-white"
          style={{ background: "var(--oc-success)" }}
          onClick={() => setModalOpen(true)}
          disabled={submitting || streaming || msgs.length === 0}
          title={msgs.length === 0 ? "先跟虾对话产生结果" : "提交本次结果到协作"}
        >
          {submitting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Send className="w-3 h-3 mr-1" />}
          提交结果
        </Button>
      </div>

      {/* 消息列表 */}
      <div className="px-3 py-3 space-y-2 max-h-[420px] overflow-y-auto bg-muted/30">
        {msgs.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">
            子任务已预填到下方输入框，按发送让你的虾开始处理（可改）
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] text-xs px-3 py-2 rounded-lg whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border/40 text-foreground"
                }`}
                style={{ overflowWrap: "anywhere" }}
              >
                {m.text || (streaming && i === msgs.length - 1 ? <span className="opacity-60">▌</span> : null)}
              </div>
            </div>
          ))
        )}
        <div ref={msgsEndRef} />
      </div>

      {/* 提交 Modal */}
      <CoopSubmitModal
        open={modalOpen}
        onClose={() => !submitting && setModalOpen(false)}
        onConfirm={handleSubmitConfirm}
        submitting={submitting}
        coopTitle={coopTitle}
        subtask={subtask}
        sessionId={sessionId}
        requestId={requestId}
        assistantTexts={assistantTexts}
        parsedFiles={parsedFiles}
      />

      {/* 输入区 */}
      <div className="px-3 py-2 border-t border-border/40 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (streaming) stopStreaming();
              else sendMessage();
            }
          }}
          placeholder={streaming ? "处理中..." : "继续对话或修改子任务..."}
          rows={2}
          className="flex-1 text-xs px-2 py-1.5 border border-border/40 rounded resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={streaming}
        />
        {streaming ? (
          <Button size="sm" variant="outline" onClick={stopStreaming} className="h-auto self-stretch px-3" title="停止">
            <Square className="w-3 h-3" />
          </Button>
        ) : (
          <Button size="sm" onClick={sendMessage} disabled={!input.trim()} className="h-auto self-stretch px-3" title="发送">
            <Sparkles className="w-3 h-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
