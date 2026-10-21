import {
  CALENDAR_TIME_ZONE,
  calendarInputValue,
  calendarInputInstant,
} from "@/lib/calendar-time";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
import type { MeetingPayload } from "../../../../shared/scheduling";
const meetingLabels = {
  pending: "等待创建确认",
  checking: "等待创建确认",
  creating: "正在创建",
  invited: "会议已创建",
  unknown: "写入结果待核对",
  cancelled: "已取消",
};

export function SchedulingMeetings({ focusId }: { focusId?: string } = {}) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    event: MeetingPayload["event"];
  } | null>(null);
  const utils = trpc.useUtils();
  const meetings = trpc.scheduling.meetings.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const drafts = trpc.scheduling.reschedules.useQuery(undefined, {
    refetchInterval: 10_000,
  });
  const refresh = async () => {
    await utils.scheduling.meetings.invalidate();
    await utils.scheduling.events.invalidate();
    await utils.scheduling.coordinations.invalidate();
    await utils.scheduling.incomingCoordination.invalidate();
  };
  const confirm = trpc.scheduling.confirmMeeting.useMutation({
    onSuccess: refresh,
    onError: refresh,
  });
  const cancel = trpc.scheduling.cancelMeeting.useMutation({
    onSuccess: async () => {
      setCancelling(null);
      await refresh();
    },
    onError: refresh,
  });
  const busy = confirm.isPending || cancel.isPending;
  const prepare = trpc.scheduling.prepareReschedule.useMutation({
    onSuccess: async () => {
      setEditing(null);
      await utils.scheduling.reschedules.invalidate();
    },
  });
  const confirmChange = trpc.scheduling.confirmReschedule.useMutation({
    onSuccess: async () => {
      await refresh();
      await utils.scheduling.reschedules.invalidate();
    },
    onError: () => utils.scheduling.reschedules.invalidate(),
  });
  const cancelChange = trpc.scheduling.cancelReschedule.useMutation({
    onSuccess: () => utils.scheduling.reschedules.invalidate(),
  });
  return (
    <section className="space-y-4 rounded-xl border p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">日程确认</h2>
        <Button
          variant="outline"
          disabled={meetings.isFetching}
          onClick={() => meetings.refetch()}
        >
          刷新状态
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        确认后保存日程并由日历系统同步参与人，无需等待邀请回复。
      </p>
      {[
        meetings.error,
        confirm.error,
        cancel.error,
        prepare.error,
        drafts.error,
        confirmChange.error,
        cancelChange.error,
      ]
        .filter(Boolean)
        .map((error, index) => (
          <p key={index} role="alert">
            {error!.message}
          </p>
        ))}
      {meetings.isFetching && <p role="status">正在核对本人日历中的会议…</p>}
      {meetings.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无会议草稿或邀请。</p>
      )}
      {meetings.data
        ?.filter(meeting => !focusId || meeting.id === focusId)
        .map(meeting => (
          <article key={meeting.id} className="space-y-3 rounded border p-4">
            <h3 className="font-medium">
              {meeting.event.title} · {meetingLabels[meeting.status]}
            </h3>
            <p>
              {new Date(meeting.event.time.start).toLocaleString("zh-CN", {
                timeZone: CALENDAR_TIME_ZONE,
              })}{" "}
              —{" "}
              {new Date(meeting.event.time.end).toLocaleString("zh-CN", {
                timeZone: CALENDAR_TIME_ZONE,
              })}
            </p>
            {meeting.event.location && <p>{meeting.event.location}</p>}
            <ul className="space-y-1">
              {meeting.attendees.map(person => (
                <li key={person.userId}>
                  {person.name}
                </li>
              ))}
            </ul>
            {meeting.status === "invited" && !meeting.synced && (
              <p className="text-sm">
                本人日历中的邀请尚未核实，请刷新或检查账号连接。
              </p>
            )}
            {meeting.isOrganizer && meeting.status === "invited" && (
              <Button
                variant="outline"
                disabled={busy || prepare.isPending}
                onClick={() =>
                  setEditing({ id: meeting.id, event: meeting.event })
                }
              >
                准备改期
              </Button>
            )}
            {meeting.isOrganizer &&
              ["pending", "checking"].includes(meeting.status) &&
              new Date(meeting.expiresAt).getTime() <= Date.now() && (
                <p className="text-sm">
                  草稿已过期，请重新创建；可以取消这个草稿。
                </p>
              )}
            {meeting.isOrganizer &&
              ["pending", "checking", "creating", "unknown"].includes(
                meeting.status
              ) && (
                <Button
                  disabled={
                    busy ||
                    (["pending", "checking"].includes(meeting.status) &&
                      new Date(meeting.expiresAt).getTime() <= Date.now())
                  }
                  onClick={() => confirm.mutate({ meetingId: meeting.id })}
                >
                  {meeting.status === "pending"
                    ? "确认创建"
                    : "核对并重试"}
                </Button>
              )}
            {meeting.isOrganizer &&
              meeting.status !== "cancelled" &&
              (cancelling === meeting.id ? (
                <div className="space-y-2 rounded border p-3">
                  <p>
                    确认取消上方会议？已创建的会议将由日历系统通知参与人取消。
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => cancel.mutate({ meetingId: meeting.id })}
                    >
                      确认取消会议
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setCancelling(null)}
                    >
                      保留会议
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setCancelling(meeting.id)}
                >
                  准备取消会议
                </Button>
              ))}
          </article>
        ))}
      {editing && (
        <RescheduleEditor
          key={editing.id}
          event={editing.event}
          busy={prepare.isPending}
          onCancel={() => setEditing(null)}
          onSave={event => prepare.mutate({ meetingId: editing.id, event })}
        />
      )}
      {drafts.data
        ?.filter(
          draft =>
            !draft.cascadeId &&
            (!focusId || draft.id === focusId || draft.meetingId === focusId) &&
            draft.status !== "cancelled" &&
            draft.status !== "completed"
        )
        .map(draft => (
          <article key={draft.id} className="space-y-3 rounded border p-4">
            <h3 className="font-medium">改期确认：{draft.event.title}</h3>
            <p>
              原时间：
              {new Date(draft.previous.time.start).toLocaleString("zh-CN", {
                timeZone: CALENDAR_TIME_ZONE,
              })}{" "}
              —{" "}
              {new Date(draft.previous.time.end).toLocaleString("zh-CN", {
                timeZone: CALENDAR_TIME_ZONE,
              })}
            </p>
            <p>
              新时间：
              {new Date(draft.event.time.start).toLocaleString("zh-CN", {
                timeZone: CALENDAR_TIME_ZONE,
              })}{" "}
              —{" "}
              {new Date(draft.event.time.end).toLocaleString("zh-CN", {
                timeZone: CALENDAR_TIME_ZONE,
              })}{" "}
              · {draft.event.location || "未指定地点"}
            </p>
            <p className="text-sm">
              保留原日程与参与人，确认后更新。状态：
              {draft.status === "checking"
                ? "等待确认"
                : draft.status === "pending"
                  ? "等待你确认"
                  : "待核对执行结果"}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={
                  confirmChange.isPending ||
                  cancelChange.isPending ||
                  (draft.status === "pending" &&
                    new Date(draft.expiresAt).getTime() <= Date.now())
                }
                onClick={() => confirmChange.mutate({ draftId: draft.id })}
              >
                {draft.status === "pending"
                  ? "确认改期并更新原会议"
                  : "核对原改期操作"}
              </Button>
              {["pending", "checking"].includes(draft.status) && (
                <Button
                  variant="outline"
                  disabled={confirmChange.isPending || cancelChange.isPending}
                  onClick={() => cancelChange.mutate({ draftId: draft.id })}
                >
                  取消改期请求
                </Button>
              )}
            </div>
          </article>
        ))}
    </section>
  );
}

