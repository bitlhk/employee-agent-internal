import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { formatModelName } from "@/lib/modelDisplay";
import { MESSAGE_FEEDBACK_REASON_LABELS, type MessageFeedbackReasonCode } from "@shared/message-feedback";
import { Loader2, MessageSquareText, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  "general-assistant": "通用助手",
  "wealth-manager": "财富经理",
  "investment-researcher": "投顾分析",
  "credential-compliance": "审核专员",
  "insurance-advisor": "保险顾问",
  "risk-control-manager": "风控经理",
};

function satisfactionTone(value: number) {
  if (value >= 80) return "text-emerald-600";
  if (value >= 60) return "text-amber-600";
  return "text-red-600";
}

function formatDate(value: unknown) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function reasonLabel(code: unknown) {
  return MESSAGE_FEEDBACK_REASON_LABELS[code as MessageFeedbackReasonCode] || String(code || "其他");
}

function BreakdownList({ rows, kind }: { rows: any[]; kind: "model" | "role" }) {
  if (rows.length === 0) return <div className="py-8 text-center text-sm text-muted-foreground">暂无数据</div>;
  return (
    <div className="divide-y divide-gray-100">
      {rows.map((row) => {
        const label = kind === "model"
          ? formatModelName(String(row.key || "未记录"))
          : ROLE_LABELS[String(row.key || "")] || String(row.key || "未记录");
        return (
          <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_70px_78px] items-center gap-3 py-3 text-sm">
            <span className="truncate text-gray-800" title={label}>{label}</span>
            <span className="text-right font-mono text-xs text-gray-500">{Number(row.total || 0)} 条</span>
            <span className={`text-right font-mono text-xs font-medium ${satisfactionTone(Number(row.satisfactionRate || 0))}`}>
              {Number(row.satisfactionRate || 0).toFixed(1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MessageFeedbackPanel({ enabled }: { enabled: boolean }) {
  const [days, setDays] = useState("30");
  const { data, isLoading, refetch, isFetching } = trpc.claw.adminMessageFeedbackSummary.useQuery(
    { days: Number(days), limit: 30 },
    { enabled, retry: false },
  );
  const summary = (data as any)?.summary || { total: 0, positive: 0, negative: 0, satisfactionRate: 0 };
  const reasonCounts: any[] = Array.isArray((data as any)?.reasonCounts) ? (data as any).reasonCounts : [];
  const byModel: any[] = Array.isArray((data as any)?.byModel) ? (data as any).byModel : [];
  const byRole: any[] = Array.isArray((data as any)?.byRole) ? (data as any).byRole : [];
  const recentNegative: any[] = Array.isArray((data as any)?.recentNegative) ? (data as any).recentNegative : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">质量反馈</h2>
          <p className="mt-1 text-xs text-muted-foreground">按岗位、模型和问题类型查看回复反馈；不采集对话原文。</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-9 w-28 bg-white text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">近 7 天</SelectItem>
              <SelectItem value="30">近 30 天</SelectItem>
              <SelectItem value="90">近 90 天</SelectItem>
              <SelectItem value="365">近 1 年</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" size="sm" className="admin-secondary-action h-9" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />正在加载反馈
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="admin-panel-card p-4">
              <div className="text-xs text-gray-500">反馈总数</div>
              <div className="mt-2 text-2xl font-semibold text-gray-900">{Number(summary.total || 0)}</div>
            </Card>
            <Card className="admin-panel-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500"><ThumbsUp className="h-3.5 w-3.5" />有帮助</div>
              <div className="mt-2 text-2xl font-semibold text-emerald-600">{Number(summary.positive || 0)}</div>
            </Card>
            <Card className="admin-panel-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500"><ThumbsDown className="h-3.5 w-3.5" />没有帮助</div>
              <div className="mt-2 text-2xl font-semibold text-red-600">{Number(summary.negative || 0)}</div>
            </Card>
            <Card className="admin-panel-card p-4">
              <div className="text-xs text-gray-500">满意率</div>
              <div className={`mt-2 text-2xl font-semibold ${satisfactionTone(Number(summary.satisfactionRate || 0))}`}>
                {Number(summary.satisfactionRate || 0).toFixed(1)}%
              </div>
            </Card>
          </div>

          <Card className="admin-panel-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <MessageSquareText className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">负面反馈归因</h3>
            </div>
            {reasonCounts.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {reasonCounts.map((item) => (
                  <span key={item.code} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                    {reasonLabel(item.code)}
                    <span className="font-mono font-semibold text-gray-900">{Number(item.count || 0)}</span>
                  </span>
                ))}
              </div>
            ) : <div className="py-6 text-center text-sm text-muted-foreground">暂无已归因的负面反馈</div>}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="admin-panel-card p-5">
              <h3 className="text-sm font-semibold text-gray-900">按模型</h3>
              <div className="mt-1 text-xs text-gray-400">反馈数 · 满意率</div>
              <BreakdownList rows={byModel} kind="model" />
            </Card>
            <Card className="admin-panel-card p-5">
              <h3 className="text-sm font-semibold text-gray-900">按岗位</h3>
              <div className="mt-1 text-xs text-gray-400">反馈数 · 满意率</div>
              <BreakdownList rows={byRole} kind="role" />
            </Card>
          </div>

          <Card className="admin-panel-card overflow-hidden">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 className="text-sm font-semibold text-gray-900">最近负面反馈</h3>
              <p className="mt-1 text-xs text-gray-400">仅展示用户主动填写的原因、备注和运行元数据。</p>
            </div>
            <div className="overflow-x-auto">
              <div className="grid min-w-[900px] grid-cols-[150px_130px_150px_minmax(180px,1fr)_minmax(180px,1fr)] border-b border-gray-200 bg-gray-50 px-5 py-2 text-xs font-medium text-gray-500">
                <span>时间</span><span>岗位 / 实例</span><span>模型</span><span>原因</span><span>用户备注</span>
              </div>
              {recentNegative.length > 0 ? recentNegative.map((item, index) => (
                <div key={`${item.adoptId}-${item.updatedAt}-${index}`} className="grid min-w-[900px] grid-cols-[150px_130px_150px_minmax(180px,1fr)_minmax(180px,1fr)] items-start border-b border-gray-100 px-5 py-3 text-xs last:border-b-0">
                  <span className="font-mono text-[11px] text-gray-500">{formatDate(item.updatedAt)}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-gray-800">{ROLE_LABELS[item.roleTemplate] || item.roleTemplate || "未记录"}</span>
                    <span className="block truncate font-mono text-[10px] text-gray-400" title={item.adoptId}>{item.adoptId || "-"}</span>
                  </span>
                  <span className="truncate text-gray-700" title={item.actualModelId || item.selectedModelId}>{formatModelName(item.actualModelId || item.selectedModelId || "未记录")}</span>
                  <span className="flex flex-wrap gap-1">
                    {(item.reasonCodes || []).length > 0 ? item.reasonCodes.map((code: string) => (
                      <span key={code} className="rounded-md bg-red-50 px-1.5 py-1 text-[10px] text-red-700">{reasonLabel(code)}</span>
                    )) : <span className="text-gray-400">未补充</span>}
                  </span>
                  <span className="break-words text-gray-700">{item.comment || <span className="text-gray-400">未填写</span>}</span>
                </div>
              )) : <div className="px-5 py-10 text-center text-sm text-muted-foreground">暂无负面反馈</div>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
