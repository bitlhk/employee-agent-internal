import { useState, useEffect } from "react";
import {
  BarChart3,
  CheckCircle2,
  Copy,
  Download,
  Gauge,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  TrendingUp,
  Users,
  XCircle,
} from "lucide-react";

interface AdoptionStat {
  adoptId: string;
  total: number;
  userId: number;
  userName: string;
  runtime?: string;
  lastActivity: string;
  recent7d: number;
  dailyBreakdown: Array<{ date: string; count: number }>;
}

interface UsageData {
  adoptions: AdoptionStat[];
  daily: Array<{ date: string; count: number }>;
  summary: { totalClaws: number; totalChats: number; activeToday: number };
  installations?: {
    summary: {
      commandCopied: number;
      downloaded: number;
      started: number;
      succeeded: number;
      failed: number;
      succeeded30d: number;
      successRate: number;
    };
    daily: Array<{ date: string; downloaded: number; started: number; succeeded: number; failed: number }>;
    failureStages: Array<{ stage: string; count: number }>;
  };
}

function getRecentDailySeries(raw: Array<{ date: string; count: number }>, days = 14) {
  const counts = new Map(raw.map((item) => [item.date, item.count]));
  const today = new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - index));
    const key = date.toISOString().slice(0, 10);
    return { date: key, count: counts.get(key) || 0 };
  });
}

export function UsageStatsTab() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/claw/admin/usage-stats", { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchStats(); }, []);

  if (loading) return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
    </div>
  );

  if (!data) return <div className="text-sm text-gray-500 text-center py-8">加载失败</div>;

  const dailySeries = getRecentDailySeries(data.daily || []);
  const maxDaily = Math.max(...dailySeries.map(d => d.count), 1);
  const hasDailyData = dailySeries.some((d) => d.count > 0);
  const chartHeightPx = 72;
  const summaryCards = [
    { label: "智能体实例总数", value: data.summary.totalClaws, icon: Users, tone: "red", hint: "已配置实例" },
    { label: "总对话数", value: data.summary.totalChats, icon: MessageSquare, tone: "blue", hint: "累计会话调用" },
    { label: "今日活跃", value: data.summary.activeToday, icon: TrendingUp, tone: "green", hint: "今日有交互" },
  ];
  const installSummary = data.installations?.summary || {
    commandCopied: 0,
    downloaded: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    succeeded30d: 0,
    successRate: 0,
  };
  const installationCards = [
    { label: "命令复制", value: installSummary.commandCopied, icon: Copy },
    { label: "脚本下载", value: installSummary.downloaded, icon: Download },
    { label: "开始安装", value: installSummary.started, icon: Play },
    { label: "安装成功", value: installSummary.succeeded, icon: CheckCircle2 },
    { label: "安装失败", value: installSummary.failed, icon: XCircle },
    { label: "安装成功率", value: `${installSummary.successRate}%`, icon: Gauge },
  ];

  return (
    <div className="admin-usage-tab space-y-6">
      {/* 概览卡片 */}
      <div className="grid grid-cols-3 gap-4">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className={`admin-metric-card admin-metric-card--${card.tone} rounded-xl border border-gray-200 bg-white p-4`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-gray-500">{card.label}</div>
                  <div className="mt-2 text-2xl font-semibold text-gray-900">{card.value}</div>
                  <div className="mt-1 text-[11px] text-gray-400">{card.hint}</div>
                </div>
                <div className="admin-metric-icon">
                  <Icon className="h-4 w-4" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 一键安装漏斗 */}
      <div className="admin-panel-card rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">一键安装统计</h3>
            <p className="mt-1 text-[11px] text-gray-400">匿名事件，统计字段不含服务器 IP、主机名或账号信息</p>
          </div>
          <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">
            近 30 天成功 {installSummary.succeeded30d}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {installationCards.map((card) => {
            const Icon = card.icon;
            return (
              <div key={card.label} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-3">
                <div className="flex items-center justify-between gap-2 text-gray-400">
                  <span className="text-[11px] font-medium">{card.label}</span>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="mt-2 text-xl font-semibold text-gray-900">{card.value}</div>
              </div>
            );
          })}
        </div>
        {(data.installations?.failureStages?.length || 0) > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <span className="text-[11px] text-gray-400">失败阶段</span>
            {data.installations!.failureStages.map((item) => (
              <span key={item.stage} className="rounded-md bg-red-50 px-2 py-1 font-mono text-[10px] text-red-600">
                {item.stage} · {item.count}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 每日趋势 */}
      <div className="admin-panel-card rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
            <span className="admin-section-icon"><BarChart3 className="w-4 h-4" /></span>
            每日对话趋势（最近14天）
          </h3>
          <button onClick={fetchStats} className="admin-ghost-action text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> 刷新
          </button>
        </div>
        <div className="relative">
          {!hasDailyData && (
            <div className="absolute inset-x-0 top-8 z-10 text-center text-xs text-gray-400">
              最近 14 天暂无对话数据
            </div>
          )}
          <div className="admin-usage-chart flex h-24 items-end gap-1.5">
            {dailySeries.map((d, i) => (
              <div key={i} className="flex-1 flex h-full min-w-0 flex-col items-center justify-end gap-1">
                <span className="text-[10px] text-gray-500">{d.count}</span>
                <div
                  className={`w-full max-w-8 rounded-t transition-all ${d.count > 0 ? "admin-usage-bar" : "admin-usage-bar-empty"}`}
                  style={{ height: `${d.count > 0 ? Math.max((d.count / maxDaily) * chartHeightPx, 5) : 2}px` }}
                  title={`${d.date}: ${d.count} 次`}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            {dailySeries.map((d) => (
              <span key={d.date} className="flex-1 min-w-0 text-center text-[10px] font-medium leading-none text-gray-600">
                {d.date.slice(5)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 智能体实例排行 */}
      <div className="admin-panel-card rounded-xl border border-gray-200 bg-white">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">智能体实例使用排行</h3>
        </div>
        <div className="divide-y divide-gray-50">
          {data.adoptions.map((a, i) => (
            <div key={a.adoptId}>
              <div
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 cursor-pointer"
                onClick={() => setExpanded(expanded === a.adoptId ? null : a.adoptId)}
              >
                <span className="text-xs font-bold text-gray-300 w-5 text-right">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-gray-800">{a.adoptId}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      a.runtime === "jiuwenswarm" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                    }`}>
                      {a.runtime === "jiuwenswarm" ? "JiuwenSwarm" : "OpenClaw"}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{a.userName}</span>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs shrink-0">
                  <div className="text-right">
                    <div className="font-semibold text-gray-900">{a.total}</div>
                    <div className="text-gray-400">总对话</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-blue-600">{a.recent7d}</div>
                    <div className="text-gray-400">近7天</div>
                  </div>
                  <div className="text-right w-20">
                    <div className="text-gray-500 text-[10px]">
                      {a.lastActivity ? new Date(a.lastActivity).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-"}
                    </div>
                    <div className="text-gray-400">最近活跃</div>
                  </div>
                </div>
              </div>
              {/* 展开：每日明细 */}
              {expanded === a.adoptId && a.dailyBreakdown.length > 0 && (
                <div className="px-4 pb-3 pl-12">
                  <div className="flex flex-wrap gap-1.5">
                    {a.dailyBreakdown.map(d => (
                      <span key={d.date} className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-600 font-mono">
                        {d.date.slice(5)}: {d.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {data.adoptions.length === 0 && (
            <div className="admin-empty-state text-sm text-gray-400 text-center py-8">
              <BarChart3 className="mx-auto mb-2 h-5 w-5" />
              暂无使用排行数据
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
