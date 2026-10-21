import { trpc } from "@/lib/trpc";
import { Button } from "./ui/action-button";
import { calendarFormat } from "@/lib/calendar-time";

const replyLabels = {
  available: "可以安排在以下时段。",
  unavailable: "无法安排在本次询问的时段。",
  conditional: "需要进一步协调时间。",
  unknown: "暂时无法确认忙闲，需要进一步核实。",
};
const timeLabel = (value: string) =>
  calendarFormat(value, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const requestStatusText: Record<string, string> = {
  approved: "已批准，等待助手处理本次询问。",
  running: "已批准，助手正在处理本次询问。",
  completed: "助手已完成本次询问。发起方助手会根据结果继续回复。",
  rejected: "你已拒绝本次协作，助手不会执行这次询问。",
  cancelled: "本次协作已取消。",
  failed: "本次协作处理失败，请查看助手的说明。",
  partial_success: "本次协作部分完成，请查看助手的说明。",
  waiting_input: "本次协作需要补充信息，请查看助手的说明。",
};

export function SchedulingRequestAction({
  adoptId,
  requestId,
}: {
  adoptId: string;
  requestId: number;
}) {
  const utils = trpc.useUtils();
  const incoming = trpc.collab.schedulingRequestProgress.useQuery(
    { adoptId, requestId },
    { refetchInterval: 10000 }
  );
  const review = trpc.collab.reviewRequest.useMutation({
    onSuccess: async () => {
      await utils.collab.incoming.invalidate({ adoptId });
      await utils.collab.schedulingRequestProgress.invalidate({
        adoptId,
        requestId,
      });
    },
  });
  const request = incoming.data;
  return (
    <div
      className="space-y-2 rounded border p-3"
      data-collaboration-request-id={requestId}
    >
      {incoming.error && <p role="alert">{incoming.error.message}</p>}
      {review.error && <p role="alert">{review.error.message}</p>}
      {request && (
        <>
          <h3 className="text-sm font-medium">
            {request.requesterName}发来的日程询问
          </h3>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">查看询问内容</summary>
            <p className="mt-2 whitespace-pre-wrap">{request.taskSummary}</p>
          </details>
        </>
      )}
      {request?.status === "pending" ? (
        <>
          <p>批准后允许助手处理这次询问，修改日历仍需另行确认。</p>
          <div className="flex gap-2">
            <Button
              disabled={review.isPending}
              onClick={() =>
                review.mutate({ adoptId, requestId, action: "approve" })
              }
            >
              批准本次协作
            </Button>
            <Button
              variant="outline"
              disabled={review.isPending}
              onClick={() =>
                review.mutate({ adoptId, requestId, action: "reject" })
              }
            >
              拒绝
            </Button>
          </div>
        </>
      ) : (
        <p role="status">
          {incoming.isLoading
            ? "正在读取请求状态…"
            : incoming.error
              ? "暂时无法读取请求状态，请稍后重试。"
              : request
                ? requestStatusText[request.status] || "请求状态已更新。"
                : "当前列表中未找到这条请求，暂时无法确认其状态。"}
        </p>
      )}
      {request?.status === "completed" && (
        <div className="space-y-1 rounded bg-muted/40 p-3 text-sm">
          <p className="font-medium">本次回复</p>
          {request.reply ? (
            <>
              <p>{replyLabels[request.reply.availability]}</p>
              {request.reply.slots.map(slot => (
                <p key={`${slot.start}/${slot.end}`}>
                  {timeLabel(slot.start)}–{timeLabel(slot.end)}（北京时间）
                </p>
              ))}
              {!!request.reply.observations?.length && (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    查看回复时的忙闲
                  </summary>
                  {request.reply.observations.map(slot => (
                    <p key={`${slot.start}/${slot.end}`}>
                      {timeLabel(slot.start)}–{timeLabel(slot.end)}
                      （北京时间）：
                      {
                        { free: "空闲", busy: "有冲突", unknown: "未能确认" }[
                          slot.availability
                        ]
                      }
                    </p>
                  ))}
                </details>
              )}
              <p className="text-xs text-muted-foreground">
                以上为本次回复时的结论，不代表当前忙闲。
              </p>
            </>
          ) : (
            <p>未保存可展示的回复内容。</p>
          )}
        </div>
      )}
    </div>
  );
}