function RescheduleEditor({
  event,
  busy,
  onSave,
  onCancel,
}: {
  event: MeetingPayload["event"];
  busy: boolean;
  onSave: (event: MeetingPayload["event"]) => void;
  onCancel: () => void;
}) {
  const local = calendarInputValue;
  const [start, setStart] = useState(local(event.time.start));
  const [end, setEnd] = useState(local(event.time.end));
  const [location, setLocation] = useState(event.location);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-3 rounded border p-4"
      onSubmit={e => {
        e.preventDefault();
        if (!start || !end || Date.parse(end) <= Date.parse(start)) {
          setError("请选择有效的起止时间");
          return;
        }
        onSave({
          ...event,
          location,
          time: {
            type: "timed",
            start: calendarInputInstant(start),
            end: calendarInputInstant(end),
          },
        });
      }}
    >
      <h3 className="font-medium">准备改期：{event.title}</h3>
      <label className="block">
        新开始时间
        <input
          required
          type="datetime-local"
          value={start}
          onChange={e => setStart(e.target.value)}
          className="ml-2 rounded border p-2"
        />
      </label>
      <label className="block">
        新结束时间
        <input
          required
          type="datetime-local"
          value={end}
          onChange={e => setEnd(e.target.value)}
          className="ml-2 rounded border p-2"
        />
      </label>
      <label className="block">
        新地点
        <input
          maxLength={300}
          value={location}
          onChange={e => setLocation(e.target.value)}
          className="ml-2 rounded border p-2"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={busy} type="submit">
          生成改期草稿
        </Button>
        <Button
          disabled={busy}
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          返回
        </Button>
      </div>
    </form>
  );
}
