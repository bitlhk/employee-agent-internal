import { CALENDAR_TIME_ZONE } from "@/lib/calendar-time";
import { SchedulingChatConfirmations } from "./SchedulingChatConfirmations";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";

const busyLabels = { free: "有空", busy: "忙碌", unknown: "未知" };
const statusLabels = {
  collecting: "正在收集回复",
  completed: "回复已收集",
  cancelled: "已取消",
  expired: "已过期",
};
const slotLabel = (slot: { start: string; end: string }) =>
  `${new Date(slot.start).toLocaleString("zh-CN", { timeZone: CALENDAR_TIME_ZONE })} — ${new Date(slot.end).toLocaleTimeString("zh-CN", { timeZone: CALENDAR_TIME_ZONE })}`;

export function SchedulingAvailabilityActions({
  focusId,
}: {
  focusId: string;
}) {
  const [locations, setLocations] = useState<Record<string, string>>({});
  const utils = trpc.useUtils();
  const records = trpc.scheduling.coordinations.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const incoming = trpc.scheduling.incomingCoordination.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const status = trpc.scheduling.status.useQuery();
  const refresh = async () => {
    await utils.scheduling.coordinations.invalidate();
    await utils.scheduling.incomingCoordination.invalidate();
  };
  const respond = trpc.scheduling.respondCoordination.useMutation({
    onSuccess: refresh,
  });
  const recollect = trpc.scheduling.refreshCoordination.useMutation({
    onSuccess: refresh,
  });
  const cancel = trpc.scheduling.cancelCoordination.useMutation({
    onSuccess: refresh,
  });
  const prepareMeeting = trpc.scheduling.prepareMeeting.useMutation({
    onSuccess: () => utils.scheduling.meetings.invalidate(),
  });
  const recheck = trpc.scheduling.recheckConflicts.useMutation({
    onSuccess: refresh,
  });
  return (
    <div className="space-y-4">
      {prepareMeeting.data && (
        <SchedulingChatConfirmations
          references={[{ kind: "meeting", id: prepareMeeting.data.meetingId }]}
        />
      )}
      <section
        hidden={Boolean(
          focusId && !incoming.data?.some(task => task.taskId === focusId)
        )}
        className="space-y-4 rounded-xl border p-6"
      >
        <h2 className="text-xl font-semibold">收到的忙闲查询</h2>
        {incoming.error && <p role="alert">{incoming.error.message}</p>}
        {respond.error && <p role="alert">{respond.error.message}</p>}
        {incoming.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">暂无待回复请求。</p>
        )}
        {incoming.data
          ?.filter(task => !focusId || task.taskId === focusId)
          .map(task => (
            <article key={task.taskId} className="space-y-2 rounded border p-4">
              <h3 className="font-medium">{task.title}</h3>
              {task.conflictRecheck && (
                <p className="text-sm">
                  对方希望再次协商冲突时段。你可以自行调整原日程后查询并回复，或选择不回复。助手不会替你移动原日程。
                </p>
              )}
              <ul>
                {task.slots.map((slot, index) => (
                  <li key={index}>{slotLabel(slot)}</li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button
                  disabled={respond.isPending}
                  onClick={() =>
                    respond.mutate({ taskId: task.taskId, action: "reply" })
                  }
                >
                  查询本人日历并回复
                </Button>
                <Button
                  variant="outline"
                  disabled={respond.isPending}
                  onClick={() =>
                    respond.mutate({ taskId: task.taskId, action: "decline" })
                  }
                >
                  不回复
                </Button>
              </div>
            </article>
          ))}
      </section>
      <section
        hidden={Boolean(
          focusId && !records.data?.some(record => record.id === focusId)
        )}
        className="space-y-4 rounded-xl border p-6"
      >
        <h2 className="text-xl font-semibold">协调记录</h2>
        <p className="text-sm text-muted-foreground">
          回复是查询当时的快照，可据此选择时间。保存日程无需等待邀请回复。
        </p>
        {[
          records.error,
          recollect.error,
          cancel.error,
          prepareMeeting.error,
          recheck.error,
        ]
          .filter(Boolean)
          .map((error, index) => (
            <p key={index} role="alert">
              {error!.message}
            </p>
          ))}
        {records.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">暂无协调记录。</p>
        )}
        {records.data
          ?.filter(record => record.id === focusId)
          ?.map(record => (
            <article key={record.id} className="space-y-3 rounded border p-4">
              <h3 className="font-medium">
                {record.title} · {statusLabels[record.status]}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="p-2 text-left">候选时间</th>
                      {record.members.map(member => (
                        <th key={member.userId} className="p-2">
                          {member.name}（{member.userId}）
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {record.slots.map((slot, index) => (
                      <tr key={index} className="border-t">
                        <td className="p-2">{slotLabel(slot)}</td>
                        {record.members.map(member => (
                          <td key={member.userId} className="p-2 text-center">
                            {member.status === "declined"
                              ? "未回复"
                              : busyLabels[member.reply[index]]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                {record.commonIndices.length
                  ? `共同可用：${record.commonIndices.map(index => slotLabel(record.slots[index])).join("；")}`
                  : record.status === "collecting"
                    ? "正在等待回复；未知不代表有空。"
                    : "尚无已核实的共同可用时间。"}
              </p>
              {record.status === "completed" &&
                !record.commonIndices.length &&
                record.members.some(member =>
                  member.reply.includes("busy")
                ) && (
                  <Button
                    variant="outline"
                    disabled={recheck.isPending}
                    onClick={() => recheck.mutate({ id: record.id })}
                  >
                    再次询问有冲突的人
                  </Button>
                )}
              {record.commonIndices.length > 0 && (
                <div className="space-y-2">
                  <label className="block text-sm">
                    会议地点（可选）
                    <input
                      maxLength={300}
                      value={locations[record.id] || ""}
                      onChange={e =>
                        setLocations({
                          ...locations,
                          [record.id]: e.target.value,
                        })
                      }
                      className="mt-1 w-full rounded border p-2"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {record.commonIndices.map(index => (
                      <Button
                        key={index}
                        variant="outline"
                        disabled={
                          prepareMeeting.isPending || !status.data?.writeEnabled
                        }
                        onClick={() =>
                          prepareMeeting.mutate({
                            coordinationId: record.id,
                            slotIndex: index,
                            location: locations[record.id] || "",
                          })
                        }
                      >
                        准备会议：{slotLabel(record.slots[index])}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {record.status === "collecting" && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={recollect.isPending}
                    onClick={() => recollect.mutate({ id: record.id })}
                  >
                    继续收集回复
                  </Button>
                  <Button
                    variant="outline"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate({ id: record.id })}
                  >
                    取消协调
                  </Button>
                </div>
              )}
            </article>
          ))}
      </section>
    </div>
  );
}
