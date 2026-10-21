import { trpc } from "@/lib/trpc";

// Uses the existing collaboration contract; calendar grants remain independent.
export function AssistantCollaborationSettings({
  adoptId,
}: {
  adoptId: string;
}) {
  const utils = trpc.useUtils();
  const settings = trpc.scheduling.assistantPreferences.useQuery({ adoptId });
  const save = trpc.scheduling.saveAssistantPreferences.useMutation({
    onSuccess: async () => {
      await utils.scheduling.assistantPreferences.invalidate({ adoptId });
      await utils.collab.getSettings.invalidate({ adoptId });
    },
  });
  const data = settings.data;
  const errors = [settings.error, save.error].filter(Boolean);
  return (
    <section className="assistant-collaboration-settings space-y-4 rounded-lg border p-4">
      <div>
        <h2 className="font-medium">助手间日程协作</h2>
        <p className="text-sm text-muted-foreground">
          仅配置日程协作，不改变其他协作权限。日历修改仍需本人确认。
        </p>
      </div>
      {errors.map((error, index) => (
        <p key={index} role="alert" className="text-sm text-destructive">
          {error!.message}
        </p>
      ))}
      {data && (
        <div className="assistant-collaboration-settings__controls flex flex-wrap items-end gap-4">
          <label className="calendar-setting-select flex flex-col gap-1 text-sm">
            接收日程协作
            <select
              aria-label="接收日程协作"
              className="rounded border bg-background px-3 py-2"
              value={data.acceptTask}
              disabled={save.isPending}
              onChange={event =>
                save.mutate({
                  adoptId,
                  acceptTask: event.target.value as "off" | "approval" | "auto",
                })
              }
            >
              <option value="off">关闭</option>
              <option value="approval">逐次批准</option>
              <option value="auto">按已有授权自动接收</option>
            </select>
          </label>
          <label className="calendar-setting-toggle flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.sharingPolicy === "result-only"}
              disabled={save.isPending}
              onChange={event =>
                save.mutate({
                  adoptId,
                  sharingPolicy: event.target.checked ? "result-only" : "none",
                })
              }
            />
            <span>允许分享协作结论</span>
          </label>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        自动回复忙闲还需要在本人日历设置中开启授权；未授权时等待审批，不会读取其他人的日历。
      </p>
    </section>
  );
}
