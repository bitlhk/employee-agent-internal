import type {
  AvailabilityMatrix,
  AvailabilityCell,
} from "../../../shared/scheduling-progress";
import { calendarFormat } from "@/lib/calendar-time";
import { trpc } from "@/lib/trpc";

const labels: Record<AvailabilityCell, string> = {
  free: "空闲",
  busy: "冲突",
  pending: "待批准",
  running: "查询中",
  unknown: "未知",
  unshared: "未授权分享",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "查询失败",
  expired: "已过期",
  unasked: "未询问",
};
export function SchedulingAvailabilityMatrix({
  matrix,
}: {
  matrix: AvailabilityMatrix;
}) {
  if (!matrix.rows.length)
    return (
      <p className="text-sm text-muted-foreground">
        候选时间确定后，将在这里显示每个人的忙闲进展。
      </p>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        北京时间 · 仅展示忙闲，未知或过期不代表空闲
      </p>
      <div
        className="overflow-x-auto rounded-lg border"
        tabIndex={0}
        role="region"
        aria-label="参与人忙闲矩阵"
      >
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="bg-muted/40">
              <th className="sticky left-0 z-10 bg-background p-3 min-w-[190px]">
                候选时间
              </th>
              {matrix.people.map(person => (
                <th
                  key={person.id}
                  className="p-3 min-w-[100px] whitespace-nowrap"
                >
                  {person.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map(row => (
              <tr
                key={`${row.start}/${row.end}`}
                className={
                  row.common
                    ? "border-t bg-emerald-50 dark:bg-emerald-950/30"
                    : "border-t"
                }
              >
                <th
                  className={`sticky left-0 z-10 p-3 font-normal whitespace-nowrap ${row.common ? "bg-emerald-50 dark:bg-emerald-950" : "bg-background"}`}
                >
                  <div>
                    {calendarFormat(row.start, {
                      month: "numeric",
                      day: "numeric",
                      weekday: "short",
                    })}
                  </div>
                  <div>
                    {calendarFormat(row.start, {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                    –
                    {calendarFormat(row.end, {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </div>
                  {row.common && (
                    <span className="text-xs text-emerald-700 dark:text-emerald-300">
                      共同空闲
                    </span>
                  )}
                </th>
                {row.cells.map((cell, index) => (
                  <td
                    key={matrix.people[index].id}
                    className={`p-3 whitespace-nowrap ${cell === "free" ? "text-emerald-700 dark:text-emerald-300" : cell === "busy" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                  >
                    {labels[cell]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
export function GoalAvailability({
  adoptId,
  id,
}: {
  adoptId: string;
  id: string;
}) {
  const query = trpc.collab.goalAvailability.useQuery(
    { adoptId, id },
    { refetchInterval: 10000 }
  );
  if (query.error)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        暂时无法更新忙闲进展，正在等待重试。
      </p>
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        正在读取协调进展…
      </p>
    );
  return <SchedulingAvailabilityMatrix matrix={query.data} />;
}
