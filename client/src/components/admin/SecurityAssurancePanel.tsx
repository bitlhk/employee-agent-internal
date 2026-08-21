import { Loader2, RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";

const STATUS: Record<string, { label: string; className: string }> = {
  enforced: { label: "已执行", className: "border-green-200 bg-green-50 text-green-700" },
  verified: { label: "已验证", className: "border-green-200 bg-green-50 text-green-700" },
  partial: { label: "部分覆盖", className: "border-amber-200 bg-amber-50 text-amber-700" },
  risk: { label: "存在风险", className: "border-red-200 bg-red-50 text-red-700" },
  unavailable: { label: "不可用", className: "border-red-200 bg-red-50 text-red-700" },
  not_enabled: { label: "未启用", className: "border-gray-200 bg-gray-50 text-gray-600" },
  not_integrated: { label: "待接入", className: "border-gray-200 bg-gray-50 text-gray-600" },
  unverified: { label: "未验证", className: "border-gray-200 bg-gray-50 text-gray-600" },
};

function statusMeta(status: string) {
  return STATUS[status] || STATUS.unverified;
}

export function SecurityAssurancePanel() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.audit.securityValidationOverview.useQuery(undefined, {
    retry: false,
    refetchInterval: query => (query.state.data as any)?.validations?.[0]?.inventory?.backfill?.status === "running" ? 5_000 : false,
  });
  const startBackfill = trpc.audit.startSkillSecurityBackfill.useMutation({
    onSuccess: async () => {
      toast.success("存量 Skill 安全补扫已启动");
      await utils.audit.securityValidationOverview.invalidate();
    },
    onError: error => toast.error(error.message || "无法启动补扫"),
  });
  const runtime = Array.isArray((data as any)?.runtimeProtection) ? (data as any).runtimeProtection : [];
  const validations = Array.isArray((data as any)?.validations) ? (data as any).validations : [];
  const skillInventory = validations.find((item: any) => item.key === "skill_scan")?.inventory;
  const backfill = skillInventory?.backfill;
  const running = backfill?.status === "running";

  const requestBackfill = () => {
    const unscanned = Number(skillInventory?.counts?.unscanned || 0);
    if (unscanned <= 0 && Number(skillInventory?.counts?.failed || 0) <= 0) {
      toast.info("当前没有需要补扫的 Skill");
      return;
    }
    if (!window.confirm(`将异步扫描 ${unscanned} 个未扫描 Skill。扫描会调用已配置的平台模型，但不会阻断当前运行，是否继续？`)) return;
    startBackfill.mutate();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div>
            <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-gray-700" /><h2 className="text-sm font-semibold text-gray-900">运行时防护</h2></div>
            <p className="mt-1 text-xs text-muted-foreground">每次 Context 获取和工具执行时真正生效的确定性控制。</p>
          </div>
        </div>
        <div className="divide-y divide-gray-100">
          {runtime.map((item: any) => {
            const meta = statusMeta(String(item.status));
            return <div key={item.key} className="flex items-start justify-between gap-4 px-5 py-3.5">
              <div className="min-w-0"><div className="text-sm font-medium text-gray-900">{item.label}</div><div className="mt-1 text-xs text-muted-foreground">{item.detail}</div></div>
              <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
            </div>;
          })}
          {isLoading && runtime.length === 0 ? <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在检查</div> : null}
        </div>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div>
            <div className="flex items-center gap-2"><ScanSearch className="h-4 w-4 text-gray-700" /><h2 className="text-sm font-semibold text-gray-900">安全验证</h2></div>
            <p className="mt-1 text-xs text-muted-foreground">AI-Infra-Guard 的异步扫描、红队与评测结果，不进入实时对话链。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}><RefreshCw className={isLoading ? "animate-spin" : ""} />刷新</Button>
        </div>
        <div className="divide-y divide-gray-100">
          {validations.map((item: any) => {
            const meta = statusMeta(String(item.status));
            return <div key={item.key} className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0"><div className="text-sm font-medium text-gray-900">{item.label}</div><div className="mt-0.5 text-[11px] text-gray-400">{item.provider}</div><div className="mt-1 text-xs text-muted-foreground">{item.detail}</div></div>
                <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
              </div>
              {item.key === "skill_scan" ? <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button size="sm" variant="outline" disabled={running || startBackfill.isPending || !skillInventory?.enabled} onClick={requestBackfill}>
                  {running || startBackfill.isPending ? <Loader2 className="animate-spin" /> : <ScanSearch />}{running ? "补扫进行中" : "扫描存量 Skill"}
                </Button>
                {backfill?.runId ? <span className="text-[11px] text-muted-foreground">进度 {backfill.processed}/{backfill.total} · 新扫 {backfill.scanned} · 复用 {backfill.reused} · 缺失 {backfill.skippedMissing}</span> : null}
              </div> : null}
            </div>;
          })}
        </div>
      </Card>
    </div>
  );
}
