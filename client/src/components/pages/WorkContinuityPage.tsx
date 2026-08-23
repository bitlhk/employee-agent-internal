import { useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  FileText,
  ListTodo,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type Filter = "active" | "draft" | "done" | "all";

const STATUS_LABEL: Record<string, string> = {
  draft: "待确认",
  confirmed: "已确认",
  open: "待处理",
  in_progress: "进行中",
  done: "已完成",
  cancelled: "已取消",
};

const TYPE_LABEL: Record<string, string> = {
  decision: "决定",
  action_item: "待办",
  open_question: "开放问题",
};

function datetimeLocal(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function draftPatch(item: any) {
  return {
    subject: String(item.subject || ""),
    description: String(item.description || ""),
    ownerDisplayName: String(item.ownerDisplayName || ""),
    dueAt: datetimeLocal(item.dueAt),
  };
}

export function WorkContinuityPage({ adoptId }: { adoptId: string }) {
  const { confirm, dialog } = useConfirmDialog();
  const utils = trpc.useUtils();
  const [meetingText, setMeetingText] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [edits, setEdits] = useState<Record<string, ReturnType<typeof draftPatch>>>({});
  const view = trpc.workContinuity.view.useQuery(
    { adoptId, includeClosed: true },
    { enabled: Boolean(adoptId) },
  );
  const refresh = () => utils.workContinuity.view.invalidate({ adoptId, includeClosed: true });
  const draftMeeting = trpc.workContinuity.draftMeeting.useMutation({
    onSuccess: async (result) => {
      setMeetingText("");
      setFilter("draft");
      await refresh();
      toast.success(`已识别 ${result.items.length} 条工作事项草稿`);
    },
    onError: error => toast.error(error.message),
  });
  const confirmItem = trpc.workContinuity.confirm.useMutation();
  const updateStatus = trpc.workContinuity.updateStatus.useMutation();

  const approve = async (approvalId: string) => {
    const response = await fetch(`/api/claw/governance/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId, decision: "approved" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || "操作确认失败");
  };

  const items = view.data?.items || [];
  const filtered = useMemo(() => items.filter((item: any) => {
    if (filter === "draft") return item.status === "draft";
    if (filter === "active") return ["confirmed", "open", "in_progress"].includes(item.status);
    if (filter === "done") return ["done", "cancelled"].includes(item.status);
    return true;
  }), [filter, items]);
  const counts = useMemo(() => ({
    draft: items.filter((item: any) => item.status === "draft").length,
    active: items.filter((item: any) => ["confirmed", "open", "in_progress"].includes(item.status)).length,
    done: items.filter((item: any) => ["done", "cancelled"].includes(item.status)).length,
    all: items.length,
  }), [items]);

  const runConfirm = async (item: any) => {
    const ok = await confirm({
      title: "确认工作事项",
      description: "确认后该事项将成为岗位后续交互可引用的正式工作状态。",
      confirmText: "确认并创建",
    });
    if (!ok) return;
    const edit = edits[item.workItemId] || draftPatch(item);
    const request = {
      adoptId,
      workItemId: item.workItemId,
      idempotencyKey: `ui-confirm-${item.workItemId}`,
      patch: {
        subject: edit.subject,
        description: edit.description || null,
        ownerDisplayName: edit.ownerDisplayName || null,
        dueAt: edit.dueAt ? new Date(edit.dueAt).toISOString() : null,
        relatedContext: item.relatedContext,
      },
    };
    try {
      const pending = await confirmItem.mutateAsync(request);
      if (!("approvalRequired" in pending) || !pending.approvalRequired) throw new Error("确认门禁未返回有效审批请求。");
      await approve(pending.approvalId);
      const result = await confirmItem.mutateAsync({ ...request, approvalId: pending.approvalId });
      if (!("item" in result)) throw new Error("工作事项确认未执行。");
      await refresh();
      toast.success("工作事项已确认");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "工作事项确认失败");
    }
  };

  const runStatus = async (item: any, operation: "start" | "complete" | "cancel") => {
    const label = operation === "start" ? "开始处理" : operation === "complete" ? "标记完成" : "取消事项";
    const ok = await confirm({
      title: label,
      description: `工作事项：${item.subject}\n本次操作会写入执行凭证和工作状态版本。`,
      confirmText: label,
      variant: operation === "cancel" ? "danger" : "default",
    });
    if (!ok) return;
    const request = {
      adoptId,
      workItemId: item.workItemId,
      operation,
      idempotencyKey: `ui-${operation}-${item.workItemId}-v${item.version}`,
    };
    try {
      const pending = await updateStatus.mutateAsync(request);
      if (!("approvalRequired" in pending) || !pending.approvalRequired) throw new Error("确认门禁未返回有效审批请求。");
      await approve(pending.approvalId);
      const result = await updateStatus.mutateAsync({ ...request, approvalId: pending.approvalId });
      if (!("item" in result)) throw new Error("工作事项状态未更新。");
      await refresh();
      toast.success(`状态已更新为${STATUS_LABEL[result.item.status]}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "工作事项状态更新失败");
    }
  };

  return (
    <div className="h-full min-h-0 overflow-auto bg-white text-gray-900">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="border-b border-gray-200 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-50 text-emerald-700"><ListTodo size={19} /></div>
            <div>
              <h1 className="text-lg font-semibold">工作事项</h1>
              <p className="mt-0.5 text-sm text-gray-500">会议形成草稿，确认后进入岗位连续工作状态</p>
            </div>
          </div>
        </header>

        <div className="grid min-h-[620px] grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="border-b border-gray-200 py-5 lg:border-b-0 lg:border-r lg:pr-6" aria-label="会议文字录入">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><FileText size={16} />会议文字</div>
            <textarea
              value={meetingText}
              onChange={event => setMeetingText(event.target.value)}
              rows={12}
              maxLength={30_000}
              placeholder="粘贴会议纪要或转写文字"
              className="w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs tabular-nums text-gray-400">{meetingText.length}/30000</span>
              <button
                type="button"
                disabled={meetingText.trim().length < 10 || draftMeeting.isPending}
                onClick={() => draftMeeting.mutate({ adoptId, meetingText: meetingText.trim(), meetingAt: new Date().toISOString() })}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-700 px-3.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {draftMeeting.isPending ? <Loader2 size={15} className="animate-spin" /> : <ClipboardCheck size={15} />}
                识别工作事项
              </button>
            </div>
            <div className="mt-6 border-t border-gray-100 pt-4">
              <div className="flex items-start gap-2 text-xs leading-5 text-gray-500">
                <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-700" />
                <span>未确认内容只保留为草稿，不会成为岗位工作事实。</span>
              </div>
            </div>
          </section>

          <section className="min-w-0 py-5 lg:pl-6" aria-label="工作事项列表">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-4">
              <div className="flex gap-1 rounded-md bg-gray-100 p-1" role="tablist" aria-label="工作事项筛选">
                {([
                  ["active", "待处理", counts.active],
                  ["draft", "待确认", counts.draft],
                  ["done", "已结束", counts.done],
                  ["all", "全部", counts.all],
                ] as const).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={filter === key}
                    onClick={() => setFilter(key)}
                    className={`h-8 rounded px-3 text-xs font-medium transition-colors ${filter === key ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
                  >{label} <span className="ml-1 tabular-nums text-gray-400">{count}</span></button>
                ))}
              </div>
              <button type="button" onClick={() => view.refetch()} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-gray-600 hover:bg-gray-100"><RotateCcw size={14} />刷新</button>
            </div>

            {view.isLoading ? (
              <div className="flex h-48 items-center justify-center text-sm text-gray-500"><Loader2 className="mr-2 animate-spin" size={17} />加载工作状态</div>
            ) : filtered.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-gray-500">
                <ListTodo size={26} className="mb-3 text-gray-300" />
                当前筛选下没有工作事项
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {filtered.map((item: any) => {
                  const edit = edits[item.workItemId] || draftPatch(item);
                  const execution = (view.data?.executions || []).find((entry: any) => entry.workItemId === item.workItemId);
                  return (
                    <article key={item.workItemId} className="py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{TYPE_LABEL[item.type]}</span>
                            <span className={`rounded px-2 py-0.5 text-xs font-medium ${item.status === "draft" ? "bg-amber-50 text-amber-700" : item.status === "done" ? "bg-emerald-50 text-emerald-700" : item.status === "cancelled" ? "bg-gray-100 text-gray-500" : "bg-blue-50 text-blue-700"}`}>{STATUS_LABEL[item.status]}</span>
                          </div>
                          {item.status === "draft" ? (
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="sm:col-span-2 text-xs font-medium text-gray-600">事项名称
                                <input value={edit.subject} onChange={event => setEdits(previous => ({ ...previous, [item.workItemId]: { ...edit, subject: event.target.value } }))} className="mt-1 h-9 w-full rounded-md border border-gray-300 px-3 text-sm font-normal text-gray-900 outline-none focus:border-emerald-600" />
                              </label>
                              {item.type === "action_item" ? <>
                                <label className="text-xs font-medium text-gray-600">负责人
                                  <input value={edit.ownerDisplayName} onChange={event => setEdits(previous => ({ ...previous, [item.workItemId]: { ...edit, ownerDisplayName: event.target.value } }))} className="mt-1 h-9 w-full rounded-md border border-gray-300 px-3 text-sm font-normal text-gray-900 outline-none focus:border-emerald-600" />
                                </label>
                                <label className="text-xs font-medium text-gray-600">截止时间
                                  <input type="datetime-local" value={edit.dueAt} onChange={event => setEdits(previous => ({ ...previous, [item.workItemId]: { ...edit, dueAt: event.target.value } }))} className="mt-1 h-9 w-full rounded-md border border-gray-300 px-3 text-sm font-normal text-gray-900 outline-none focus:border-emerald-600" />
                                </label>
                              </> : null}
                            </div>
                          ) : (
                            <>
                              <h2 className="break-words text-sm font-semibold leading-6 text-gray-900">{item.subject}</h2>
                              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-500">
                                {item.ownerDisplayName ? <span>负责人：{item.ownerDisplayName}</span> : null}
                                {item.dueAt ? <span className="inline-flex items-center gap-1"><CalendarClock size={13} />{new Date(item.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> : null}
                                <span>版本 {item.version}</span>
                              </div>
                            </>
                          )}
                          <div className="mt-2 text-xs text-gray-400">来源：会议 · {item.extraction?.extractor === "deterministic" ? "规则提取" : "模型建议"}</div>
                          {execution ? <details className="mt-2 text-xs text-gray-500"><summary className="cursor-pointer select-none">执行凭证</summary><div className="mt-1 font-mono text-[11px] leading-5">{execution.executionReceiptId}<br />Context {String(execution.contextReceiptFingerprint || "-").slice(0, 16)}…</div></details> : null}
                        </div>
                        <div className="flex shrink-0 flex-col gap-2">
                          {item.status === "draft" ? <button type="button" disabled={confirmItem.isPending || !edit.subject.trim()} onClick={() => void runConfirm(item)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"><CheckCircle2 size={14} />确认</button> : null}
                          {item.status === "open" ? <button type="button" disabled={updateStatus.isPending} onClick={() => void runStatus(item, "start")} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"><Play size={14} />开始</button> : null}
                          {["open", "in_progress"].includes(item.status) ? <button type="button" disabled={updateStatus.isPending} onClick={() => void runStatus(item, "complete")} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800"><CheckCircle2 size={14} />完成</button> : null}
                          {["draft", "confirmed", "open", "in_progress"].includes(item.status) ? <button type="button" disabled={updateStatus.isPending} onClick={() => void runStatus(item, "cancel")} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs text-gray-500 hover:bg-gray-100"><XCircle size={14} />取消</button> : null}
                          {item.type === "open_question" && item.status !== "done" ? <CircleHelp size={16} className="mx-auto text-amber-600" /> : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
      {dialog}
    </div>
  );
}
