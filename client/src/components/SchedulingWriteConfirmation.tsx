import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
import { calendarFormat } from "@/lib/calendar-time";
import type { CalendarWrite } from "../../../shared/scheduling";

function draftSummary(payload: CalendarWrite) {
  if (payload.action === "delete") return `取消：${payload.title}`;
  const { event } = payload;
  return `${payload.action === "create" ? "创建" : "修改"}：${event.title} · ${event.time.type === "allDay" ? `${event.time.start} 至 ${event.time.end}（结束日不含）` : `${calendarFormat(event.time.start)} — ${calendarFormat(event.time.end)}`}${event.location ? ` · ${event.location}` : ""}`;
}

export function WriteDrafts({ focusId }: { focusId?: string } = {}) {
  const drafts = trpc.scheduling.drafts.useQuery();
  const utils = trpc.useUtils();
  const refresh = async () => {
    await utils.scheduling.drafts.invalidate();
    await utils.scheduling.events.invalidate();
  };
  const confirm = trpc.scheduling.confirmWrite.useMutation({
    onSuccess: refresh,
    onError: refresh,
  });
  const cancel = trpc.scheduling.cancelWrite.useMutation({
    onSuccess: refresh,
  });
  const labels = {
    pending: "等待确认",
    executing: "执行中",
    completed: "已完成",
    unknown: "需要核对",
    cancelled: "已取消草稿",
  };
  return (
    <section className="space-y-4 rounded-xl border p-6">
      <h2 className="text-xl font-semibold">日程操作确认</h2>
      {drafts.error && <p role="alert">{drafts.error.message}</p>}
      {confirm.error && <p role="alert">{confirm.error.message}</p>}
      {cancel.error && <p role="alert">{cancel.error.message}</p>}
      {!drafts.data?.length && !drafts.error && (
        <p className="text-sm text-muted-foreground">暂无日程操作草稿。</p>
      )}
      {drafts.data
        ?.filter(draft => !focusId || draft.id === focusId)
        .map(draft => (
          <article key={draft.id} className="space-y-2 rounded-lg border p-4">
            <p>{draftSummary(draft.payload)}</p>
            <p className="text-sm text-muted-foreground">
              {labels[draft.status]}
            </p>
            {(["pending", "unknown", "executing"] as string[]).includes(
              draft.status
            ) && (
              <div className="flex gap-2">
                <Button
                  disabled={
                    confirm.isPending ||
                    cancel.isPending ||
                    (draft.status === "pending" &&
                      new Date(draft.expiresAt).getTime() <= Date.now())
                  }
                  onClick={() => confirm.mutate({ draftId: draft.id })}
                >
                  {draft.status === "pending" ? "确认执行" : "核对并重试"}
                </Button>
                {draft.status === "pending" && (
                  <Button
                    variant="outline"
                    disabled={cancel.isPending || confirm.isPending}
                    onClick={() => cancel.mutate({ draftId: draft.id })}
                  >
                    放弃草稿
                  </Button>
                )}
              </div>
            )}
          </article>
        ))}
    </section>
  );
}
