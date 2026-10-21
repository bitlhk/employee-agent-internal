import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  CALENDAR_TIME_ZONE,
  calendarFormat,
  calendarInputValue,
  calendarInputInstant,
} from "@/lib/calendar-time";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Plus,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
import type { CalendarEvent } from "../../../shared/scheduling";
import "@/styles/scheduling.css";
import { CalendarBoard } from "@/components/pages/CalendarBoard";
import { schedulingTheme } from "@/lib/scheduling-theme";
import {
  calendarQueryRanges,
  dateKey,
  moveCalendarDate,
  type CalendarView,
} from "@/lib/calendar-view";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

function defaultDate() {
  return dateKey(new Date());
}

export function SchedulingCalendar({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const [date, setDate] = useState(defaultDate);
  const [view, setView] = useState<CalendarView>("week");
  const [selection, setSelection] = useState<CalendarEvent | null>(null);
  const [editor, setEditor] = useState<{
    editing: CalendarEvent | null;
  } | null>(null);
  const status = trpc.scheduling.status.useQuery();
  const utils = trpc.useUtils();
  const ranges = calendarQueryRanges(date, view);
  const canRead =
    enabled && Boolean(status.data?.configured && status.data.enabled);
  const first = trpc.scheduling.events.useQuery(ranges.first, {
    enabled: canRead,
    retry: false,
  });
  const second = trpc.scheduling.events.useQuery(
    ranges.second || ranges.first,
    { enabled: canRead && Boolean(ranges.second), retry: false }
  );
  const events = [
    ...new Map(
      [...(first.data || []), ...(ranges.second ? second.data || [] : [])].map(
        event => [event.id, event]
      )
    ).values(),
  ];
  const prepare = trpc.scheduling.prepareWrite.useMutation();
  const confirm = trpc.scheduling.confirmWrite.useMutation();
  const [deleting, setDeleting] = useState(false);
  const [deleteDraft, setDeleteDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteLock = useRef(false);
  const deleteOperation = useRef(crypto.randomUUID());
  const remove = async () => {
    if (!selection?.resourceId || !selection.version || deleteLock.current)
      return;
    deleteLock.current = true;
    setDeleting(true);
    let activeDraft = deleteDraft;
    try {
      const id =
        deleteDraft ||
        (
          await prepare.mutateAsync({
            operationId: deleteOperation.current,
            action: "delete",
            resourceId: selection.resourceId,
            version: selection.version,
            title: selection.title,
          })
        ).draftId;
      setDeleteDraft(id);
      activeDraft = id;
      await confirm.mutateAsync({ draftId: id });
      setDeleteDraft(null);
      setConfirmDelete(false);
      setSelection(null);
      await utils.scheduling.events.invalidate();
      toast.success("日程已删除");
    } catch {
      // Preserve unknown writes; an expired/rejected draft can be prepared again.
      const draft = (await utils.scheduling.drafts.fetch().catch(() => []))?.find(
        row => row.id === (activeDraft || deleteOperation.current)
      );
      if (
        draft &&
        (draft.status === "cancelled" ||
          (draft.status === "pending" &&
            new Date(draft.expiresAt).getTime() <= Date.now()))
      ) {
        setDeleteDraft(null);
        deleteOperation.current = crypto.randomUUID();
        await utils.scheduling.events.invalidate();
      } else if (draft) setDeleteDraft(draft.id);
    } finally {
      deleteLock.current = false;
      setDeleting(false);
    }
  };
  return (
    <div className="calendar-main">
      <div className="calendar-controls">
        <div className="calendar-heading">
          <h2>
            {calendarFormat(ranges.range.start, {
              year: "numeric",
              month: "long",
            })}
          </h2>
          <span>北京时间 · {CALENDAR_TIME_ZONE}</span>
        </div>
        <div className="calendar-controls__actions">
          <Button variant="outline" onClick={() => setDate(defaultDate())}>
            今天
          </Button>
          <Button
            variant="ghost"
            aria-label="上一段日期"
            onClick={() => setDate(moveCalendarDate(date, view, -1))}
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            variant="ghost"
            aria-label="下一段日期"
            onClick={() => setDate(moveCalendarDate(date, view, 1))}
          >
            <ChevronRight size={16} />
          </Button>
          <div
            className="calendar-view-switch"
            role="group"
            aria-label="日历视图"
          >
            {(["day", "week", "month"] as const).map(key => (
              <button
                type="button"
                key={key}
                aria-pressed={view === key}
                onClick={() => setView(key)}
              >
                {{ day: "日", week: "周", month: "月" }[key]}
              </button>
            ))}
          </div>
          <Button
            disabled={!canRead || !status.data?.writeEnabled}
            onClick={() => setEditor({ editing: null })}
          >
            <Plus size={16} />
            新建日程
          </Button>
        </div>
      </div>
      {(first.isFetching || Boolean(ranges.second && second.isFetching)) && (
        <p role="status" className="calendar-loading">
          正在更新日历…
        </p>
      )}
      {[
        first.error,
        ranges.second ? second.error : null,
        prepare.error,
        confirm.error,
      ]
        .filter(Boolean)
        .map((error, i) => (
          <p role="alert" key={i}>
            {error!.message}
          </p>
        ))}
      <CalendarBoard
        days={ranges.range.days}
        view={view}
        events={canRead ? events : []}
        onSelect={event => {
          deleteOperation.current = crypto.randomUUID();
          setSelection(event);
          setConfirmDelete(false);
          setDeleteDraft(null);
          prepare.reset();
          confirm.reset();
        }}
      />
      <Dialog
        open={Boolean(selection)}
        onOpenChange={open => {
          if (!open && !deleting) setSelection(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selection?.title || "日程详情"}</DialogTitle>
            <DialogDescription>查看这项安排的时间与地点。</DialogDescription>
          </DialogHeader>
          {selection && (
            <div className="space-y-4">
              <p>
                {selection.allDay
                  ? `${selection.start} 至 ${selection.end}（全天，结束日期不含当天）`
                  : `${calendarFormat(selection.start)} — ${calendarFormat(selection.end)}`}
              </p>
              <p>{selection.location || "未指定地点"}</p>
              {selection.organizer && (
                <p>
                  组织者：
                  {selection.organizer.name || selection.organizer.email}
                </p>
              )}
              {Boolean(selection.participants?.length) && (
                <p>
                  参与人：
                  {selection
                    .participants!.map(person => person.name || person.email)
                    .join("、")}
                </p>
              )}
              {confirmDelete && (
                <p role="alert">
                  确认删除这项日程？
                  {selection.participants?.length
                    ? "日历系统会同步取消参与人的安排。"
                    : ""}
                </p>
              )}
              {(prepare.error || confirm.error) && (
                <p role="alert">{(prepare.error || confirm.error)?.message}</p>
              )}
              {status.data?.writeEnabled &&
                selection.resourceId &&
                selection.version && (
                  <div className="flex gap-2">
                    <Button
                      disabled={deleting || Boolean(deleteDraft)}
                      onClick={() => {
                        setEditor({ editing: selection });
                        setSelection(null);
                      }}
                    >
                      修改安排
                    </Button>
                    <Button
                      variant="outline"
                      disabled={deleting}
                      onClick={() =>
                        confirmDelete ? void remove() : setConfirmDelete(true)
                      }
                    >
                      {deleting
                        ? "删除中…"
                        : deleteDraft
                          ? "核对并重试删除"
                          : confirmDelete
                            ? "确认删除"
                            : "删除日程"}
                    </Button>
                  </div>
                )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editor)}
        onOpenChange={open => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent
          className="scheduling-ui calendar-event-dialog"
          style={schedulingTheme}
        >
          <DialogHeader>
            <div className="calendar-event-dialog__heading">
              <span className="calendar-event-dialog__icon">
                <CalendarPlus aria-hidden="true" />
              </span>
              <div>
                <DialogTitle>
                  {editor?.editing ? "修改日程" : "新建日程"}
                </DialogTitle>
                <DialogDescription>
                  设置时间、地点，可添加组织内的参与人。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {editor && (
            <EventEditor
              key={editor.editing?.id || "new"}
              editing={editor.editing}
              onClose={() => setEditor(null)}
              onSaved={() => {
                setEditor(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function BindingSettings() {
  const { user } = useAuth();
  const [userId, setUserId] = useState("");
  const [username, setUsername] = useState("");
  const [calendarName, setCalendarName] = useState("personal");
  const [appPassword, setAppPassword] = useState("");
  const [calendarEmail, setCalendarEmail] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const utils = trpc.useUtils();
  const save = trpc.scheduling.saveBinding.useMutation({
    onSuccess: async () => {
      setAppPassword("");
      await utils.scheduling.invalidate();
    },
  });
  if (user?.role !== "admin") return null;
  return (
    <section className="space-y-4 rounded-xl border p-6">
      <h2 className="text-xl font-semibold">管理员：绑定日历账号</h2>
      <p className="text-sm text-muted-foreground">
        请为每位人员使用其自己的日历账号和应用密码。保存前请核对人员与账号归属。
      </p>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={e => {
          e.preventDefault();
          save.mutate({
            userId: Number(userId),
            username,
            calendarName,
            appPassword,
            enabled,
            writeEnabled,
            calendarEmail,
          });
        }}
      >
        <label>
          平台人员编号
          <input
            required
            min="1"
            type="number"
            value={userId}
            onChange={e => setUserId(e.target.value)}
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <label>
          日历账号
          <input
            required
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <label>
          日历名称
          <input
            required
            value={calendarName}
            onChange={e => setCalendarName(e.target.value)}
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <label>
          应用密码
          <input
            required
            type="password"
            autoComplete="new-password"
            value={appPassword}
            onChange={e => setAppPassword(e.target.value)}
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <label>
          日历邀请地址
          <input
            type="email"
            value={calendarEmail}
            onChange={e => setCalendarEmail(e.target.value)}
            className="mt-1 w-full rounded border p-2"
          />
          <span className="text-sm text-muted-foreground">
            需与 Nextcloud 账号的邮箱一致；留空时不能发送会议邀请。
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />{" "}
          启用本人日历读取
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={writeEnabled}
            onChange={e => setWriteEnabled(e.target.checked)}
          />{" "}
          允许本人确认后写入日历
        </label>
        <Button disabled={save.isPending} type="submit">
          {save.isPending ? "保存中…" : "保存绑定"}
        </Button>
      </form>
      {save.error && (
        <p role="alert" className="text-red-600">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && <p role="status">绑定已保存。</p>}
    </section>
  );
}

function localInput(value: string) {
  return calendarInputValue(value);
}

function EventEditor({
  editing,
  onClose,
  onSaved,
}: {
  editing: CalendarEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [participants, setParticipants] = useState(editing?.participants || []);
  const [formError, setFormError] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  const people = trpc.scheduling.searchPeople.useQuery(
    { query: peopleQuery.trim() },
    { enabled: Boolean(peopleQuery.trim()), retry: false }
  );
  const [title, setTitle] = useState(editing?.title || "");
  const [location, setLocation] = useState(editing?.location || "");
  const [allDay, setAllDay] = useState(editing?.allDay || false);
  const [start, setStart] = useState(
    editing ? (editing.allDay ? editing.start : localInput(editing.start)) : ""
  );
  const [end, setEnd] = useState(
    editing ? (editing.allDay ? editing.end : localInput(editing.end)) : ""
  );
  const utils = trpc.useUtils();
  const prepare = trpc.scheduling.prepareWrite.useMutation();
  const confirm = trpc.scheduling.confirmWrite.useMutation();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  return (
    <form
      className="calendar-event-form"
      onSubmit={async e => {
        e.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setSaving(true);
        prepare.reset();
        confirm.reset();
        let activeDraftId = draftId;
        setFormError("");
        if (participants.some(person => !person.userId)) {
          setFormError(
            "部分原参与人无法匹配组织成员，请移除并重新选择后保存。"
          );
          submitting.current = false;
          setSaving(false);
          return;
        }
        try {
          const event = {
            title,
            location,
            time: allDay
              ? { type: "allDay" as const, start, end }
              : {
                  type: "timed" as const,
                  start: calendarInputInstant(start),
                  end: calendarInputInstant(end),
                },
          };
          // The owner's Save action authorizes this exact form payload. Reuse the
          // existing checks and execution receipt; assistant drafts still require confirmation.
          if (!activeDraftId) {
            const prepared = await prepare.mutateAsync(
              editing
                ? {
                    operationId: operationId.current,
                    action: "update",
                    resourceId: editing.resourceId!,
                    version: editing.version!,
                    event,
                    participantIds: participants.map(person => person.userId!),
                  }
                : {
                    operationId: operationId.current,
                    action: "create",
                    event,
                    participantIds: participants.map(person => person.userId!),
                  }
            );
            activeDraftId = prepared.draftId;
            setDraftId(activeDraftId);
          }
          await confirm.mutateAsync({ draftId: activeDraftId });
          await Promise.all([
            utils.scheduling.events.invalidate(),
            utils.scheduling.drafts.invalidate(),
          ]);
          toast.success(editing ? "日程已修改" : "日程已保存");
          onSaved();
        } catch {
          {
            // Keep an uncertain receipt for safe retries rather than creating a second event.
            const drafts = await utils.scheduling.drafts
              .fetch()
              .catch(() => null);
            const draft = drafts?.find(draft => draft.id === (activeDraftId || operationId.current));
            if (
              draft &&
              (draft.status === "cancelled" ||
                (draft.status === "pending" &&
                  new Date(draft.expiresAt).getTime() <= Date.now()))
            ) {
              setDraftId(null);
              operationId.current = crypto.randomUUID();
            } else if (draft) setDraftId(draft.id);
          }
        } finally {
          submitting.current = false;
          setSaving(false);
        }
      }}
    >
      <fieldset
        className="calendar-event-form__body"
        disabled={saving || Boolean(draftId)}
      >
        <label className="calendar-event-field">
          <span>日程标题</span>
          <input
            autoFocus
            placeholder="这段时间准备做什么？"
            required
            maxLength={200}
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </label>
        <div className="calendar-event-time">
          <div className="calendar-event-time__header">
            <span>
              <Clock3 size={15} aria-hidden="true" />
              日程时间
            </span>
            <label className="calendar-event-allday">
              <input
                type="checkbox"
                checked={allDay}
                onChange={e => {
                  setAllDay(e.target.checked);
                  setStart("");
                  setEnd("");
                }}
              />
              全天
            </label>
          </div>
          <div className="calendar-event-time__range">
            <label className="calendar-event-field">
              <span>开始时间</span>
              <input
                required
                type={allDay ? "date" : "datetime-local"}
                value={start}
                onChange={e => setStart(e.target.value)}
              />
            </label>
            <label className="calendar-event-field">
              <span>{allDay ? "结束日期（不含当天）" : "结束时间"}</span>
              <input
                required
                type={allDay ? "date" : "datetime-local"}
                value={end}
                onChange={e => setEnd(e.target.value)}
              />
            </label>
          </div>
          {!allDay && (
            <p className="calendar-event-hint">
              时区：北京时间（{CALENDAR_TIME_ZONE}）
            </p>
          )}
        </div>
        <label className="calendar-event-field">
          <span>
            地点 <small>选填</small>
          </span>
          <input
            placeholder="添加会议室或线上会议链接"
            maxLength={300}
            value={location}
            onChange={e => setLocation(e.target.value)}
          />
        </label>
        <div className="calendar-event-field">
          <label htmlFor="calendar-participants">参与人（选填）</label>
          <input
            id="calendar-participants"
            value={peopleQuery}
            onChange={e => setPeopleQuery(e.target.value)}
            placeholder="查找同一组织的成员"
          />
          {people.error && <p role="status">{people.error.message}</p>}
          {people.isFetching && <p role="status">正在查找…</p>}
          {people.data?.length === 0 && <p>组织内未找到匹配成员。</p>}
          <div className="flex flex-wrap gap-2">
            {participants.map(person => (
              <Button
                key={person.userId || person.email}
                type="button"
                variant="outline"
                onClick={() =>
                  setParticipants(current => current.filter(p => p !== person))
                }
              >
                {person.name || person.email} ×
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {people.data
              ?.filter(
                person => !participants.some(p => p.userId === person.userId)
              )
              .map(person => (
                <Button
                  key={person.userId}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setParticipants(current => [
                      ...current,
                      {
                        userId: person.userId,
                        name: person.name || "组织成员",
                        email: "",
                      },
                    ]);
                    setPeopleQuery("");
                  }}
                >
                  {person.name || "组织成员"}
                  {person.departmentName ? ` · ${person.departmentName}` : ""}
                </Button>
              ))}
          </div>
        </div>
      </fieldset>
      {formError && <p role="alert">{formError}</p>}
      {(prepare.error || confirm.error) && (
        <p role="alert" className="calendar-event-form__error">
          {(prepare.error || confirm.error)?.message}
          {draftId ? "；重试保存会核对同一条日程，请保留当前窗口。" : ""}
        </p>
      )}
      <div className="calendar-event-form__footer">
        <p>保存到我的日历</p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && (
              <Loader2 className="animate-spin" size={14} aria-hidden="true" />
            )}
            {saving ? "保存中…" : draftId ? "重试保存" : "保存日程"}
          </Button>
        </div>
      </div>
    </form>
  );
}
