import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
import { SchedulingChatConfirmations } from "./SchedulingChatConfirmations";
import { GoalAvailability } from "./SchedulingAvailabilityMatrix";
const progress = {
  ready: { label: "准备中", hint: "助手即将开始处理，完成后会在这里回复。" },
  running: { label: "处理中", hint: "助手正在协调安排，有结果后会自动回复。" },
  waiting: {
    label: "等待回复",
    hint: "正在等待相关人员的协作结果，收到后会自动继续。",
  },
  waiting_user: {
    label: "需要你补充",
    hint: "请查看详细进展，补充要求后继续。",
  },
  completed: {
    label: "已完成",
    hint: "协调结果已整理，请查看对话中的方案或建议。",
  },
  failed: {
    label: "暂未完成",
    hint: "请查看详细进展，补充要求后可以继续处理。",
  },
  cancelled: {
    label: "已停止",
    hint: "已停止后续办理。",
  },
};
export function CollaborationActivity({
  adoptId,
  focusId,
  onOpenCalendar,
}: {
  adoptId: string;
  focusId: string;
  onOpenCalendar?: () => void;
}) {
  const utils = trpc.useUtils();
  const goals = trpc.collab.goals.useQuery(
    { adoptId },
    { refetchInterval: 5000 }
  );
  const cancel = trpc.collab.cancelGoal.useMutation({
    onSuccess: () => utils.collab.goals.invalidate(),
  });
  const resume = trpc.collab.resumeGoal.useMutation({
    onSuccess: () => {
      setEditing(null);
      setInstruction("");
      return utils.collab.goals.invalidate();
    },
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const visibleGoals = goals.data?.filter(goal => goal.id === focusId) || [];
  if (!visibleGoals.length) return null;
  return (
    <div className="space-y-4 py-4" aria-label="本会话协作办理进度">
      {visibleGoals.map(goal => {
        const hasConfirmations = Boolean(goal.confirmations?.length);
        const status =
          hasConfirmations && goal.status === "waiting"
            ? {
                label: "需要你确认",
                hint: "请核对下方安排，确认后才会修改日历。",
              }
            : goal.status === "completed" && goal.calendarUpdated
              ? { label: "已完成", hint: "日历已更新，可以查看日历核对安排。" }
              : progress[goal.status];
        return (
          <section
            key={goal.id}
            className="rounded-xl border border-border bg-background p-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">日程协作</h3>
              <span
                className={`rounded-full px-2 py-1 text-xs ${status.label === "需要你确认" || goal.status === "waiting_user" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                {status.label}
              </span>
            </div>
            <p className="text-sm text-muted-foreground" role="status">
              {status.hint}
            </p>
            <SchedulingChatConfirmations
              // Confirmation remains on this same updating coordination card.
              references={goal.confirmations || []}
              onOpenCalendar={onOpenCalendar}
            />
            <GoalAvailability adoptId={adoptId} id={goal.id} />
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                查看详细进展与任务说明
              </summary>
              <div className="mt-3 space-y-3 text-muted-foreground break-words">
                {goal.message && (
                  <p className="whitespace-pre-wrap">{goal.message}</p>
                )}
                <div>
                  <p className="mb-1 font-medium">任务说明</p>
                  <p className="whitespace-pre-wrap">{goal.objective}</p>
                </div>
              </div>
            </details>
            <div className="flex flex-wrap gap-3 items-center">
              {goal.calendarUpdated && onOpenCalendar && (
                <button
                  type="button"
                  className="text-sm underline underline-offset-4"
                  onClick={onOpenCalendar}
                >
                  查看日历
                </button>
              )}
              {!["completed", "cancelled", "failed"].includes(goal.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate({ adoptId, id: goal.id })}
                >
                  停止协作
                </Button>
              )}
              {["waiting_user", "failed"].includes(goal.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(goal.id)}
                >
                  补充要求
                </Button>
              )}
            </div>
            {editing === goal.id && (
              <div className="space-y-2">
                <textarea
                  aria-label="补充办理要求"
                  className="w-full rounded border bg-background p-2 text-sm"
                  value={instruction}
                  maxLength={2000}
                  onChange={event => setInstruction(event.target.value)}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setInstruction("");
                  }}
                >
                  取消
                </Button>
                <Button
                  disabled={!instruction.trim() || resume.isPending}
                  onClick={() =>
                    resume.mutate({ adoptId, id: goal.id, instruction })
                  }
                >
                  提交并继续
                </Button>
              </div>
            )}
          </section>
        );
      })}
      {(cancel.error || resume.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(cancel.error || resume.error)!.message}
        </p>
      )}
    </div>
  );
}
