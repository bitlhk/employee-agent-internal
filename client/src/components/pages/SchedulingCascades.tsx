import { CALENDAR_TIME_ZONE } from "@/lib/calendar-time";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/confirmation-dialog";
const labels: Record<string, string> = {
  drafting: "正在准备",
  pending: "等待整组确认",
  confirmed: "已确认，等待执行",
  running: "正在逐步调整",
  waiting: "等待忙闲复核或核对写入",
  completed: "整组调整完成",
  partial: "部分调整完成，需要处理",
  compensating: "正在恢复已调整的安排",
  compensated: "已恢复原安排",
  cancelled: "已停止",
  failed: "未完成，需要重新协商",
};
export function SchedulingCascades({ focusId }: { focusId?: string } = {}) {
  const utils = trpc.useUtils();
  const plans = trpc.scheduling.cascades.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const refresh = async () => {
    await utils.scheduling.cascades.invalidate();
    await utils.scheduling.meetings.invalidate();
    await utils.scheduling.events.invalidate();
  };
  const confirm = trpc.scheduling.confirmCascade.useMutation({
    onSuccess: refresh,
    onError: refresh,
  });
  const stop = trpc.scheduling.stopCascade.useMutation({ onSuccess: refresh });
  const [approval, setApproval] = useState<{
    id: string;
    planHash: string;
    compensate: boolean;
    title: string;
  } | null>(null);
  if (!plans.data?.length && !plans.error) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">关联日程调整</h2>
      {[plans.error, confirm.error, stop.error]
        .filter(Boolean)
        .map((error, index) => (
          <p role="alert" key={index}>
            {error!.message}
          </p>
        ))}
      {plans.data
        ?.filter(plan => !focusId || plan.id === focusId)
        .map(plan => (
          <article key={plan.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex justify-between gap-3">
              <h3 className="font-medium">{plan.title}</h3>
              <span className="text-sm text-muted-foreground">
                {labels[plan.status]}
              </span>
            </div>
            <ol className="space-y-3">
              {plan.steps.map(step => (
                <li key={step.key} className="text-sm">
                  <strong>
                    步骤 {step.key} · {step.previous.title}
                    {step.event.title !== step.previous.title
                      ? ` → ${step.event.title}`
                      : ""}
                  </strong>
                  <p>
                    原安排：
                    {new Date(step.previous.time.start).toLocaleString(
                      "zh-CN",
                      { timeZone: CALENDAR_TIME_ZONE, timeZoneName: "short" }
                    )}{" "}
                    —{" "}
                    {new Date(step.previous.time.end).toLocaleString("zh-CN", {
                      timeZone: CALENDAR_TIME_ZONE,
                      timeZoneName: "short",
                    })}
                  </p>
                  <p>
                    新安排：
                    {new Date(step.event.time.start).toLocaleString("zh-CN", {
                      timeZone: CALENDAR_TIME_ZONE,
                      timeZoneName: "short",
                    })}{" "}
                    —{" "}
                    {new Date(step.event.time.end).toLocaleString("zh-CN", {
                      timeZone: CALENDAR_TIME_ZONE,
                      timeZoneName: "short",
                    })}
                  </p>
                  <p>
                    地点：{step.previous.location || "未指定"} →{" "}
                    {step.event.location || "未指定"}
                  </p>
                  <p>
                    参会人：
                    {step.participants?.length
                      ? step.participants
                          .map(person => person.name || `人员${person.userId}`)
                          .join("、")
                      : "沿用原会议参与人"}
                  </p>
                  <p className="text-muted-foreground">
                    {step.compensated
                      ? "已恢复原安排"
                      : step.state === "completed"
                        ? "调整已完成"
                        : step.state === "waiting"
                          ? "等待复核"
                          : "尚未调整"}
                    {step.dependsOn.length
                      ? ` · 等待前置步骤：${step.dependsOn.join("、")}`
                      : ""}
                  </p>
                </li>
              ))}
            </ol>
            {plan.errorCode && (
              <p role="status" className="text-sm">
                {plan.errorCode === "VERIFY_REQUIRED"
                  ? "有步骤的写入结果尚待核对，后续步骤不会提前执行。"
                  : "安排、授权或版本发生变化。已完成的调整会保留，请选择恢复原安排或重新协商。"}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {plan.status === "pending" && (
                <Button
                  disabled={
                    confirm.isPending ||
                    new Date(plan.expiresAt).getTime() <= Date.now()
                  }
                  onClick={() =>
                    setApproval({
                      id: plan.id,
                      planHash: plan.planHash,
                      compensate: false,
                      title: plan.title,
                    })
                  }
                >
                  确认整组调整
                </Button>
              )}
              {["pending", "confirmed", "running", "waiting"].includes(
                plan.status
              ) && (
                <Button
                  variant="outline"
                  disabled={stop.isPending || plan.stopRequested}
                  onClick={() => stop.mutate({ id: plan.id })}
                >
                  {plan.stopRequested ? "正在停止后续步骤" : "停止后续调整"}
                </Button>
              )}
              {["partial", "completed"].includes(plan.status) &&
                plan.steps.some(
                  step => step.state === "completed" && !step.compensated
                ) && (
                  <Button
                    variant="outline"
                    disabled={confirm.isPending}
                    onClick={() =>
                      setApproval({
                        id: plan.id,
                        planHash: plan.planHash,
                        compensate: true,
                        title: plan.title,
                      })
                    }
                  >
                    恢复已调整的原安排
                  </Button>
                )}
            </div>
          </article>
        ))}
      <AlertDialog
        open={Boolean(approval)}
        onOpenChange={open => {
          if (!open) setApproval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {approval?.compensate ? "确认恢复原安排" : "确认关联日程调整"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {approval?.compensate
                ? `将按相反依赖顺序恢复「${approval.title}」中已完成的步骤。原安排被其他人修改或时间已不合适时会停止，不会强制覆盖。`
                : `确认执行「${approval?.title}」上方列出的全部改期。每一步都会重新核对授权、版本和忙闲；部分成功时不会擅自撤销已完成的调整。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>返回核对</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (approval)
                  confirm.mutate({
                    id: approval.id,
                    planHash: approval.planHash,
                    compensate: approval.compensate,
                  });
                setApproval(null);
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
