import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Clipboard, Download, FileText, History, Mic2, Pencil, Plus, Send, Square, Trash2, Upload, Wand2, X } from "lucide-react";

type MeetingNotesPageProps = {
  adoptId: string;
  onBack?: () => void;
};

const MIN_RECORD_SECONDS = 5;
const MEETING_TYPES = [
  { value: "general", label: "普通会议" },
  { value: "project", label: "项目例会" },
  { value: "client", label: "客户拜访" },
  { value: "training", label: "培训纪要" },
  { value: "assignment", label: "领导交办" },
  { value: "sales", label: "销售跟进" },
  { value: "weekly", label: "周会纪要" },
  { value: "interview", label: "面试纪要" },
];
const QUICK_ACTIONS = [
  "提取我的待办事项",
  "生成发给领导的简版",
  "生成微信群简版",
  "生成邮件版纪要",
  "生成周报素材",
  "生成 PPT 大纲",
  "整理风险清单",
];
const ACCEPTED_AUDIO_TYPES = ".mp3,.wav,.m4a,.aac,.webm,.ogg,audio/*";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type MeetingFollowup = {
  id: string;
  createdAt: string;
  question: string;
  answer: string;
  outputPath?: string;
  outputUrl?: string;
};

type MeetingRecord = {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  audioPath?: string;
  transcriptPath?: string;
  summaryPath?: string;
  audioUrl?: string;
  transcriptUrl?: string;
  summaryUrl?: string;
  meetingDir?: string;
  metaPath?: string;
  transcript: string;
  summary: string;
  meetingType?: string;
  meetingTypeLabel?: string;
  actionItemsCount?: number;
  followups?: MeetingFollowup[];
};

type RecordingState = "idle" | "recording" | "uploading" | "processing" | "error";
type FollowupState = "idle" | "asking" | "error";

function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function buildMarkdown(record: Pick<MeetingRecord, "title" | "createdAt" | "durationSec" | "summary" | "transcript">) {
  return [
    `# ${record.title}`,
    "",
    `- 时间：${new Date(record.createdAt).toLocaleString()}`,
    `- 时长：${formatDuration(record.durationSec)}`,
    "",
    "## 会议纪要",
    "",
    record.summary || "暂无纪要",
    "",
    "## 原始转写",
    "",
    record.transcript || "暂无转写",
    "",
  ].join("\n");
}

