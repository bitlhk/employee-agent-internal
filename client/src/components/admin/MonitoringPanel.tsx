import { useCallback, useEffect, useState } from "react";
import { Activity, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";

type ServiceStatus = {
  available: boolean;
  detail: string;
};

export type MonitoringStatus = {
  configured: boolean;
  available: boolean;
  checkedAt: string;
  dashboardUrl: string | null;
  services: {
    prometheus: ServiceStatus;
    grafana: ServiceStatus;
  };
};

export function useMonitoringStatus(
  enabled: boolean,
  refreshWhileActive = false
) {
  const [status, setStatus] = useState<MonitoringStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/monitoring/status", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as MonitoringStatus);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refetch();
  }, [enabled, refetch]);

  useEffect(() => {
    if (!enabled || !refreshWhileActive) return;
    const timer = window.setInterval(() => void refetch(), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled, refetch, refreshWhileActive]);

  return { status, loading, refetch };
}

function ServiceBadge({
  label,
  service,
}: {
  label: string;
  service: ServiceStatus;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        service.available
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-gray-200 bg-gray-50 text-gray-600"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${service.available ? "bg-emerald-500" : "bg-gray-400"}`}
      />
      {label} · {service.detail}
    </span>
  );
}

export function MonitoringPanel({
  status,
  loading,
  onRefresh,
}: {
  status: MonitoringStatus | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (loading && !status) {
    return (
      <Card className="admin-panel-card flex min-h-[360px] items-center justify-center p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在连接运行监控
        </div>
      </Card>
    );
  }

  const dashboardUrl = status?.dashboardUrl || "";
  return (
    <div className="space-y-4">
      <Card className="admin-panel-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-gray-700" />
              <h2 className="text-base font-semibold text-gray-900">
                运行监控
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              查看首字延迟、对话耗时、并发容量、Runtime、MCP、沙箱和数据库趋势。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dashboardUrl && status?.available ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="admin-secondary-action"
                onClick={() =>
                  window.open(dashboardUrl, "_blank", "noopener,noreferrer")
                }
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                单独打开
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="admin-secondary-action"
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw
                className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              刷新
            </Button>
          </div>
        </div>
        {status ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ServiceBadge
              label="Prometheus"
              service={status.services.prometheus}
            />
            <ServiceBadge label="Grafana" service={status.services.grafana} />
            <span className="text-[11px] text-muted-foreground">
              检查于 {new Date(status.checkedAt).toLocaleString("zh-CN")}
            </span>
          </div>
        ) : null}
      </Card>

      {!status?.configured ? (
        <Card className="admin-panel-card px-6 py-12 text-center">
          <div className="text-sm font-medium text-gray-900">
            运行监控未启用
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            该能力是可选运维组件，不影响岗位智能体平台的正常使用。
          </p>
        </Card>
      ) : status.available && dashboardUrl ? (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <iframe
            title="Employee Agent 运行监控"
            src={dashboardUrl}
            sandbox="allow-downloads allow-forms allow-same-origin allow-scripts"
            className="block min-h-[780px] w-full border-0 bg-white"
          />
        </div>
      ) : (
        <Card className="admin-panel-card px-6 py-12 text-center">
          <div className="text-sm font-medium text-gray-900">
            监控服务暂时不可用
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            平台业务不受影响。请检查本机 Prometheus 和 Grafana 容器后重试。
          </p>
        </Card>
      )}
    </div>
  );
}
