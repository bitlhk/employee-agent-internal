import { BarChart3, Download, Fingerprint, Scale } from "lucide-react";
import { Button } from "@/components/ui/action-button";
import {
  buildSkillValueEvidenceMarkdown,
  buildSkillValueEvidenceSummary,
  type SkillValueEvidenceJob,
} from "@/lib/skill-value-evidence";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function downloadEvidence(job: SkillValueEvidenceJob) {
  const markdown = buildSkillValueEvidenceMarkdown(job);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${job.skillId}-${job.jobId}-evidence.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  toast.success("评测证据报告已导出");
}

function formatSeconds(value: number | null): string {
  return value === null ? "--" : `${value.toFixed(1)}s`;
}

export function SkillValueEvaluationEvidence({
  job,
  className,
}: {
  job: SkillValueEvidenceJob;
  className?: string;
}) {
  const evidence = buildSkillValueEvidenceSummary(job);
  return (
    <section
      data-testid="skill-value-evidence"
      className={cn("border border-emerald-200 bg-emerald-50/40", className)}
    >
      <div className="flex flex-col gap-3 border-b border-emerald-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
            <BarChart3 className="h-4 w-4 text-emerald-700" />
            价值证据摘要
            <span
              className={cn(
                "border px-2 py-0.5 text-[10px] font-medium",
                evidence.evidenceStatus === "complete"
                  ? "border-emerald-300 bg-white text-emerald-800"
                  : evidence.evidenceStatus === "partial"
                    ? "border-amber-300 bg-white text-amber-800"
                    : "border-red-300 bg-white text-red-800"
              )}
            >
              {evidence.evidenceLabel}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-gray-800">
            {evidence.headline}
          </p>
          <div className="mt-1 text-xs font-medium text-emerald-800">
            较优配置：{evidence.winnerLabel}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadEvidence(job)}
          title="导出本轮完整评测证据"
        >
          <Download />
          导出证据
        </Button>
      </div>

      <div className="grid border-b border-emerald-100 bg-white/70 sm:grid-cols-2">
        {(["left", "right"] as const).map((side, index) => {
          const configuration = job[side];
          return (
            <div
              key={side}
              className={cn(
                "flex min-w-0 items-center gap-3 px-4 py-3",
                index > 0 &&
                  "border-t border-emerald-100 sm:border-l sm:border-t-0"
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white",
                  side === "left" ? "bg-gray-800" : "bg-emerald-600"
                )}
              >
                {side === "left" ? "A" : "B"}
              </span>
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-gray-900">
                  {configuration.skillVersion
                    ? `Skill v${configuration.skillVersion}`
                    : "不装配当前 Skill"}{" "}
                  · {configuration.modelId}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-gray-500">
                  {configuration.skillArtifactSha256
                    ? `Artifact ${configuration.skillArtifactSha256.slice(0, 12)}`
                    : configuration.skillVersion
                      ? "历史记录未保存 Artifact 摘要"
                      : "隔离对照环境"}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid border-b border-emerald-100 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["对比方式", evidence.comparisonType],
          [
            "胜负",
            `A ${job.summary?.leftWins || 0} · B ${job.summary?.rightWins || 0} · 平 ${job.summary?.ties || 0}`,
          ],
          [
            "有效判定",
            `${evidence.judgedCases}/${job.cases.length} 题 · 高置信 ${evidence.highConfidenceCases}`,
          ],
          [
            "运行结果",
            `${evidence.completedSides}/${evidence.totalSides} 侧 · A ${formatSeconds(evidence.averageElapsedSeconds.left)} / B ${formatSeconds(evidence.averageElapsedSeconds.right)}`,
          ],
        ].map(([label, value], index) => (
          <div
            key={label}
            className={cn(
              "px-4 py-3",
              index > 0 &&
                "border-t border-emerald-100 sm:border-l sm:border-t-0",
              index === 2 &&
                "sm:border-l-0 sm:border-t lg:border-l lg:border-t-0"
            )}
          >
            <div className="text-[10px] font-medium text-gray-500">{label}</div>
            <div className="mt-1 text-xs font-semibold text-gray-900">
              {value}
            </div>
          </div>
        ))}
      </div>

      {evidence.dimensions.length ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4">
          {evidence.dimensions.map((dimension, index) => (
            <div
              key={dimension.id}
              className={cn(
                "px-4 py-3",
                index > 0 &&
                  "border-t border-emerald-100 sm:border-l sm:border-t-0",
                index === 2 &&
                  "sm:border-l-0 sm:border-t lg:border-l lg:border-t-0"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700">
                  {dimension.label}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px] font-semibold",
                    dimension.delta > 0
                      ? "text-emerald-700"
                      : dimension.delta < 0
                        ? "text-red-700"
                        : "text-gray-500"
                  )}
                >
                  {dimension.delta > 0 ? "+" : ""}
                  {dimension.delta.toFixed(1)}
                </span>
              </div>
              <div className="mt-1 font-mono text-xs text-gray-900">
                A {dimension.leftScore.toFixed(1)} · B{" "}
                {dimension.rightScore.toFixed(1)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-emerald-100 px-4 py-3 text-[10px] leading-4 text-gray-600 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-1.5">
          <Scale className="h-3.5 w-3.5" />
          同题同环境 · {job.judge.modelId} 匿名 Judge · Finance Skill Eval{" "}
          {job.evaluationEngine.version} · Promptfoo {job.promptfoo.version}
        </span>
        <span
          className="flex items-center gap-1.5 font-mono"
          title={job.reportFingerprint || job.configurationFingerprint}
        >
          <Fingerprint className="h-3.5 w-3.5" />
          {(job.reportFingerprint || job.configurationFingerprint).slice(0, 12)}
        </span>
      </div>
    </section>
  );
}
