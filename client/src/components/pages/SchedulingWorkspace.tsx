import { useAuth } from "@/_core/hooks/useAuth";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, Settings2 } from "lucide-react";

import "@/styles/scheduling.css";
import { SchedulingPreferences } from "./SchedulingPreferences";
import { SchedulingConnection } from "./SchedulingConnection";
import { SchedulingCalendar, BindingSettings } from "@/pages/Scheduling";
import { schedulingTheme } from "@/lib/scheduling-theme";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
import { AssistantCollaborationSettings } from "./AssistantCollaborationSettings";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SchedulingWorkspace({
  initialPage = "calendar",
  adoptId,
}: {
  initialPage?: "calendar" | "settings";
  adoptId?: string;
}) {
  const [settings, setSettings] = useState(initialPage === "settings");
  const { user } = useAuth();
  const status = trpc.scheduling.status.useQuery();
  const utils = trpc.useUtils();
  const attempted = useRef(false);
  const ensure = trpc.scheduling.ensureCalendar.useMutation({
    retry: false,
    onSuccess: () => utils.scheduling.status.invalidate(),
  });
  const ensureCalendar = ensure.mutate;
  useEffect(() => {
    if (!status.isLoading && !status.error && !attempted.current) {
      attempted.current = true;
      ensureCalendar();
    }
  }, [status.isLoading, status.error, ensureCalendar]);
  const ready = Boolean(status.data?.enabled);
  const provisioningState = ensure.data?.state;
  return (
    <div
      style={schedulingTheme}
      className="scheduling-ui scheduling-embedded calendar-workspace"
    >
      <div className="calendar-workspace__toolbar">
        <div className="calendar-workspace__title">
          <CalendarDays size={19} />
          我的日历
        </div>
        <div className="calendar-workspace__tools">
          <Button
            variant="ghost"
            aria-label="日历偏好设置"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={17} />
          </Button>
        </div>
      </div>
      <div className="scheduling-embedded-content calendar-workspace__content">
        {status.error && <p role="alert">暂时无法读取日历状态，请稍后重试。</p>}
        {!ready && (
          <div className="scheduling-status-notice" role="status">
            <span>
              {ensure.isPending || status.isLoading
                ? "正在准备你的个人日历…"
                : provisioningState === "disabled"
                  ? "日历已停用，请联系管理员恢复；原有日程会保留。"
                  : provisioningState === "not_configured"
                    ? "日历服务尚未开通，请联系管理员配置。"
                    : "日历准备暂未完成，可以重试，已有安排不会被覆盖。"}
            </span>
            {!ensure.isPending &&
              !status.isLoading &&
              provisioningState !== "disabled" && (
                <Button variant="outline" onClick={() => ensure.mutate()}>
                  重试
                </Button>
              )}
            {ensure.error && <p role="alert">日历服务暂不可用。</p>}
          </div>
        )}
        <SchedulingCalendar enabled={ready} />
      </div>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent
          className="scheduling-ui calendar-settings-dialog"
          style={schedulingTheme}
        >
          <DialogHeader>
            <div className="calendar-settings-dialog__heading">
              <span>
                <Settings2 aria-hidden="true" />
              </span>
              <div>
                <DialogTitle>日历偏好</DialogTitle>
                <DialogDescription>
                  设置时区和助手可以分享的忙闲信息。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div
            className="scheduling-ui calendar-settings"
            style={schedulingTheme}
          >
            <SchedulingPreferences />
            {adoptId && <AssistantCollaborationSettings adoptId={adoptId} />}
            {!ensure.data?.managed && (
              <details className="calendar-advanced">
                <summary>高级：外部日历账号</summary>
                <SchedulingConnection />
              </details>
            )}
            {user?.role === "admin" && (
              <details className="calendar-advanced">
                <summary>管理员维护</summary>
                <BindingSettings />
              </details>
            )}
          </div>
          <div className="calendar-settings-dialog__footer">
            <Button variant="outline" onClick={() => setSettings(false)}>
              完成
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
