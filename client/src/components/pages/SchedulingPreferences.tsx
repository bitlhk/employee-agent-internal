import { useState } from "react";
import { CALENDAR_TIME_ZONE } from "@/lib/calendar-time";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
export function SchedulingPreferences() {
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const status = trpc.scheduling.status.useQuery();
  const utils = trpc.useUtils();
  const policy = trpc.scheduling.setAutoAvailability.useMutation({
    onSuccess: () => utils.scheduling.status.invalidate(),
  });
  const saveZone = trpc.scheduling.setTimeZone.useMutation({
    onSuccess: async () => {
      setTimeZone(null);
      await utils.scheduling.invalidate();
    },
  });
  return (
    <section className="calendar-preferences-section space-y-4 rounded-xl border p-6">
      <h2 className="text-xl font-semibold">忙闲回复设置</h2>
      <label className="calendar-setting-toggle flex items-start gap-3">
        <input
          type="checkbox"
          checked={status.data?.autoAvailability ?? true}
          disabled={!status.data?.enabled || policy.isPending}
          onChange={e => policy.mutate({ enabled: e.target.checked })}
        />
        <span>
          允许我的日程助手自动回复忙闲查询
          <span className="mt-1 block text-sm text-muted-foreground">
            仅分享候选时间是否有空，不分享日程标题或地点。关闭后由你决定是否回复，不影响本人日程查询。
          </span>
        </span>
      </label>
      {policy.error && <p role="alert">{policy.error.message}</p>}
      <form
        className="calendar-timezone-form space-y-2"
        onSubmit={e => {
          e.preventDefault();
          saveZone.mutate({
            timeZone: timeZone ?? (status.data?.timeZone || CALENDAR_TIME_ZONE),
          });
        }}
      >
        <label className="block text-sm">
          本人日历时区
          <input
            value={timeZone ?? (status.data?.timeZone || CALENDAR_TIME_ZONE)}
            onChange={e => setTimeZone(e.target.value)}
            maxLength={100}
            className="ml-2 rounded border p-2"
          />
        </label>
        <p className="text-sm text-muted-foreground">
          请与日历中的时区保持一致，用于准确判断全天日程。
          {!status.data?.timeZone &&
            "尚未保存时区，遇到全天日程会保守返回未知。"}
        </p>
        <Button
          type="submit"
          variant="outline"
          disabled={!status.data?.enabled || saveZone.isPending}
        >
          保存本人时区
        </Button>
        {saveZone.error && <p role="alert">{saveZone.error.message}</p>}
      </form>
    </section>
  );
}
