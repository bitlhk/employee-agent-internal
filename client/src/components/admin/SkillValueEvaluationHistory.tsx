import { useEffect, useMemo, useState } from "react";
import { BookOpenCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/action-button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { SkillValueEvaluationEvidence } from "./SkillValueEvaluationEvidence";

export function SkillValueEvaluationHistory({
  open,
  skillId,
}: {
  open: boolean;
  skillId: string;
}) {
  const historyQuery = trpc.claw.adminListSkillEvaluationJobs.useQuery(
    { skillId, limit: 20 },
    { enabled: open && Boolean(skillId), retry: 2 },
  );
  const jobs = useMemo(() => historyQuery.data || [], [historyQuery.data]);
  const [selectedJobId, setSelectedJobId] = useState("");
  useEffect(() => {
    if (!jobs.length) {
      setSelectedJobId("");
      return;
    }
    if (!jobs.some(job => job.jobId === selectedJobId)) setSelectedJobId(jobs[0].jobId);
  }, [jobs, selectedJobId]);
  const selectedJob = jobs.find(job => job.jobId === selectedJobId) || jobs[0];
  const statusLabel = (status: string) => status === "completed"
    ? "已完成"
    : status === "cancelled"
      ? "已取消"
      : "失败";

  if (historyQuery.isLoading) {
    return (
      <div className="flex min-h-[260px] items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />正在读取真实评测记录
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">真实运行记录</h3>
          <p className="mt-1 text-xs text-gray-500">由当前环境实际执行并保存，保留 90 天。</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => historyQuery.refetch()} disabled={historyQuery.isFetching}>
          <RefreshCw className={cn(historyQuery.isFetching && "animate-spin")} />刷新
        </Button>
      </div>
      {historyQuery.error ? (
        <div className="mt-3 border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          {historyQuery.error.message}
        </div>
      ) : null}
      {jobs.length ? (
        <div className="mt-3 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {jobs.map(job => (
              <button
                type="button"
                key={job.jobId}
                onClick={() => setSelectedJobId(job.jobId)}
                className={cn(
                  "w-full border px-3 py-3 text-left transition-colors",
                  job.jobId === selectedJob?.jobId
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-gray-200 bg-white hover:bg-gray-50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-gray-900">
                    {job.left.skillVersion ? `v${job.left.skillVersion}` : "无 Skill"}
                    {" vs "}
                    {job.right.skillVersion ? `v${job.right.skillVersion}` : "无 Skill"}
                  </span>
                  <span className={cn(
                    "shrink-0 text-[10px] font-medium",
                    job.status === "completed" ? "text-emerald-700" : job.status === "failed" ? "text-red-700" : "text-gray-600",
                  )}>
                    {statusLabel(job.status)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-gray-500">
                  {new Date(job.updatedAt).toLocaleString("zh-CN")} · {job.cases.length} 题
                </div>
                <div className="mt-2 line-clamp-2 text-[11px] leading-5 text-gray-600">
                  {job.summary?.headline || job.error || job.stageLabel}
                </div>
              </button>
            ))}
          </div>
          {selectedJob ? (
            <div className="min-w-0 border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 pb-3">
                <div>
                  <div className="text-sm font-semibold text-gray-950">
                    {selectedJob.summary?.headline || selectedJob.stageLabel}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">
                    {selectedJob.roleTemplate} · {selectedJob.left.modelId} / {selectedJob.right.modelId}
                  </div>
                </div>
                <span className="font-mono text-[10px] text-gray-500" title={selectedJob.reportFingerprint || undefined}>
                  {selectedJob.reportFingerprint ? `报告 ${selectedJob.reportFingerprint.slice(0, 12)}` : "历史格式"}
                </span>
              </div>
              {selectedJob.error ? (
                <div className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800">
                  {selectedJob.error}
                </div>
              ) : null}
              {selectedJob.summary ? (
                <SkillValueEvaluationEvidence job={selectedJob} className="mt-3" />
              ) : null}
              <div className="mt-3 space-y-3">
                {selectedJob.cases.map((item, index) => (
                  <div key={item.promptId} className="border border-gray-200">
                    <div className="border-b border-gray-100 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-900">
                      {index + 1}. {item.name}
                    </div>
                    <div className="grid lg:grid-cols-2">
                      {(["left", "right"] as const).map((side, sideIndex) => (
                        <div key={side} className={cn("min-w-0 p-3", sideIndex === 0 && "border-b border-gray-200 lg:border-b-0 lg:border-r")}>
                          <div className="text-[11px] font-semibold text-gray-700">{side === "left" ? "A" : "B"}</div>
                          <div className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-gray-600">
                            {item[side]?.assistantText || item[side]?.error || "未产生输出"}
                          </div>
                        </div>
                      ))}
                    </div>
                    {item.judge ? (
                      <div className="border-t border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-700">
                        <span className="font-semibold text-gray-900">
                          {item.judge.winner === "right" ? "B 更优" : item.judge.winner === "left" ? "A 更优" : "表现持平"}
                        </span>
                        <span className="ml-2 text-gray-500">置信度 {item.judge.confidence}</span>
                        <p className="mt-1">{item.judge.summary}</p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 flex min-h-[220px] flex-col items-center justify-center border border-dashed border-gray-300 bg-gray-50 px-6 text-center">
          <BookOpenCheck className="h-8 w-8 text-gray-400" />
          <div className="mt-3 text-sm font-semibold text-gray-800">暂无真实评测记录</div>
          <p className="mt-1 text-xs text-gray-500">完成首轮对比后，实际结果会显示在这里。</p>
        </div>
      )}
    </section>
  );
}
