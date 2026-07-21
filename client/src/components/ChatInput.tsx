import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { FileText, Mic, Paperclip, Upload, X } from "lucide-react";
import { prepareChatAttachments } from "@/lib/image-compress";

type MentionUser = {
  userId: number;
  userName: string;
  groupName: string | null;
  orgName: string | null;
  departmentName: string | null;
  teamName: string | null;
  adoptId: string | null;
};

type ChatInputProps = {
  value: string;
  onChange: (v: string) => void;
  onSend: (attachments?: File[]) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  onNewChat?: () => void;
  disabled?: boolean;
  streaming?: boolean;
  placeholder?: string;
  maxLength?: number;
  onUserMention?: (user: MentionUser) => void;
  leftControls?: ReactNode;
  rightControls?: ReactNode;
  interactionPanel?: ReactNode;
  canSubmitWithoutContent?: boolean;
  renderAddMenu?: (context: { openFilePicker: () => void; disabled: boolean }) => ReactNode;
  voiceOnRight?: boolean;
  historyStorageKey?: string;
  showUtilityButtons?: boolean;
};

const MAX_INPUT_HISTORY = 30;

type AttachmentChipProps = {
  file: File;
  index: number;
  onRemove: (index: number) => void;
};

function AttachmentChip({ file, index, onRemove }: AttachmentChipProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith("image/");

  useEffect(() => {
    if (!isImage) {
      setThumbUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className={`lingxia-attachment-chip ${isImage ? "is-image" : ""}`}>
      {thumbUrl ? (
        <img className="lingxia-attachment-thumb" src={thumbUrl} alt={file.name} />
      ) : (
        <span className="lingxia-attachment-file-icon" aria-hidden="true">
          <FileText size={14} strokeWidth={2} />
        </span>
      )}
      <span className="lingxia-attachment-name" title={file.name}>
        {file.name}
      </span>
      <button
        type="button"
        className="lingxia-attachment-remove"
        onClick={() => onRemove(index)}
        aria-label={`移除 ${file.name}`}
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

function resizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 144) + "px";
}

function normalizeInputHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const next: string[] = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text || next.includes(text)) continue;
    next.push(text.slice(0, 4000));
    if (next.length >= MAX_INPUT_HISTORY) break;
  }
  return next;
}