export function MeetingNotesPage({ adoptId, onBack }: MeetingNotesPageProps) {
  const canRecord = typeof window !== "undefined" && window.isSecureContext;
  const [status, setStatus] = useState<RecordingState>("idle");
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [current, setCurrent] = useState<MeetingRecord | null>(null);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [meetingType, setMeetingType] = useState("general");
  const [historyQuery, setHistoryQuery] = useState("");
  const [followupInput, setFollowupInput] = useState("");
  const [followupStatus, setFollowupStatus] = useState<FollowupState>("idle");
  const [followupError, setFollowupError] = useState("");
  const [managingFollowupId, setManagingFollowupId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const followupInputRef = useRef<HTMLTextAreaElement | null>(null);

  const currentTitle = useMemo(() => {
    if (current?.title) return current.title;
    if (!startedAt) return "新会议纪要";
    return `${new Date(startedAt).toLocaleString()} 会议纪要`;
  }, [current?.title, startedAt]);

  const filteredMeetings = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter((item) => [
      item.title,
      item.meetingTypeLabel,
      item.summary,
      item.transcript,
      item.createdAt,
    ].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [historyQuery, meetings]);

  const loadMeetings = useCallback(async () => {
    if (!adoptId) return;
    try {
      const resp = await fetch(`/api/claw/meeting-notes/list?adoptId=${encodeURIComponent(adoptId)}`, { credentials: "include" });
      if (!resp.ok) return;
      const data = await resp.json();
      const records = Array.isArray(data.records) ? data.records : [];
      setMeetings(records);
      if (!current && records.length > 0) setCurrent(records[0]);
    } catch {}
  }, [adoptId, current]);

  useEffect(() => {
    void loadMeetings();
  }, [loadMeetings]);

  useEffect(() => {
    if (!startedAt || status !== "recording") return;
    const timer = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, status]);

  const stopTracks = useCallback(() => {
    try { streamRef.current?.getTracks().forEach((track) => track.stop()); } catch {}
    streamRef.current = null;
  }, []);

  const processRecording = useCallback(async (blob: Blob, durationSec: number, meetingStartedAt: number) => {
    setStatus("uploading");
    setError("");
    try {
      setStatus("processing");
      const meetingId = `${meetingStartedAt}-${Math.random().toString(16).slice(2)}`;
      const resp = await fetch(`/api/claw/meeting-notes/process?adoptId=${encodeURIComponent(adoptId)}&meetingId=${encodeURIComponent(meetingId)}&duration=${durationSec}&meetingType=${encodeURIComponent(meetingType)}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": blob.type || "audio/webm",
          "X-Meeting-Duration": String(durationSec),
          "X-Meeting-Type": meetingType,
        },
        body: blob,
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        throw new Error(payload.error || `会议纪要生成失败 (${resp.status})`);
      }
      const payload = await resp.json();
      const record = payload.record as MeetingRecord;
      setCurrent(record);
      setMeetings((prev) => [record, ...prev.filter((item) => item.id !== record.id)].slice(0, 100));
      setStatus("idle");
      void loadMeetings();
    } catch (err: any) {
      setError(err?.message || String(err));
      setStatus("error");
    }
  }, [adoptId, loadMeetings, meetingType]);

  const handleUploadAudio = useCallback(async (file: File) => {
    if (status === "uploading" || status === "processing" || status === "recording") return;
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("录音文件过大，请上传 50MB 以内的音频文件。");
      setStatus("error");
      return;
    }
    setCurrent(null);
    setStartedAt(Date.now());
    setElapsedSec(0);
    await processRecording(file, 0, Date.now());
  }, [processRecording, status]);

  const startRecording = useCallback(async () => {
    if (!canRecord) {
      setError("浏览器录音需要 HTTPS，请使用 HTTPS 域名打开。");
      setStatus("error");
      return;
    }
    setError("");
    setCurrent(null);
    setElapsedSec(0);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      const startMs = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const duration = Math.max(1, Math.floor((Date.now() - startMs) / 1000));
        void processRecording(blob, duration, startMs);
      };
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      setStartedAt(startMs);
      setStatus("recording");
      recorder.start(1000);
    } catch (err: any) {
      stopTracks();
      setError(err?.name === "NotAllowedError" ? "请允许麦克风权限" : (err?.message || "无法启动录音"));
      setStatus("error");
    }
  }, [canRecord, processRecording, stopTracks]);

  const stopRecording = useCallback(() => {
    if (startedAt && Date.now() - startedAt < MIN_RECORD_SECONDS * 1000) {
      setError(`请至少录制 ${MIN_RECORD_SECONDS} 秒后再生成会议纪要。`);
      return;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, [startedAt]);

  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      } catch {}
      stopTracks();
    };
  }, [stopTracks]);

  const copyCurrent = useCallback(async () => {
    if (!current) return;
    await navigator.clipboard.writeText(buildMarkdown(current));
  }, [current]);

  const downloadCurrent = useCallback(() => {
    if (!current) return;
    const text = buildMarkdown(current);
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${current.title.replace(/[\\/:*?"<>|]/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [current]);

  const askMeeting = useCallback(async (question: string) => {
    const text = question.trim();
    if (!current || !text || followupStatus === "asking") return;
    setFollowupStatus("asking");
    setFollowupError("");
    try {
      const resp = await fetch(`/api/claw/meeting-notes/ask?adoptId=${encodeURIComponent(adoptId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: current.id, question: text }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        throw new Error(payload.error || `会议处理失败 (${resp.status})`);
      }
      const payload = await resp.json();
      const followup = payload.followup as MeetingFollowup;
      const nextCurrent = {
        ...current,
        followups: [followup, ...(current.followups || [])].slice(0, 50),
      };
      setCurrent(nextCurrent);
      setMeetings((prev) => prev.map((item) => item.id === current.id ? nextCurrent : item));
      setFollowupInput("");
      setFollowupStatus("idle");
      void loadMeetings();
    } catch (err: any) {
      setFollowupError(err?.message || String(err));
      setFollowupStatus("error");
    }
  }, [adoptId, current, followupStatus, loadMeetings]);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
  }, []);

  const busy = status === "uploading" || status === "processing";
  const recording = status === "recording";
  const asking = followupStatus === "asking";

  const replaceMeetingRecord = useCallback((record: MeetingRecord) => {
    setCurrent(record);
    setMeetings((prev) => prev.map((item) => item.id === record.id ? record : item));
  }, []);

  const startNewMeeting = useCallback(() => {
    if (recording || busy) return;
    setCurrent(null);
    setStartedAt(null);
    setElapsedSec(0);
    setStatus("idle");
    setError("");
    setFollowupInput("");
    setFollowupError("");
    setFollowupStatus("idle");
  }, [busy, recording]);

  const selectMeeting = useCallback((item: MeetingRecord) => {
    setCurrent(item);
    setMeetingType(item.meetingType || "general");
    setStartedAt(new Date(item.createdAt).getTime());
    setElapsedSec(item.durationSec || 0);
    setStatus("idle");
    setError("");
    setFollowupInput("");
    setFollowupError("");
    setHistoryOpen(false);
  }, []);

  const useQuickAction = useCallback((action: string) => {
    if (!current || asking) return;
    setFollowupInput(action);
    window.setTimeout(() => followupInputRef.current?.focus(), 0);
  }, [asking, current]);

  const renameFollowup = useCallback(async (followup: MeetingFollowup) => {
    if (!current || managingFollowupId) return;
    const currentName = followup.outputPath?.split("/").pop()?.replace(/\.md$/i, "") || followup.question;
    const name = window.prompt("新的文件名", currentName);
    if (!name?.trim()) return;
    setManagingFollowupId(followup.id);
    setFollowupError("");
    try {
      const resp = await fetch(`/api/claw/meeting-notes/followup/rename?adoptId=${encodeURIComponent(adoptId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: current.id, followupId: followup.id, name: name.trim() }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        throw new Error(payload.error || `重命名失败 (${resp.status})`);
      }
      const payload = await resp.json();
      replaceMeetingRecord(payload.record as MeetingRecord);
      void loadMeetings();
    } catch (err: any) {
      setFollowupError(err?.message || String(err));
    } finally {
      setManagingFollowupId(null);
    }
  }, [adoptId, current, loadMeetings, managingFollowupId, replaceMeetingRecord]);

  const deleteFollowup = useCallback(async (followup: MeetingFollowup) => {
    if (!current || managingFollowupId) return;
    if (!window.confirm("删除这条派生结果及其文件？")) return;
    setManagingFollowupId(followup.id);
    setFollowupError("");
    try {
      const resp = await fetch(`/api/claw/meeting-notes/followup/delete?adoptId=${encodeURIComponent(adoptId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: current.id, followupId: followup.id }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        throw new Error(payload.error || `删除失败 (${resp.status})`);
      }
      const payload = await resp.json();
      replaceMeetingRecord(payload.record as MeetingRecord);
      void loadMeetings();
    } catch (err: any) {
      setFollowupError(err?.message || String(err));
    } finally {
      setManagingFollowupId(null);
    }
  }, [adoptId, current, loadMeetings, managingFollowupId, replaceMeetingRecord]);

  return (
    <main className="h-full min-h-0 overflow-y-auto stealth-scrollbar" style={{ background: "var(--oc-bg)", color: "var(--oc-text-primary)" }}>
      <div className="max-w-6xl mx-auto px-5 py-5 space-y-4">
        <section className="settings-card" style={{ padding: 18 }}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {onBack ? (
                  <button
                    type="button"
                    onClick={onBack}
                    title="返回上一页"
                    className="inline-flex items-center justify-center rounded-md p-1.5"
                    style={{ color: "var(--oc-text-secondary)", border: "1px solid var(--oc-border)", background: "var(--oc-panel)" }}
                  >
                    <ArrowLeft size={15} />
                  </button>
                ) : null}
                <Mic2 size={18} style={{ color: "var(--oc-accent)" }} />
                <h2 className="text-base font-semibold" style={{ color: "var(--oc-text-primary)" }}>会议纪要</h2>
              </div>
              <p className="mt-2 text-sm leading-6" style={{ color: "var(--oc-text-secondary)" }}>
                录音结束后上传到当前工作空间，完成 ASR 转写，再用独立 OpenClaw 会话生成纪要。
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={startNewMeeting}
                disabled={recording || busy}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm"
                style={{
                  background: "var(--oc-panel)",
                  border: "1px solid var(--oc-border)",
                  color: recording || busy ? "var(--oc-text-tertiary)" : "var(--oc-text-secondary)",
                  cursor: recording || busy ? "not-allowed" : "pointer",
                }}
              >
                <Plus size={15} />
                新会议
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm"
                style={{ background: "var(--oc-panel)", border: "1px solid var(--oc-border)", color: "var(--oc-text-secondary)" }}
              >
                <History size={15} />
                历史
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <select
              value={meetingType}
              onChange={(event) => setMeetingType(event.target.value)}
              disabled={recording || busy}
              className="rounded-md px-3 py-2 text-sm"
              style={{
                background: "var(--oc-panel)",
                border: "1px solid var(--oc-border)",
                color: "var(--oc-text-primary)",
                opacity: recording || busy ? 0.6 : 1,
              }}
              title="会议类型模板"
            >
              {MEETING_TYPES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            {!recording ? (
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={!canRecord || busy}
                title={canRecord ? "开始会议录音" : "需要 HTTPS 才能录音"}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
                style={{
                  background: "color-mix(in oklab, var(--oc-accent) 16%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--oc-accent) 28%, var(--oc-border))",
                  color: "var(--oc-accent)",
                  opacity: !canRecord || busy ? 0.55 : 1,
                  cursor: !canRecord || busy ? "not-allowed" : "pointer",
                }}
              >
                <Mic2 size={15} />
                开始录音
              </button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                title={elapsedSec < MIN_RECORD_SECONDS ? `至少录制 ${MIN_RECORD_SECONDS} 秒` : "结束录音并生成会议纪要"}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
                style={{ background: "var(--oc-accent)", border: "1px solid var(--oc-accent)", color: "white" }}
              >
                <Square size={14} />
                结束并生成
              </button>
            )}
            <input
              ref={uploadInputRef}
              type="file"
              accept={ACCEPTED_AUDIO_TYPES}
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void handleUploadAudio(file);
              }}
            />
            <button
              type="button"
              onClick={() => uploadInputRef.current?.click()}
              disabled={recording || busy}
              title="上传录音文件生成纪要"
              className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
              style={{
                background: "var(--oc-panel)",
                border: "1px solid var(--oc-border)",
                color: recording || busy ? "var(--oc-text-tertiary)" : "var(--oc-text-secondary)",
                cursor: recording || busy ? "not-allowed" : "pointer",
              }}
            >
              <Upload size={15} />
              上传录音文件
            </button>
            <span className="text-sm font-mono" style={{ color: recording ? "var(--oc-accent)" : "var(--oc-text-secondary)" }}>
              {formatDuration(elapsedSec)}
            </span>
            <span className="text-xs" style={{ color: "var(--oc-text-tertiary)" }}>
              {status === "recording" ? (elapsedSec < MIN_RECORD_SECONDS ? `录音中，至少 ${MIN_RECORD_SECONDS} 秒` : "录音中") : status === "uploading" ? "上传录音中" : status === "processing" ? "转写并生成纪要中" : "空闲"}
            </span>
            {error ? <span className="text-xs" style={{ color: "var(--banking-danger)" }}>{error}</span> : null}
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="settings-card min-h-[420px]" style={{ padding: 18 }}>
            <div className="flex items-center gap-2 mb-4">
              <FileText size={16} style={{ color: "var(--oc-text-secondary)" }} />
              <h3 className="text-sm font-semibold" style={{ color: "var(--oc-text-primary)" }}>原始转写</h3>
            </div>
            <div
              className="rounded-md min-h-[330px] p-4 text-sm leading-7 whitespace-pre-wrap overflow-y-auto stealth-scrollbar"
              style={{
                background: "var(--oc-panel)",
                border: "1px solid var(--oc-border)",
                color: current?.transcript ? "var(--oc-text-primary)" : "var(--oc-text-tertiary)",
              }}
            >
              {busy ? "正在处理录音，请稍候..." : current?.transcript || "暂无转写"}
            </div>
            {current ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {current.audioUrl ? <a className="text-xs" style={{ color: "var(--oc-accent)" }} href={current.audioUrl}>录音文件</a> : null}
                {current.transcriptUrl ? <a className="text-xs" style={{ color: "var(--oc-accent)" }} href={current.transcriptUrl}>转写文件</a> : null}
              </div>
            ) : null}
          </div>

          <div className="settings-card min-h-[420px]" style={{ padding: 18 }}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Wand2 size={16} style={{ color: "var(--oc-text-secondary)" }} />
                  <h3 className="text-sm font-semibold truncate" style={{ color: "var(--oc-text-primary)" }}>AI 摘要</h3>
                </div>
                {current ? (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--oc-text-tertiary)" }}>
                    <span className="truncate">{currentTitle}</span>
                    <span>{current.meetingTypeLabel || "普通会议"}</span>
                    <span>{new Date(current.createdAt).toLocaleString()}</span>
                    <span>待办 {current.actionItemsCount ?? 0} 项</span>
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => void copyCurrent()} disabled={!current} title="复制" className="lingxia-toolbar-icon">
                  <Clipboard size={15} />
                </button>
                <button type="button" onClick={downloadCurrent} disabled={!current} title="下载 Markdown" className="lingxia-toolbar-icon">
                  <Download size={15} />
                </button>
              </div>
            </div>
            <div
              className="rounded-md min-h-[330px] p-4 text-sm leading-7 whitespace-pre-wrap overflow-y-auto stealth-scrollbar"
              style={{
                background: "var(--oc-panel)",
                border: "1px solid var(--oc-border)",
                color: current?.summary ? "var(--oc-text-primary)" : "var(--oc-text-tertiary)",
              }}
            >
              {busy ? "正在处理录音，请稍候..." : current?.summary || "录音结束后自动生成会议纪要"}
            </div>
            {current ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {current.summaryUrl ? <a className="text-xs" style={{ color: "var(--oc-accent)" }} href={current.summaryUrl}>纪要文件</a> : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="settings-card" style={{ padding: 18 }}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Wand2 size={16} style={{ color: "var(--oc-text-secondary)" }} />
              <h3 className="text-sm font-semibold" style={{ color: "var(--oc-text-primary)" }}>基于本次会议继续处理</h3>
            </div>
            {asking ? <span className="text-xs" style={{ color: "var(--oc-text-tertiary)" }}>处理中...</span> : null}
          </div>

          {current?.followups?.length ? (
            <div className="mb-4 space-y-3">
              {current.followups.slice().reverse().map((item) => (
                <div key={item.id} className="rounded-md p-3" style={{ background: "var(--oc-panel)", border: "1px solid var(--oc-border)" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs mb-1" style={{ color: "var(--oc-text-tertiary)" }}>
                        {new Date(item.createdAt).toLocaleString()}
                      </div>
                      <div className="text-sm font-medium" style={{ color: "var(--oc-text-primary)" }}>{item.question}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" title="复制回答" onClick={() => void copyText(item.answer)} className="lingxia-toolbar-icon">
                        <Clipboard size={14} />
                      </button>
                      {item.outputUrl ? (
                        <a title="下载结果文件" href={item.outputUrl} className="lingxia-toolbar-icon inline-flex items-center justify-center">
                          <Download size={14} />
                        </a>
                      ) : null}
                      {item.outputPath ? (
                        <button
                          type="button"
                          title="重命名文件"
                          disabled={managingFollowupId === item.id}
                          onClick={() => void renameFollowup(item)}
                          className="lingxia-toolbar-icon"
                        >
                          <Pencil size={14} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title="删除派生结果"
                        disabled={managingFollowupId === item.id}
                        onClick={() => void deleteFollowup(item)}
                        className="lingxia-toolbar-icon"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 text-sm leading-7 whitespace-pre-wrap" style={{ color: "var(--oc-text-primary)" }}>
                    {item.answer}
                  </div>
                  {item.outputUrl ? (
                    <div className="mt-3 text-xs truncate" style={{ color: "var(--oc-text-tertiary)" }}>
                      {item.outputPath?.split("/").pop() || "结果文件"}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 mb-3">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                disabled={!current || asking}
                onClick={() => useQuickAction(action)}
                className="rounded-md px-3 py-1.5 text-xs"
                style={{
                  background: "var(--oc-panel)",
                  border: "1px solid var(--oc-border)",
                  color: current && !asking ? "var(--oc-text-secondary)" : "var(--oc-text-tertiary)",
                  cursor: current && !asking ? "pointer" : "not-allowed",
                }}
              >
                {action}
              </button>
            ))}
          </div>

          <div
            className="sticky bottom-0 z-10 -mx-1 rounded-md p-1"
            style={{ background: "color-mix(in oklab, var(--oc-bg-surface) 92%, transparent)" }}
          >
          <div className="flex flex-col sm:flex-row gap-2">
            <textarea
              ref={followupInputRef}
              value={followupInput}
              onChange={(event) => setFollowupInput(event.target.value)}
              disabled={!current || asking}
              rows={2}
              placeholder={current ? "例如：帮我生成发给客户的跟进微信，或提取我负责的事项" : "先选择或生成一条会议纪要"}
              className="flex-1 rounded-md px-3 py-2 text-sm resize-none"
              style={{
                background: "var(--oc-panel)",
                border: "1px solid var(--oc-border)",
                color: "var(--oc-text-primary)",
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void askMeeting(followupInput);
                }
              }}
            />
            <button
              type="button"
              disabled={!current || !followupInput.trim() || asking}
              onClick={() => void askMeeting(followupInput)}
              className="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
              style={{
                background: "var(--oc-accent)",
                border: "1px solid var(--oc-accent)",
                color: "white",
                opacity: !current || !followupInput.trim() || asking ? 0.55 : 1,
                cursor: !current || !followupInput.trim() || asking ? "not-allowed" : "pointer",
              }}
            >
              <Send size={15} />
              发送
            </button>
          </div>
          </div>
          {followupError ? <div className="mt-2 text-xs" style={{ color: "var(--banking-danger)" }}>{followupError}</div> : null}
        </section>

      </div>
      {historyOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/35" onClick={() => setHistoryOpen(false)}>
          <aside
            className="h-full w-full max-w-[420px] overflow-y-auto p-4 shadow-xl stealth-scrollbar"
            style={{ background: "var(--oc-bg-surface)", borderLeft: "1px solid var(--oc-border)", color: "var(--oc-text-primary)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">历史会议</h3>
                <p className="mt-1 text-xs" style={{ color: "var(--oc-text-tertiary)" }}>选择一条会议纪要继续处理</p>
              </div>
              <button type="button" onClick={() => setHistoryOpen(false)} className="lingxia-toolbar-icon" title="关闭">
                <X size={16} />
              </button>
            </div>
            <input
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder="搜索标题、类型、转写、纪要"
              className="mt-4 w-full rounded-md px-3 py-2 text-sm"
              style={{
                background: "var(--oc-panel)",
                border: "1px solid var(--oc-border)",
                color: "var(--oc-text-primary)",
              }}
            />
            <div className="mt-4 space-y-2">
              {meetings.length === 0 ? (
                <div className="text-sm" style={{ color: "var(--oc-text-tertiary)" }}>暂无会议纪要</div>
              ) : filteredMeetings.length === 0 ? (
                <div className="text-sm" style={{ color: "var(--oc-text-tertiary)" }}>没有匹配的会议纪要</div>
              ) : filteredMeetings.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectMeeting(item)}
                  className="w-full rounded-md px-3 py-2 text-left"
                  style={{ background: current?.id === item.id ? "var(--oc-bg-active)" : "var(--oc-panel)", border: "1px solid var(--oc-border)", color: "var(--oc-text-primary)" }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm truncate">{item.title}</span>
                    <span className="text-xs font-mono shrink-0" style={{ color: "var(--oc-text-tertiary)" }}>{formatDuration(item.durationSec || 0)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--oc-text-tertiary)" }}>
                    <span>{item.meetingTypeLabel || "普通会议"}</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                    <span>待办 {item.actionItemsCount ?? 0} 项</span>
                  </div>
                  <div className="text-xs mt-1 truncate" style={{ color: "var(--oc-text-tertiary)" }}>
                    {(item.summary || item.transcript || "").replace(/^#+\s+/gm, "").replace(/\s+/g, " ").slice(0, 120)}
                  </div>
                </button>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
