/**
 * CoopSession — 岗位智能体组织协作窗口
 * URL: /coop/:sessionId
 * 
 * 视角：
 *   creator  — 发起人；看所有成员状态
 *   member   — 群成员；可直接在群里发言，或让自己的智能体代写后确认发送
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Loader2, ArrowLeft, CheckCircle2, Users as UsersIcon, Paperclip, Download, Sparkles, FolderOpen, Square, Copy, PanelRightClose, PanelRightOpen, Bot, Wand2, X, Pencil, Check } from "lucide-react";
import { toast } from "sonner";
import { ChatInput } from "@/components/ChatInput";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { sessionStatusMeta } from "@/lib/coopStatus";
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

type EventAttachment = {
  fileId?: number;
  name: string;
  url: string;
  source?: "chat" | "task" | "agent_workspace";
  size?: number;
  adoptId?: string;
  path?: string;
};

type ComposerSkillOption = {
  id: string;
  label: string;
  desc: string;
};

function flattenComposerSkills(groups: any): ComposerSkillOption[] {
  const raw = [
    ...(Array.isArray(groups?.shared) ? groups.shared : []),
    ...(Array.isArray(groups?.system) ? groups.system : []),
    ...(Array.isArray(groups?.private) ? groups.private : []),
  ];
  const seen = new Set<string>();
  const out: ComposerSkillOption[] = [];
  for (const skill of raw) {
    const id = String(skill?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const enabled = skill?.enabled !== false;
    const ready = !skill?.state || skill.state === "ready";
    const runnable = skill?.runnable !== false && skill?.active !== false;
    if (!enabled || !ready || !runnable) continue;
    seen.add(id);
    out.push({
      id,
      label: String(skill?.source?.displayName || skill?.displayName || skill?.label || skill?.name || id).trim() || id,
      desc: String(skill?.desc || skill?.description || skill?.source?.description || "").trim(),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function workspaceFileToAttachment(file: any, adoptId: string): EventAttachment | null {
  const name = String(file?.name || "").trim();
  const path = String(file?.path || "").trim();
  if (!name || !path || !adoptId) return null;
  return {
    name,
    size: Number(file?.size || 0) || undefined,
    source: "agent_workspace",
    url: `/api/claw/files/download?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(path)}`,
    adoptId,
    path,
  };
}

function formatAttSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function formatMemberOrg(member: any): string {
  return member.targetTeamName || member.targetDepartmentName || member.targetGroupName || member.targetOrgName || "组织";
}

const COOP_AGENT_ROLE_NAMES: Record<string, string> = {
  "investment-researcher": "投顾分析",
  "wealth-manager": "财富经理",
  "credential-compliance": "审核专员",
  "insurance-advisor": "保险顾问",
  "general-assistant": "通用助手",
};

function formatMemberRole(member: any): string {
  const role = String(member.targetRoleTemplate || "").trim();
  return COOP_AGENT_ROLE_NAMES[role] || role || "通用助手";
}

function AttachmentList({ attachments }: { attachments: EventAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="coop-session-attachments">
      <div className="coop-session-section-label">
        <Paperclip className="w-3 h-3" /> 附件 ({attachments.length})
      </div>
      <div className="space-y-1">
        {attachments.map((f, i) => (
          <a
            key={`${f.url}-${i}`}
            href={f.url}
            target="_blank"
            rel="noopener noreferrer"
            className="coop-session-attachment-link"
            title={`下载 ${f.name}`}
          >
            <Download className="w-3 h-3 shrink-0" />
            <span className="flex-1 truncate" title={f.name}>{f.name}</span>
            {f.size ? <span className="text-[10px] opacity-70 shrink-0">{formatAttSize(f.size)}</span> : null}
          </a>
        ))}
      </div>
    </div>
  );
}

// 状态 meta 统一走 lib/coopStatus，避免各文件重复定义。

export default function CoopSession() {
  const [, params] = useRoute("/coop/:sessionId");
  const [location, setLocation] = useLocation();
  const sessionId = params?.sessionId || "";
  const [groupInput, setGroupInput] = useState("");
  const [agentMode, setAgentMode] = useState(false);
  const [agentDraft, setAgentDraft] = useState("");
  const [agentAttachments, setAgentAttachments] = useState<EventAttachment[]>([]);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [selectedComposerSkillId, setSelectedComposerSkillId] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const agentAbortRef = useRef<AbortController | null>(null);

  // 拉 session 详情（每 3 秒 refetch 一次作为轮询）
  const { data, isLoading, error, refetch } = trpc.coop.getSession.useQuery(
    { sessionId },
    { enabled: Boolean(sessionId), refetchInterval: 3000 }
  );

  const sourceAdoptId = useMemo(() => {
    try {
      const search = location.includes("?")
        ? location.slice(location.indexOf("?"))
        : window.location.search;
      return String(new URLSearchParams(search).get("fromAdoptId") || "").trim();
    } catch {
      return "";
    }
  }, [location]);

  const viewerSessionAdoptId = useMemo(() => {
    const sessionData = data as any;
    const creatorAdoptId = String(sessionData?.session?.creatorAdoptId || "").trim();
    if (sessionData?.viewerIsCreator && creatorAdoptId) {
      return creatorAdoptId;
    }

    const viewerUserId = String(sessionData?.viewerUserId || "").trim();
    if (!viewerUserId) {
      return "";
    }

    const member = (sessionData?.members || []).find(
      (item: any) => String(item?.targetUserId || "").trim() === viewerUserId
    );
    return String(member?.targetAdoptId || "").trim();
  }, [data]);

  // 拿当前用户的 adoptId，返回时跳 /claw/{adoptId}（即"我的智能体"主页 + 协作 tab）
  // 注意：App.tsx 里 / 是 <ClawHome /> 创建页，/claw/:adoptId 才是 <Home /> 含「我的协作」
  const { data: myClawForBack } = trpc.claw.me.useQuery(undefined, { retry: false });
  const myAdoptIdForBack = sourceAdoptId || viewerSessionAdoptId || ((myClawForBack as any)?.adoption?.adoptId as string | undefined);
  const { data: lingxiaSkills } = trpc.claw.listSkills.useQuery(
    { adoptId: myAdoptIdForBack || "" },
    { enabled: Boolean(myAdoptIdForBack), retry: false }
  );
  const composerSkills = useMemo(() => flattenComposerSkills(lingxiaSkills), [lingxiaSkills]);
  const selectedComposerSkill = useMemo(
    () => composerSkills.find((skill) => skill.id === selectedComposerSkillId) || null,
    [composerSkills, selectedComposerSkillId]
  );
  const handleComposerSkillChange = (value: string) => {
    if (value === "__none") {
      setSelectedComposerSkillId("");
      return;
    }
    setSelectedComposerSkillId(value);
    setAgentMode(true);
  };
  useEffect(() => {
    if (selectedComposerSkillId && !composerSkills.some((skill) => skill.id === selectedComposerSkillId)) {
      setSelectedComposerSkillId("");
    }
  }, [composerSkills, selectedComposerSkillId]);

  // 拉 events 用于解析每个已提交成员的附件列表（来自 member_completed event payload.attachments）
  const eventsQ = trpc.coop.listEvents.useQuery(
    { sessionId, sinceId: 0, limit: 200 },
    { enabled: Boolean(sessionId), refetchInterval: 5000 }
  );
  const filesQ = trpc.coop.files.useQuery(
    { sessionId },
    { enabled: Boolean(sessionId), refetchInterval: 5000 }
  );
  const sendGroupMessageMut = trpc.coop.sendMessage.useMutation({
    onSuccess: () => {
      setGroupInput("");
      refetch();
      eventsQ.refetch();
    },
    onError: (error) => toast.error(error.message || "发送失败"),
  });
  const updateTitleMut = trpc.coop.updateTitle.useMutation({
    onSuccess: (result) => {
      setTitleEditing(false);
      setTitleDraft(result.title || "");
      toast.success("协作名称已更新");
      refetch();
      eventsQ.refetch();
    },
    onError: (error) => toast.error(error.message || "修改失败"),
  });
  // 按 requestId 索引附件列表
  const attachmentsByRequestId = useMemo(() => {
    const map = new Map<number, EventAttachment[]>();
    const events = (eventsQ.data?.events as any[]) || [];
    for (const ev of events) {
      if (ev.eventType !== "member_completed") continue;
      if (!ev.requestId) continue;
      let payload: any = ev.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      const atts = Array.isArray(payload?.attachments) ? payload.attachments : [];
      if (atts.length > 0) map.set(Number(ev.requestId), atts);
    }
    return map;
  }, [eventsQ.data]);

  if (!sessionId) {
    return <div className="p-8 text-center text-foreground">无效的 session ID</div>;
  }
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-8 text-center">
        <div className="text-lg font-medium text-destructive mb-2">加载失败</div>
        <div className="text-sm text-foreground mb-4">{error?.message || "协作不存在或无权访问"}</div>
        <Button variant="outline" onClick={() => setLocation("/")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> 返回首页
        </Button>
      </div>
    );
  }

  const { session, members, viewerRole } = data;
  const currentUserId = (data as any).viewerUserId as number | undefined;
  const creatorInfo = (data as any).creator as { userId?: number; name?: string | null; email?: string | null } | undefined;
  const isMember = Boolean((data as any).viewerIsMember);
  const isCreator = Boolean((data as any).viewerIsCreator);
  const creatorDisplayName = isCreator
    ? "我"
    : (creatorInfo?.name || creatorInfo?.email || `发起人 #${session.creatorUserId}`);
  const displayTitle = String(session.title || "").trim() || "未命名协作";
  const sessionStatus = sessionStatusMeta(session.status);
  const myCard = members.find((m: any) => m.targetUserId === currentUserId);
  const completedMembers = members.filter((m: any) => m.status === "completed" && m.resultSummary);
  const showAgentDraft = Boolean(isCreator || (myCard && ["pending", "approved", "running"].includes(myCard.status)));
  const events = ((eventsQ.data?.events as any[]) || []);
  const groupMessages = events
    .filter((event) => event.eventType === "group_message")
    .map((event) => {
      let payload: any = event.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      const member = members.find((m: any) => m.targetUserId === event.actorUserId);
      const name = event.actorUserId === session.creatorUserId
        ? (event.actorUserId === currentUserId ? "我" : (creatorInfo?.name || creatorInfo?.email || `发起人 #${event.actorUserId}`))
        : (member?.targetUserName || member?.targetEmail || `#${event.actorUserId}`);
      return {
        id: Number(event.id || 0),
        actorUserId: Number(event.actorUserId || 0),
        name,
        text: String(payload?.text || ""),
        attachments: Array.isArray(payload?.attachments) ? payload.attachments as EventAttachment[] : [],
        createdAt: event.createdAt,
      };
    })
    .filter((message) => message.text)
    .sort((a, b) => a.id - b.id);
  const registeredSharedFiles = ((filesQ.data as any[]) || []).map((file) => ({
    fileId: Number(file.id || 0) || undefined,
    name: String(file.name || "文件"),
    url: String(file.url || ""),
    source: file.sourceType === "agent_workspace" ? "agent_workspace" : "chat",
    size: Number(file.size || 0) || undefined,
    memberName: file.ownerUserId ? `成员 #${file.ownerUserId}` : "共享文件",
    createdAt: file.createdAt,
  })).filter((file) => file.url);
  const eventSharedAttachments = [
    ...completedMembers.flatMap((m: any) =>
      (attachmentsByRequestId.get(m.requestId) || []).map((attachment) => ({
        ...attachment,
        memberName: m.targetUserName || m.targetEmail || `#${m.targetUserId}`,
      }))
    ),
    ...groupMessages.flatMap((message) =>
      (message.attachments || []).map((attachment) => ({
        ...attachment,
        memberName: message.name,
      }))
    ),
  ];
  const sharedAttachments = registeredSharedFiles.length > 0 ? registeredSharedFiles : eventSharedAttachments;
  const runAgentDraft = async (text: string) => {
    const clean = text.trim();
    if (!clean || !myAdoptIdForBack || agentStreaming) return;
    setAgentDraft("");
    setAgentAttachments([]);
    setAgentStreaming(true);
    const controller = new AbortController();
    agentAbortRef.current = controller;
    try {
      const apiBase = (import.meta as any).env?.VITE_API_URL || "";
      const resp = await fetch(`${apiBase}/api/claw/chat-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          adoptId: myAdoptIdForBack,
          message: clean,
          epochLabel: `coop-${sessionId}-agent-draft`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
          ...(selectedComposerSkill?.id ? { selectedSkillId: selectedComposerSkill.id } : {}),
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`请求失败 (${resp.status})`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") return;
          try {
            const chunk = JSON.parse(raw);
            if (chunk?.__perf || currentEvent === "agent_status") {
              currentEvent = "";
              continue;
            }
            if (currentEvent === "workspace_files") {
              const wsAdoptId = String(chunk?.adoptId || myAdoptIdForBack || "");
              const files = Array.isArray(chunk?.files) ? chunk.files : [];
              const attachments = files
                .map((file: any) => workspaceFileToAttachment(file, wsAdoptId))
                .filter(Boolean) as EventAttachment[];
              if (attachments.length > 0) {
                setAgentAttachments((prev) => {
                  const seen = new Set(prev.map((item) => `${item.adoptId || ""}:${item.path || item.url}`));
                  const next = [...prev];
                  for (const attachment of attachments) {
                    const key = `${attachment.adoptId || ""}:${attachment.path || attachment.url}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    next.push(attachment);
                  }
                  return next;
                });
              }
              currentEvent = "";
              continue;
            }
            const delta =
              chunk?.choices?.[0]?.delta?.content ||
              chunk?.delta?.content ||
              chunk?.content ||
              "";
            if (delta) setAgentDraft((prev) => prev + delta);
            currentEvent = "";
          } catch {}
        }
      }
    } catch (error: any) {
      if (error?.name !== "AbortError") toast.error(error?.message || "智能体生成失败");
    } finally {
      setAgentStreaming(false);
      agentAbortRef.current = null;
    }
  };

  const sendGroupMessage = () => {
    if (!groupInput.trim()) return false;
    if (agentMode) {
      void runAgentDraft(groupInput);
      setGroupInput("");
      return false;
    }
    sendGroupMessageMut.mutate({ sessionId, text: groupInput.trim() });
    return false;
  };

  const sendAgentDraftToGroup = () => {
    const text = agentDraft.trim();
    if (!text || agentStreaming) return;
    sendGroupMessageMut.mutate(
      { sessionId, text, attachments: agentAttachments },
      {
        onSuccess: () => {
          setAgentDraft("");
          setAgentAttachments([]);
          setAgentMode(false);
          setGroupInput("");
          eventsQ.refetch();
        },
      }
    );
  };

  const copyAgentDraft = async () => {
    const text = agentDraft.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制智能体草稿");
    } catch {
      toast.error("复制失败");
    }
  };

  const startTitleEdit = () => {
    if (!isCreator) return;
    setTitleDraft(displayTitle);
    setTitleEditing(true);
  };

  const saveTitleEdit = () => {
    const title = titleDraft.trim();
    if (!title) {
      toast.error("协作名称不能为空");
      return;
    }
    updateTitleMut.mutate({ sessionId, title });
  };

  return (
    <div className="coop-session-themed">
      {/* 顶部 Header */}
      <div className="coop-session-header">
        <div className="coop-session-header__inner">
          <Button variant="ghost" size="sm" className="lingxia-soft-action coop-back-button coop-session-back" onClick={() => {
            // 显式回「我的协作」tab：写 sessionStorage 让 Home 初始化时落地 collab 页
            // 跳 /claw/{adoptId}（Home），不是 / （那是 ClawHome 创建首页）
            try { sessionStorage.setItem("home_initial_page", "collab"); } catch {}
            if (myAdoptIdForBack) {
              setLocation(`/claw/${myAdoptIdForBack}`);
            } else {
              setLocation("/"); // fallback：没创建就回 ClawHome
            }
          }}>
            <ArrowLeft className="w-4 h-4 mr-1" /> 返回
          </Button>
          <div className="coop-session-header__main">
            <div className="coop-session-title-row">
              <UsersIcon className="coop-session-title-icon" />
              {titleEditing ? (
                <div className="coop-session-title-editor">
                  <input
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveTitleEdit();
                      if (event.key === "Escape") setTitleEditing(false);
                    }}
                    maxLength={120}
                    autoFocus
                    className="coop-session-title-input"
                  />
                  <button type="button" className="coop-title-action" onClick={saveTitleEdit} disabled={updateTitleMut.isPending} title="保存名称">
                    {updateTitleMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  </button>
                  <button type="button" className="coop-title-action" onClick={() => setTitleEditing(false)} disabled={updateTitleMut.isPending} title="取消">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="coop-session-title-display">
                  <h1 className="coop-session-title">{displayTitle}</h1>
                  {isCreator ? (
                    <button type="button" className="coop-title-action" onClick={startTitleEdit} title="修改协作名称">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              )}
              <span className={`badge ${sessionStatus.badgeClass}`}>{sessionStatus.label}</span>
            </div>
            <div className="coop-session-meta">
              协作 ID: <span className="font-mono">{session.id}</span> · {members.length} 位成员 · {isCreator && isMember ? "你是发起人（含成员）" : isCreator ? "你是发起人" : "你是协作成员"}
            </div>
          </div>
        </div>
      </div>

      <div className={`coop-session-shell coop-session-shell--main ${sideOpen ? "" : "coop-session-shell--side-collapsed"}`}>
        <div className={`coop-group-layout ${sideOpen ? "" : "coop-group-layout--side-collapsed"}`}>
          <section className="coop-group-main" aria-label="群消息">
            {!sideOpen ? (
              <button
                type="button"
                className="coop-side-toggle coop-side-toggle--floating"
                onClick={() => setSideOpen(true)}
                aria-label="显示群成员和群空间"
                title="显示群成员和群空间"
              >
                <PanelRightOpen className="w-4 h-4" />
                <span>群空间</span>
              </button>
            ) : null}
            <div className="coop-group-thread">
              {session.originMessage ? (
                <article className={`coop-group-message ${isCreator ? "coop-group-message--mine" : ""}`}>
                  <div className="coop-group-message__avatar">发</div>
                  <div className="coop-group-message__body">
                    <div className="coop-group-message__meta">
                      <span>{creatorDisplayName}</span>
                      <span>发起任务</span>
                    </div>
                    <div className="coop-group-message__bubble">
                      <div className="coop-session-body-text"><ChatMarkdown content={session.originMessage} /></div>
                    </div>
                  </div>
                </article>
              ) : null}

              {groupMessages.map((message) => (
                <article
                  className={`coop-group-message ${message.actorUserId === currentUserId ? "coop-group-message--mine" : ""}`}
                  key={`group-${message.id}`}
                >
                  <div className="coop-group-message__avatar">{String(message.name || "?").slice(0, 1)}</div>
                  <div className="coop-group-message__body">
                    <div className="coop-group-message__meta">
                      <span>{message.name}</span>
                      <span>{message.createdAt ? new Date(message.createdAt).toLocaleString("zh-CN", { hour12: false }) : "群消息"}</span>
                    </div>
                    <div className="coop-group-message__bubble">
                      <div className="coop-session-body-text"><ChatMarkdown content={message.text} /></div>
                      <AttachmentList attachments={message.attachments || []} />
                    </div>
                  </div>
                </article>
              ))}

              {completedMembers.map((member: any) => (
                <article
                  className={`coop-group-message ${member.targetUserId === currentUserId ? "coop-group-message--mine" : ""}`}
                  key={member.requestId}
                >
                  <div className="coop-group-message__avatar">{String(member.targetUserName || member.targetEmail || "?").slice(0, 1)}</div>
                  <div className="coop-group-message__body">
                    <div className="coop-group-message__meta">
                      <span>{member.targetUserName || member.targetEmail || `#${member.targetUserId}`}</span>
                      <span>确认发送了智能体结果</span>
                    </div>
                    <div className="coop-group-message__bubble">
                      <div className="coop-session-result-box coop-session-result-box--message">
                        <ChatMarkdown content={member.resultSummary} />
                      </div>
                      <AttachmentList attachments={attachmentsByRequestId.get(member.requestId) || []} />
                    </div>
                  </div>
                </article>
              ))}

              {session.status === "published" && session.finalSummary ? (
                <article className="coop-group-message coop-group-message--final">
                  <div className="coop-group-message__avatar"><CheckCircle2 className="w-4 h-4" /></div>
                  <div className="coop-group-message__body">
                    <div className="coop-group-message__meta">
                      <span>协作最终汇总</span>
                      {(session as any).publishedAt ? (
                        <span>{new Date((session as any).publishedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                      ) : null}
                    </div>
                    <div className="coop-group-message__bubble">
                      <div className="coop-session-final-box"><ChatMarkdown content={session.finalSummary} /></div>
                    </div>
                  </div>
                </article>
              ) : null}

              {!session.originMessage && groupMessages.length === 0 && completedMembers.length === 0 && !session.finalSummary ? (
                <div className="coop-group-empty">描述你想让大家协作处理的任务，第一条消息会作为协作开场。</div>
              ) : null}
            </div>

            {agentMode ? (
              <div className="coop-inline-agent-panel">
                <div className="coop-inline-agent-panel__head">
                  <div>
                    <div className="coop-session-card-title">我的智能体</div>
                    <div className="coop-session-meta">输入框当前会发送给智能体，确认草稿后再发到群里。</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {agentStreaming ? (
                      <Button size="sm" variant="outline" className="coop-agent-panel-button" onClick={() => agentAbortRef.current?.abort()}>
                        <Square className="w-3 h-3 mr-1" /> 停止
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" className="coop-agent-panel-button" onClick={() => setAgentMode(false)}>收起</Button>
                  </div>
                </div>
                <div className="coop-inline-agent-panel__body">
                  {agentDraft ? (
                    <article className="coop-group-message coop-group-message--mine coop-group-message--agent-draft">
                      <div className="coop-group-message__avatar"><Sparkles className="w-4 h-4" /></div>
                      <div className="coop-group-message__body">
                        <div className="coop-group-message__meta">
                          <span>我的智能体</span>
                          <span>{agentStreaming ? "生成中" : "草稿"}</span>
                        </div>
                        <div className="coop-group-message__bubble">
                          <div className="coop-inline-agent-draft">
                            <ChatMarkdown content={agentDraft} />
                          </div>
                          <AttachmentList attachments={agentAttachments} />
                        </div>
                      </div>
                    </article>
                  ) : (
                    <div className="coop-group-empty coop-group-empty--small">
                      {agentStreaming ? "智能体正在生成..." : "在下方输入框里写给智能体的要求，然后点击发送。"}
                    </div>
                  )}
                </div>
                <div className="coop-inline-agent-panel__actions">
                  <Button
                    size="sm"
                    variant="outline"
                    className="coop-agent-panel-button"
                    onClick={copyAgentDraft}
                    disabled={!agentDraft.trim()}
                  >
                    <Copy className="w-3 h-3 mr-1" /> 复制
                  </Button>
                  <Button
                    size="sm"
                    className="coop-agent-panel-button coop-agent-panel-button--primary text-white"
                    style={{ background: "var(--oc-success)" }}
                    onClick={sendAgentDraftToGroup}
                    disabled={!agentDraft.trim() || agentStreaming || sendGroupMessageMut.isPending}
                  >
                    发送到群
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="coop-group-composer">
              <ChatInput
                value={groupInput}
                onChange={setGroupInput}
                onSend={() => sendGroupMessage()}
                disabled={sendGroupMessageMut.isPending || agentStreaming}
                placeholder={
                  agentMode
                    ? "输入给智能体的要求..."
                    : !session.originMessage && groupMessages.length === 0
                      ? "描述你想让大家协作处理的任务..."
                      : "输入群消息..."
                }
                maxLength={4000}
                historyStorageKey={`coop_group_input_${sessionId}`}
                messages={[]}
                showUtilityButtons={false}
                leftControls={agentMode && selectedComposerSkill ? (
                  <span className="lingxia-composer-skill-chip" title={`本轮优先使用：${selectedComposerSkill.label}`}>
                    <Wand2 size={13} strokeWidth={1.8} />
                    <span>{selectedComposerSkill.label}</span>
                    <button
                      type="button"
                      aria-label="取消选择技能"
                      onClick={() => setSelectedComposerSkillId("")}
                    >
                      <X size={12} strokeWidth={1.8} />
                    </button>
                  </span>
                ) : null}
                rightControls={(
                  <>
                    <Select
                      value={selectedComposerSkillId || "__none"}
                      onValueChange={handleComposerSkillChange}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="选择技能"
                        className="lingxia-composer-skill-select focus:ring-0 focus:ring-offset-0"
                        disabled={!showAgentDraft || composerSkills.length === 0 || agentStreaming}
                        title={
                          !showAgentDraft
                            ? "只有协作成员或发起人可以选择技能"
                            : composerSkills.length === 0
                              ? "当前智能体没有可用技能"
                              : "选择后将使用智能体回复"
                        }
                      >
                        <span className="lingxia-composer-skill-select__label">
                          <Wand2 size={13} strokeWidth={1.8} />
                          <span>技能</span>
                        </span>
                      </SelectTrigger>
                      <SelectContent
                        style={{
                          background: "var(--oc-bg)",
                          border: "1px solid var(--oc-border)",
                          borderRadius: 10,
                          minWidth: 260,
                          maxWidth: 360,
                          boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
                          padding: "4px",
                        }}
                      >
                        <SelectItem value="__none" className="lingxia-skill-select-item">
                          <span style={{ color: "var(--oc-text-secondary)" }}>不指定技能</span>
                        </SelectItem>
                        {composerSkills.map((skill) => (
                          <SelectItem key={skill.id} value={skill.id} className="lingxia-skill-select-item">
                            <span className="lingxia-skill-select-item__main">
                              <span className="lingxia-skill-select-item__name">{skill.label}</span>
                              {skill.desc ? <span className="lingxia-skill-select-item__desc">{skill.desc}</span> : null}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      className={`lingxia-toolbar-icon coop-agent-reply-button ${agentMode ? "is-active" : ""}`}
                      onClick={() => setAgentMode((v) => !v)}
                      disabled={!showAgentDraft}
                      title={
                        showAgentDraft
                          ? agentMode ? "关闭智能体回复" : "智能体回复"
                          : myCard
                            ? "当前状态不能使用智能体回复"
                            : "只有协作成员或发起人可以使用智能体回复"
                      }
                    >
                      <Sparkles size={15} />
                      <span>智能体回复</span>
                    </button>
                  </>
                )}
              />
            </div>
          </section>

          {sideOpen ? (
          <aside className="coop-group-side" aria-label="群空间">
            <Card className="coop-session-card coop-group-space-card">
              <div className="coop-side-card-head">
                <div className="coop-session-card-title">群成员</div>
                <button
                  type="button"
                  className="coop-side-toggle"
                  onClick={() => setSideOpen(false)}
                  aria-label="隐藏群成员和群空间"
                  title="隐藏群成员和群空间"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>
              <div className="coop-group-member-list">
                {members.map((member: any) => {
                  const name = member.targetUserName || member.targetEmail || `#${member.targetUserId}`;
                  const role = formatMemberRole(member);
                  const orgUnit = formatMemberOrg(member);
                  return (
                    <div className="coop-agent-card coop-group-member-card" key={member.requestId}>
                      <div className="coop-agent-card__icon">
                        <Bot size={16} />
                      </div>
                      <div className="coop-agent-card__body">
                        <div className="coop-agent-card__name">
                          {name}
                          {member.targetUserId === currentUserId ? <span className="coop-session-me-pill">我</span> : null}
                        </div>
                        <div className="coop-agent-card__role">{orgUnit} - {role}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card className="coop-session-card coop-group-space-card">
              <div className="coop-session-card-title flex items-center gap-2"><FolderOpen className="w-4 h-4" /> 群空间</div>
              {sharedAttachments.length > 0 ? (
                <div className="coop-group-files">
                  {sharedAttachments.map((file: any, index: number) => (
                    <a key={`${file.url}-${index}`} href={file.url} target="_blank" rel="noopener noreferrer" className="coop-session-attachment-link">
                      <Download className="w-3 h-3 shrink-0" />
                      <span className="flex-1 truncate">{file.name}</span>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="coop-group-empty coop-group-empty--small">暂无共享文件</div>
              )}
            </Card>

            {isCreator ? <ConsolidationPanel sessionId={sessionId} session={session} members={members} onRefresh={refetch} /> : null}
          </aside>
          ) : null}
        </div>

      </div>
    </div>
  );
}

// ── 发起人整合/发布面板 ──
function ConsolidationPanel({ sessionId, session, members, onRefresh }: {
  sessionId: string;
  session: any;
  members: any[];
  onRefresh: () => void;
}) {
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [draft, setDraft] = useState<string>(session.finalSummary || "");
  const [providerUsed, setProviderUsed] = useState<string>("");
  const [hasDraft, setHasDraft] = useState(Boolean(session.finalSummary));
  // 优先读发起时从模板写入的汇总预设；没有则空串（走默认 SYSTEM_PROMPT）
  const [customInstructions, setCustomInstructions] = useState<string>(session.consolidationPromptPreset || "");
  const hasPreset = Boolean(session.consolidationPromptPreset);

  const consolidateMut = trpc.coop.consolidate.useMutation({
    onSuccess: (r) => {
      setDraft(r.draft);
      setProviderUsed(r.providerUsed);
      setHasDraft(true);
      toast.success(`AI 汇总完成（${r.providerUsed}）`);
    },
    onError: (e) => toast.error(e.message || "汇总失败"),
  });
  const publishMut = trpc.coop.publish.useMutation({
    onSuccess: () => { toast.success("已发布，全员可见"); onRefresh(); },
    onError: (e) => toast.error(e.message || "发布失败"),
  });
  const closeMut = trpc.coop.close.useMutation({
    onSuccess: (r) => { toast.success(r.nextStatus === "dissolved" ? "已解散" : "已关闭"); onRefresh(); },
    onError: (e) => toast.error(e.message || "关闭失败"),
  });

  const anyCompleted = members.some((m: any) => m.status === "completed");
  const readyToConsolidate = anyCompleted;
  const isPublished = session.status === "published";
  const isClosed = session.status === "closed" || session.status === "dissolved";

  return (
    <Card className="coop-session-card coop-session-consolidation-card">
      <AlertDialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <AlertDialogContent className="bg-white text-gray-900 border-gray-200 shadow-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-gray-900">关闭协作？</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-600">
              你可以只关闭协作并保留记录，也可以解散群组让协作终止。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:text-gray-900">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-white text-gray-800 border border-gray-200 hover:bg-gray-50"
              onClick={() => closeMut.mutate({ sessionId, mode: "keep" })}
            >
              只关闭
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => closeMut.mutate({ sessionId, mode: "dissolve" })}
            >
              解散群组
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="coop-session-card-title">汇总 · 发布</div>
          <div className="coop-session-meta mt-0.5">
            {isPublished ? "已发布，全员可见" : isClosed ? "协作已关闭" : readyToConsolidate ? "已有成员回复，可以汇总" : "等待成员回复..."}
          </div>
        </div>
        <div className="flex gap-2">
          {!isClosed ? (
            <Button size="sm" variant="ghost" className="coop-session-close-button" onClick={() => setCloseDialogOpen(true)} disabled={closeMut.isPending}>
              关闭/解散
            </Button>
          ) : null}
        </div>
      </div>

      {/* 2026-04-17: 自定义汇总指令（发起人可填，未填走默认 prompt） */}
      {!isPublished && !isClosed && readyToConsolidate ? (
        <div className="mt-2 mb-3">
          <label className="coop-session-section-label mb-1">
            自定义汇总指令{hasPreset ? "（已从发起模板预填 · 可修改）" : "（可选 · 留空走默认）"}
          </label>
          <Textarea
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="例如：按部门分组列出 / 重点突出风险项 / 限 500 字内 / 正式汇报风格 / 用表格呈现 ..."
            className="coop-session-textarea min-h-[60px]"
            disabled={consolidateMut.isPending}
            maxLength={1000}
          />
          <div className="flex items-center justify-between mt-1.5">
            <div className="coop-session-count">{customInstructions.length}/1000</div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => consolidateMut.mutate({
                sessionId,
                customInstructions: customInstructions.trim() || undefined,
              })}
              disabled={consolidateMut.isPending}
            >
              {consolidateMut.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              AI 汇总{hasDraft ? "（重新生成）" : ""}
            </Button>
          </div>
        </div>
      ) : null}
      {(hasDraft || isPublished) ? (
        <>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="coop-session-textarea min-h-[220px] font-mono"
            placeholder="汇总内容（可编辑后发布）"
            readOnly={isPublished}
          />
          {providerUsed ? <div className="text-[11px] text-muted-foreground mt-1">模型：{providerUsed}</div> : null}
          {!isPublished && !isClosed ? (
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                className="text-white"
                style={{ background: "var(--oc-success)" }}
                onClick={() => publishMut.mutate({ sessionId, finalSummary: draft })}
                disabled={publishMut.isPending || !draft.trim()}
              >
                {publishMut.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                发布给所有成员
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