export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  onNewChat,
  disabled = false,
  streaming = false,
  placeholder = "Message…",
  maxLength = 4000,
  onUserMention,
  leftControls,
  rightControls,
  interactionPanel,
  canSubmitWithoutContent = false,
  renderAddMenu,
  voiceOnRight = false,
  historyStorageKey,
  showUtilityButtons = true,
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCounterRef = useRef(0);
  const inputHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number | null>(null);
  const draftBeforeHistoryRef = useRef("");
  const previousStreamingRef = useRef(streaming);
  const composingRef = useRef(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submittingAttachments, setSubmittingAttachments] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // ── 语音录制状态 ──
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ── @mention 状态 ──
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionAtPos, setMentionAtPos] = useState<number>(-1); // @ 的位置
  const [users, setUsers] = useState<MentionUser[]>([]);
  const usersLoadedRef = useRef(false);

  const loadUsers = useCallback(async () => {
    if (usersLoadedRef.current) return;
    usersLoadedRef.current = true;
    try {
      // tRPC query 的 REST 调用形式
      const input = encodeURIComponent(JSON.stringify({ json: { limit: 100 } }));
      const r = await fetch(`/api/trpc/coop.mentionCandidates?input=${input}`, { credentials: "include" });
      if (!r.ok) {
        usersLoadedRef.current = false;
        return;
      }
      const payload = await r.json();
      // superjson 格式：payload.result.data.json 是实际返回
      const data = payload?.result?.data?.json || [];
      const list: MentionUser[] = (data || []).map((u: any) => ({
        userId: u.userId,
        userName: u.userName || "(未命名)",
        groupName: u.groupName,
        orgName: u.orgName,
        departmentName: u.departmentName,
        teamName: u.teamName,
        adoptId: u.adoptId,
      }));
      setUsers(list);
    } catch {
      usersLoadedRef.current = false;
    }
  }, []);

  // 过滤匹配
  const filteredUsers = mentionOpen
    ? users.filter((u) => {
        if (!mentionQuery) return true;
        const q = mentionQuery.toLowerCase();
        return (
          (u.userName || "").toLowerCase().includes(q) ||
          (u.groupName || "").toLowerCase().includes(q) ||
          (u.orgName || "").toLowerCase().includes(q) ||
          (u.departmentName || "").toLowerCase().includes(q) ||
          (u.teamName || "").toLowerCase().includes(q)
        );
      }).slice(0, 20)
    : [];

  const formatMentionOrg = (u: MentionUser) => {
    const parts = [u.orgName, u.departmentName, u.teamName].filter(Boolean);
    if (parts.length > 0) return parts.join(" · ");
    return u.groupName ? `— · ${u.groupName}` : "—";
  };

  // 检测输入中的 @ 触发
  const detectMention = useCallback((text: string, cursor: number) => {
    // 往回找最近的 @
    let atIdx = -1;
    for (let i = cursor - 1; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === "@") { atIdx = i; break; }
      // 允许：中英文、数字、下划线、连字符、点
      if (!/[\w\u4e00-\u9fa5\-·]/.test(ch)) break;
    }
    if (atIdx < 0) {
      setMentionOpen(false);
      return;
    }
    // @ 前一字符必须是行首/空白
    const prev = atIdx === 0 ? " " : text[atIdx - 1];
    if (!/\s|^$/.test(prev) && atIdx !== 0) {
      setMentionOpen(false);
      return;
    }
    const query = text.slice(atIdx + 1, cursor);
    setMentionAtPos(atIdx);
    setMentionQuery((prev) => {
      if (prev !== query) setMentionIndex(0);
      return query;
    });
    setMentionOpen(true);
    loadUsers();
  }, [loadUsers]);

  const selectMention = useCallback((u: MentionUser) => {
    // 插入 @用户名 标签，并告知父级（父级在发送时触发协作）
    const before = value.slice(0, mentionAtPos);
    const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
    onChange(before + `@${u.userName} ` + after);
    onUserMention?.(u);
    setMentionOpen(false);
    // 聚焦回输入框
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [value, mentionAtPos, onChange, onUserMention]);

  const pushInputHistory = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const current = inputHistoryRef.current;
    const next = [clean, ...current.filter((item) => item !== clean)].slice(0, MAX_INPUT_HISTORY);
    inputHistoryRef.current = next;
    if (historyStorageKey) {
      try {
        localStorage.setItem(historyStorageKey, JSON.stringify(next));
      } catch {}
    }
    historyCursorRef.current = null;
    draftBeforeHistoryRef.current = "";
  }, [historyStorageKey]);

  const applyHistoryText = useCallback((text: string) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }, [onChange]);

  const submitMessage = useCallback(async () => {
    if (streaming) {
      onStop?.();
      return;
    }
    if (disabled || submittingAttachments) return;
    if (!canSubmitWithoutContent && !value.trim() && attachments.length === 0) return;

    const selectedAttachments = [...attachments];
    setSubmittingAttachments(true);
    try {
      const result = await onSend(selectedAttachments);
      if (result !== false) {
        pushInputHistory(value);
        setAttachments([]);
      }
    } finally {
      setSubmittingAttachments(false);
    }
  }, [attachments, canSubmitWithoutContent, disabled, onSend, onStop, pushInputHistory, streaming, submittingAttachments, value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (mentionOpen && filteredUsers.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % filteredUsers.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + filteredUsers.length) % filteredUsers.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(filteredUsers[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (!mentionOpen && !value.includes("\n") && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const history = inputHistoryRef.current;
      if (history.length > 0 || historyCursorRef.current !== null) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (historyCursorRef.current === null) {
            draftBeforeHistoryRef.current = value;
            historyCursorRef.current = 0;
          } else {
            historyCursorRef.current = Math.min(historyCursorRef.current + 1, history.length - 1);
          }
          applyHistoryText(history[historyCursorRef.current] || "");
          return;
        }
        if (e.key === "ArrowDown" && historyCursorRef.current !== null) {
          e.preventDefault();
          const nextCursor = historyCursorRef.current - 1;
          if (nextCursor < 0) {
            historyCursorRef.current = null;
            applyHistoryText(draftBeforeHistoryRef.current);
            draftBeforeHistoryRef.current = "";
          } else {
            historyCursorRef.current = nextCursor;
            applyHistoryText(history[nextCursor] || "");
          }
          return;
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  };

  const appendPreparedAttachments = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setSubmittingAttachments(true);
    try {
      const prepared = await prepareChatAttachments(files);
      setAttachments(prev => [...prev, ...prepared]);
    } finally {
      setSubmittingAttachments(false);
    }
  }, []);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await appendPreparedAttachments(files);
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    await appendPreparedAttachments(files);
  };

  const hasDraggedFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types || []).includes("Files");

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = submittingAttachments ? "none" : "copy";
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    if (submittingAttachments) return;
    await appendPreparedAttachments(Array.from(e.dataTransfer.files || []));
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // ── 语音录制 ──
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        if (audioBlob.size < 100) return;

        setTranscribing(true);
        try {
          const res = await fetch("/api/claw/voice/transcribe", {
            method: "POST",
            headers: { "Content-Type": mimeType },
            body: audioBlob,
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert("语音识别失败：" + (err.error || res.status));
            return;
          }
          const data = await res.json();
          if (data.text) {
            onChange(value + (value && !value.endsWith(" ") && !value.endsWith("\n") ? " " : "") + data.text);
            textareaRef.current?.focus();
          }
        } catch (err) {
          alert("语音识别出错：" + String(err));
        } finally {
          setTranscribing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        alert("请允许麦克风权限");
      } else {
        alert("无法启动录音：" + err.message);
      }
    }
  }, [value, onChange]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  const toggleRecording = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  // mentionIndex 变化时，把当前高亮项滚入可视区（修复键盘 ↑↓ 翻不到列表底部的问题）
  useEffect(() => {
    if (!mentionOpen) return;
    const el = document.querySelector(`[data-mention-idx="${mentionIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionOpen]);

  // 点击外部关闭 @mention
  useEffect(() => {
    if (!mentionOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const ta = textareaRef.current;
      if (ta && e.target instanceof Node && ta.contains(e.target)) return;
      setMentionOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [mentionOpen]);

  useEffect(() => {
    if (previousStreamingRef.current && !streaming) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    previousStreamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    historyCursorRef.current = null;
    draftBeforeHistoryRef.current = "";
    if (!historyStorageKey) {
      inputHistoryRef.current = [];
      return;
    }
    try {
      inputHistoryRef.current = normalizeInputHistory(JSON.parse(localStorage.getItem(historyStorageKey) || "[]"));
    } catch {
      inputHistoryRef.current = [];
    }
  }, [historyStorageKey]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || recording || transcribing) return;
    resizeTextarea(el);
  }, [recording, transcribing, value]);

  const attachmentControlDisabled = streaming || submittingAttachments;
  const voiceControl = (
    <button
      type="button"
      onClick={toggleRecording}
      title={recording ? "停止录音" : "语音输入"}
      aria-label={recording ? "停止录音" : "语音输入"}
      className={`lingxia-toolbar-icon ${recording ? "is-active" : ""}`}
      style={recording ? { color: "var(--oc-accent)" } : undefined}
      disabled={transcribing}
    >
      <Mic size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );

  return (
    <div
      className={`flex-none mb-4 mt-0 w-full max-w-[880px] mx-auto px-6 ${dragActive ? "is-drag-active" : ""}`}
      style={{ position: "relative" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => { void handleDrop(e); }}
    >
      {dragActive && (
        <div className="lingxia-drop-overlay" aria-hidden="true">
          <div className="lingxia-drop-overlay-inner">
            <span className="lingxia-drop-overlay-icon">
              <Upload size={15} strokeWidth={2.2} />
            </span>
            <span>松开即可添加附件</span>
          </div>
        </div>
      )}

      {/* @mention 浮层 */}
      {mentionOpen && filteredUsers.length > 0 && (
        <div
          className="lingxia-mention-overlay"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 24,
            right: 24,
            maxWidth: 420,
            background: "var(--oc-card)",
            border: "1px solid var(--oc-border)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
            padding: 4,
            zIndex: 50,
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          <div style={{ padding: "4px 10px 6px", fontSize: 10, color: "var(--oc-text-secondary)", opacity: 0.7, letterSpacing: "0.05em" }}>
            @ 选择协作伙伴 · ↑↓ 导航 · Enter 确认 · Esc 取消
          </div>
          {filteredUsers.map((u, i) => (
            <button
              key={u.userId}
              data-mention-idx={i}
              onMouseDown={(e) => { e.preventDefault(); selectMention(u); }}
              onMouseEnter={() => setMentionIndex(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 6,
                background: i === mentionIndex ? "var(--oc-bg-hover)" : "transparent",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                color: "var(--oc-text-primary)",
              }}
            >
              <span style={{
                width: 26, height: 26, borderRadius: "50%", background: "var(--oc-bg-hover)",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 600, flexShrink: 0, color: "var(--oc-text-primary)",
              }}>
                {(u.userName || "?").slice(0, 1)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--oc-text-primary)" }}>
                  {u.userName}
                </div>
                <div style={{ fontSize: 11, color: "var(--oc-text-secondary)", opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {formatMentionOrg(u)}
                </div>
              </div>
              {u.adoptId ? (
                <span style={{ fontSize: 10, color: "var(--oc-accent)", opacity: 0.8, fontFamily: "monospace" }}>🤖</span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {/* 主输入卡片 */}
      <div
        className={`lingxia-input-wrap main-chat-composer ${streaming ? "is-streaming" : ""}`}
        data-focused={inputFocused ? "true" : "false"}
        onMouseDown={() => setInputFocused(true)}
        onFocusCapture={() => setInputFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setInputFocused(false);
          }
        }}
        style={{
          background: "var(--oc-card)",
          border: recording
            ? "1px solid var(--oc-accent)"
            : inputFocused
              ? "1px solid color-mix(in oklab, var(--oc-accent) 34%, var(--oc-border-hover))"
              : "1px solid var(--oc-border)",
          outline: "none",
          outlineOffset: 0,
          borderRadius: 14,
          boxShadow: recording
            ? "0 0 0 2px rgba(255,92,92,0.2), 0 2px 16px rgba(0,0,0,0.14)"
            : inputFocused
              ? "0 0 0 1px rgba(255,255,255,0.16), 0 0 0 3px rgba(255,92,92,0.07), 0 2px 14px rgba(0,0,0,0.12)"
              : "0 2px 16px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.08)",
          overflow: "hidden",
          transition: "border-color 0.18s, box-shadow 0.18s, outline-color 0.18s",
        }}
      >
        {interactionPanel}

        {attachments.length > 0 && (
          <div className="lingxia-attachment-list lingxia-attachment-list--composer">
            {attachments.map((file, i) => (
              <AttachmentChip
                key={`${file.name}-${file.size}-${file.lastModified}-${i}`}
                file={file}
                index={i}
                onRemove={removeAttachment}
              />
            ))}
          </div>
        )}

        <div className="lingxia-composer-editor px-4 pt-3 pb-1">
          {recording ? (
            <div className="flex items-center gap-2" style={{ minHeight: 22, color: "var(--oc-accent)" }}>
              <span className="animate-pulse" style={{ fontSize: 14 }}>●</span>
              <span className="text-sm">正在录音… 点击麦克风停止</span>
            </div>
          ) : transcribing ? (
            <div className="flex items-center gap-2" style={{ minHeight: 22, color: "var(--oc-text-secondary)" }}>
              <span className="animate-spin" style={{ fontSize: "var(--oc-text-sm)" }}>◌</span>
              <span className="text-sm">识别中…</span>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v);
                // 检测 @
                const cursor = e.target.selectionStart ?? v.length;
                if (!composingRef.current) detectMention(v, cursor);
              }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={(e) => {
                composingRef.current = false;
                const ta = e.currentTarget;
                detectMention(ta.value, ta.selectionStart ?? ta.value.length);
              }}
              onKeyUp={(e) => {
                // 导航键不触发重检测，避免重置高亮
                if (mentionOpen && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab", "Escape"].includes(e.key)) return;
                const ta = e.currentTarget;
                detectMention(ta.value, ta.selectionStart ?? ta.value.length);
              }}
              onClick={(e) => {
                const ta = e.currentTarget;
                detectMention(ta.value, ta.selectionStart ?? ta.value.length);
              }}
              onFocus={() => setInputFocused(true)}
              onKeyDown={onKeyDown}
              onPaste={(e) => { void handlePaste(e); }}
              placeholder={placeholder}
              rows={1}
              className="main-chat-input w-full bg-transparent text-sm resize-none outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
              style={{
                color: "var(--oc-text-primary)",
                lineHeight: "24px",
                minHeight: 28,
                maxHeight: 144,
                overflowY: "auto",
                display: "block",
                border: "none",
                outline: "none",
                padding: "2px 0",
                boxShadow: "none",
                WebkitAppearance: "none",
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <div className="flex items-center gap-1">
            <input ref={fileInputRef} type="file" multiple
              accept="image/*,.pdf,.txt,.md,.csv,.json,.docx,.xls,.xlsx"
              onChange={handleFileSelect} style={{ display: "none" }} />
            {renderAddMenu ? renderAddMenu({
              openFilePicker: () => fileInputRef.current?.click(),
              disabled: attachmentControlDisabled,
            }) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="上传文件"
                aria-label="上传文件"
                className="lingxia-toolbar-icon"
                disabled={attachmentControlDisabled}
              >
                <Paperclip size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            {!voiceOnRight ? voiceControl : null}
            {leftControls}
          </div>

          <div className="flex items-center gap-1">
            {rightControls}
            {voiceOnRight ? voiceControl : null}
            {showUtilityButtons ? (
              <button type="button" onClick={onNewChat} title="新对话" aria-label="新对话" className="lingxia-toolbar-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            ) : null}
            <button
              onClick={() => void submitMessage()}
              disabled={streaming ? false : (disabled || submittingAttachments || (!canSubmitWithoutContent && !value.trim() && attachments.length === 0))}
              title={streaming ? "停止生成" : submittingAttachments ? "上传中" : "发送"}
              className="lingxia-send-btn"
              style={{
                background: (streaming || canSubmitWithoutContent || value.trim() || attachments.length > 0) ? "var(--oc-accent)" : "rgba(128,128,128,0.2)",
              }}
            >
              {streaming ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <rect x="6" y="6" width="12" height="12" rx="2"/>
                </svg>
              ) : submittingAttachments ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 3v10"/>
                  <path d="M8 7l4-4 4 4"/>
                  <path d="M5 17h14"/>
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-center px-1 text-center">
        <p className="text-[10px]" style={{ color: "var(--oc-text-secondary)", opacity: 0.62 }}>
          内容由 AI 生成，请核实重要信息
        </p>
      </div>
    </div>
  );
}
