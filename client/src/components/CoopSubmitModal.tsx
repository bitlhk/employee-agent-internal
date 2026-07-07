/**
 * CoopSubmitModal — 协作子任务的"提交结果"弹窗
 *
 * 替代 CoopChatBox 之前用的 window.prompt（演示前简版）
 * 提供：
 *   1. 文本结果编辑（默认从对话最后 N 条 AI 输出生成草稿）
 *   2. 「✨ 重新生成草稿」按钮
 *   3. 附件 checkbox（本会话 __files: 解析）
 *   4. 取消 / 提交
 *
 * Day 3 Phase 1 不做的（演示后再加）：
 *   - 「📎 从我的 task 产物里选」浮窗
 *   - 文本草稿用 LLM 总结（现在是简单拼接最后 2 条）
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Send, X, FileText, Sparkles, Paperclip, Upload } from "lucide-react";
import { toast } from "sonner";

export type SubmitAttachment = {
  name: string;
  url: string;
  source: "chat" | "task" | "agent_workspace";
  size?: number;
  fileId?: number;
  adoptId?: string;
  path?: string;
};

interface CoopSubmitModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (data: { resultText: string; attachments: SubmitAttachment[] }) => Promise<void> | void;
  submitting: boolean;

  // 上下文
  coopTitle?: string;
  subtask: string;
  sessionId: string;        // 用于 upload endpoint
  requestId: number;        // 用于 upload endpoint

  // 数据来源（CoopChatBox 传过来的对话产物）
  assistantTexts: string[];               // 所有 assistant message text（含推荐卡片，自己过滤）
  parsedFiles: SubmitAttachment[];        // __files: 解析出的所有文件（chat 来源）
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB，跟 server 一致

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

// 从 assistant 输出生成草稿：拼接最后 2 段，去掉推荐卡片 markdown
function generateDraft(assistantTexts: string[]): string {
  const cleaned = assistantTexts
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !t.startsWith("> 💡 **检测到专业需求")); // 跳过推荐卡片
  if (cleaned.length === 0) return "";
  return cleaned.slice(-2).join("\n\n---\n\n");
}

export function CoopSubmitModal({
  open,
  onClose,
  onConfirm,
  submitting,
  coopTitle,
  subtask,
  sessionId,
  requestId,
  assistantTexts,
  parsedFiles,
}: CoopSubmitModalProps) {
  const [text, setText] = useState("");
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [uploadedFiles, setUploadedFiles] = useState<SubmitAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 2026-04-18 fix: 防止在 textarea 内按下鼠标、拖到遮罩松开导致 click 冒到 overlay 误关闭。
  // 只有按下和松开都在遮罩本身时才算"点了遮罩"。
  const overlayMouseDownRef = useRef(false);
  // 2026-04-18 fix: 记录上一次初始化的 draft，open 时若用户已改过（当前 text 非空且不等于上次 draft）则保留编辑。
  const initialDraftRef = useRef<string>("");

  // open 切换时：仅在用户未编辑的情况下刷新草稿 / 附件勾选 / 清空已上传
  useEffect(() => {
    if (open) {
      const draft = generateDraft(assistantTexts) || subtask;
      setText((prev) => {
        if (prev.trim() && prev !== initialDraftRef.current) {
          // 用户改过，保留原内容
          return prev;
        }
        initialDraftRef.current = draft;
        return draft;
      });
      setSelectedUrls(new Set(parsedFiles.map((f) => f.url)));
      setUploadedFiles([]);
    }
  }, [open]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // 合并显示：__files: 解析的（chat） + 用户上传的（task=chat 视作上传也算 chat 来源）
  const allFiles: SubmitAttachment[] = [...parsedFiles, ...uploadedFiles];

  // 上传单个文件 → base64 → POST /api/coop/upload
  const uploadFile = async (file: File) => {
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      toast.error(`文件大小必须 ≤ ${MAX_UPLOAD_BYTES / 1024 / 1024}MB（当前 ${formatSize(file.size)}）`);
      return;
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      // 转 base64（chunked，避免 stack 溢出）
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
      }
      const contentBase64 = btoa(bin);

      const apiBase = (import.meta as any).env?.VITE_API_URL || "";
      const r = await fetch(`${apiBase}/api/coop/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId, requestId, filename: file.name, contentBase64 }),
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) {
        throw new Error(data?.error || `上传失败 (${r.status})`);
      }
      const att: SubmitAttachment = { fileId: data.fileId, name: data.name, url: data.url, source: "chat", size: data.size };
      setUploadedFiles((prev) => [...prev, att]);
      // 自动勾选刚上传的
      setSelectedUrls((prev) => {
        const next = new Set(prev);
        next.add(att.url);
        return next;
      });
      toast.success(`已上传：${data.name}（${formatSize(data.size)}）`);
    } catch (e: any) {
      toast.error(e?.message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (e.target) e.target.value = ""; // 允许选同一文件重复
    files.forEach((f) => { void uploadFile(f); });
  };

  const regenDraft = () => {
    const draft = generateDraft(assistantTexts);
    if (!draft) {
      toast.info("当前对话还没产生 AI 输出，请先跟虾对话产出内容后再点生成");
      return;
    }
    setText(draft);
    toast.success("已从对话最后 2 条 AI 输出生成草稿");
  };

  // 是否有可用 AI 输出（用于 disable 按钮 + 文案提示）
  const hasUsableDraft = generateDraft(assistantTexts).length > 0;

  const toggleFile = (url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const canSubmit = text.trim().length > 0;

  const handleConfirm = async () => {
    if (!canSubmit || submitting) return;
    const attachments = allFiles.filter((f) => selectedUrls.has(f.url));
    await onConfirm({ resultText: text.trim(), attachments });
  };

  if (!open) return null;

  // ── 岗位智能体平台风格 + 玻璃/磨砂效果 ──
  // 遮罩：黑半透明 + 背景模糊 8px
  // Modal 本体：oc-bg 88% 透明 + backdrop blur 20px saturate 180%（磨砂玻璃感）
  // 边框：oc-border-strong 高亮边框，配高光 inset
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 lingxia-msg-fade"
      style={{
        background: "rgba(0, 0, 0, 0.42)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onMouseDown={(e) => {
        // 仅当 mousedown 起点就在遮罩本身（不是 textarea 内部被拖出来的）时，才认为是"点遮罩关闭"的意图
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // target===currentTarget 意味着 click 命中遮罩本身（而不是冒泡上来）
        // overlayMouseDownRef 保证按下也在遮罩——拖拽选字时不会误关
        if (e.target === e.currentTarget && overlayMouseDownRef.current && !submitting) {
          onClose();
        }
        overlayMouseDownRef.current = false;
      }}
    >
      <div
        className="w-full max-w-2xl flex flex-col"
        style={{
          maxHeight: "85vh",
          background: "color-mix(in oklab, var(--oc-bg, #fff) 88%, transparent)",
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          border: "1px solid var(--oc-border-strong, rgba(255,255,255,0.18))",
          borderRadius: "var(--oc-radius-lg, 14px)",
          boxShadow: "0 32px 80px -12px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.08)",
          color: "var(--oc-text-primary)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: "1px solid var(--oc-border)" }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center"
              style={{
                width: 28, height: 28, borderRadius: 8,
                background: "color-mix(in oklab, var(--oc-accent, #6366f1) 18%, transparent)",
                border: "1px solid color-mix(in oklab, var(--oc-accent, #6366f1) 32%, transparent)",
              }}
            >
              <Send size={14} style={{ color: "var(--oc-accent, #6366f1)" }} />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--oc-text-primary)" }}>提交协作结果</div>
              {coopTitle ? <div className="text-[11px]" style={{ color: "var(--oc-text-secondary)" }}>{coopTitle}</div> : null}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 rounded transition-colors"
            style={{ background: "transparent" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--oc-bg-hover, rgba(0,0,0,0.05))")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <X size={15} style={{ color: "var(--oc-text-secondary)" }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 子任务（只读） */}
          <div>
            <div className="text-[11px] font-medium mb-1.5 flex items-center gap-1.5" style={{ color: "var(--oc-text-secondary)" }}>
              <FileText size={11} /> 你接到的子任务
            </div>
            <div
              className="text-xs whitespace-pre-wrap rounded-md px-3 py-2"
              style={{
                color: "var(--oc-text-primary)",
                background: "color-mix(in oklab, var(--oc-card, #f8fafc) 70%, transparent)",
                border: "1px solid var(--oc-border)",
                maxHeight: 80,
                overflowY: "auto",
              }}
            >
              {subtask || "—"}
            </div>
          </div>

          {/* 文本结果 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[11px] font-medium" style={{ color: "var(--oc-text-secondary)" }}>提交内容</div>
              <button
                type="button"
                onClick={regenDraft}
                disabled={submitting}
                title={hasUsableDraft ? "拼接最后 2 段 AI 输出作为草稿" : "还没 AI 输出，请先跟虾对话"}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-all"
                style={{
                  background: hasUsableDraft
                    ? "color-mix(in oklab, var(--oc-accent, #6366f1) 12%, transparent)"
                    : "var(--oc-bg-hover, rgba(0,0,0,0.04))",
                  border: "1px solid " + (hasUsableDraft
                    ? "color-mix(in oklab, var(--oc-accent, #6366f1) 30%, transparent)"
                    : "var(--oc-border)"),
                  color: hasUsableDraft ? "var(--oc-accent, #6366f1)" : "var(--oc-text-tertiary)",
                  opacity: submitting ? 0.5 : 1,
                  cursor: submitting ? "not-allowed" : "pointer",
                }}
              >
                <Sparkles size={11} /> 重新生成草稿
              </button>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="可手填或点上方'重新生成草稿'从对话抓取 AI 输出..."
              className="w-full text-sm rounded-md px-3 py-2 resize-none focus:outline-none transition-colors"
              style={{
                color: "var(--oc-text-primary)",
                background: "color-mix(in oklab, var(--oc-card, #fff) 80%, transparent)",
                border: "1px solid var(--oc-border)",
                minHeight: 160,
                maxHeight: 260,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--oc-accent, #6366f1)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--oc-border)")}
              disabled={submitting}
            />
            <div className="text-[10px] mt-1" style={{ color: "var(--oc-text-tertiary)" }}>
              {text.length} 字
            </div>
          </div>

          {/* 附件 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: "var(--oc-text-secondary)" }}>
                <Paperclip size={11} /> 附件 <span style={{ color: "var(--oc-text-tertiary)" }}>({selectedUrls.size}/{allFiles.length} 已勾选)</span>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={submitting || uploading}
                title={`从本地上传文件（最大 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-all"
                style={{
                  background: "color-mix(in oklab, var(--oc-accent, #6366f1) 12%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--oc-accent, #6366f1) 30%, transparent)",
                  color: "var(--oc-accent, #6366f1)",
                  opacity: submitting || uploading ? 0.5 : 1,
                  cursor: submitting || uploading ? "not-allowed" : "pointer",
                }}
              >
                {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                {uploading ? "上传中..." : "上传文件"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFilePicked}
                style={{ display: "none" }}
                disabled={submitting || uploading}
              />
            </div>
            {allFiles.length === 0 ? (
              <div
                className="text-[11px] rounded-md px-3 py-2 text-center"
                style={{
                  color: "var(--oc-text-tertiary)",
                  background: "color-mix(in oklab, var(--oc-card, #f8fafc) 60%, transparent)",
                  border: "1px dashed var(--oc-border)",
                }}
              >
                本次对话还没产生文件，也可以点右上角「上传文件」从本地附加（PDF/PPT/图片等任意类型）
              </div>
            ) : (
              <div
                className="rounded-md overflow-hidden"
                style={{
                  border: "1px solid var(--oc-border)",
                  background: "color-mix(in oklab, var(--oc-card, #fff) 70%, transparent)",
                  maxHeight: 160,
                  overflowY: "auto",
                }}
              >
                {allFiles.map((f, i) => {
                  const isUploaded = uploadedFiles.some((u) => u.url === f.url);
                  return (
                    <label
                      key={f.url}
                      className="flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors"
                      style={{
                        borderBottom: i < allFiles.length - 1 ? "1px solid var(--oc-border)" : "none",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--oc-bg-hover, rgba(0,0,0,0.03))")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <input
                        type="checkbox"
                        checked={selectedUrls.has(f.url)}
                        onChange={() => toggleFile(f.url)}
                        disabled={submitting}
                        style={{ accentColor: "var(--oc-accent, #6366f1)" }}
                      />
                      <FileText size={12} style={{ color: "var(--oc-accent, #6366f1)", flexShrink: 0 }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate" style={{ color: "var(--oc-text-primary)" }} title={f.name}>
                          {f.name}
                          {f.size ? <span className="ml-1.5 text-[10px]" style={{ color: "var(--oc-text-tertiary)" }}>{formatSize(f.size)}</span> : null}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: "var(--oc-text-tertiary)" }}>
                          {isUploaded ? "📎 我上传的" : f.source === "task" ? "🤖 task 产物" : "💬 本会话"} · {f.url.slice(0, 56)}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{
            borderTop: "1px solid var(--oc-border)",
            background: "color-mix(in oklab, var(--oc-card, #f8fafc) 30%, transparent)",
            borderRadius: "0 0 var(--oc-radius-lg, 14px) var(--oc-radius-lg, 14px)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-1.5 text-sm rounded-md transition-colors"
            style={{
              background: "transparent",
              border: "1px solid var(--oc-border)",
              color: "var(--oc-text-secondary)",
              opacity: submitting ? 0.5 : 1,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => { if (!submitting) e.currentTarget.style.background = "var(--oc-bg-hover, rgba(0,0,0,0.04))"; }}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canSubmit || submitting}
            className="inline-flex items-center px-4 py-1.5 text-sm rounded-md font-medium transition-all"
            style={{
              background: canSubmit && !submitting
                ? "linear-gradient(180deg, var(--oc-accent, #6366f1) 0%, color-mix(in oklab, var(--oc-accent, #6366f1) 88%, black) 100%)"
                : "var(--oc-bg-hover, rgba(0,0,0,0.06))",
              border: "1px solid " + (canSubmit && !submitting
                ? "color-mix(in oklab, var(--oc-accent, #6366f1) 70%, black)"
                : "var(--oc-border)"),
              color: canSubmit && !submitting ? "#fff" : "var(--oc-text-tertiary)",
              cursor: canSubmit && !submitting ? "pointer" : "not-allowed",
              boxShadow: canSubmit && !submitting ? "0 4px 12px color-mix(in oklab, var(--oc-accent, #6366f1) 25%, transparent)" : "none",
            }}
          >
            {submitting ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <Send size={13} className="mr-1.5" />}
            提交结果
          </button>
        </div>
      </div>
    </div>
  );
}
