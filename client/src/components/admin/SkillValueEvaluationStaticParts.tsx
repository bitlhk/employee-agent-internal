import { CheckCircle2, Scale } from "lucide-react";
import type {
  SkillValueCase,
  SkillValueEvaluationReport,
  SkillValueMetric,
} from "@/data/skill-value-evaluations";
import { cn } from "@/lib/utils";

const scoreText = (score: number) =>
  Number.isInteger(score) ? String(score) : score.toFixed(2);

export function SkillValueStatusBadge({ report }: { report: SkillValueEvaluationReport }) {
  const tone =
    report.statusTone === "positive"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : report.statusTone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-gray-200 bg-gray-50 text-gray-600";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        tone,
      )}
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      {report.statusLabel}
    </span>
  );
}

export function SkillValueMetricComparison({ metric }: { metric: SkillValueMetric }) {
  const scoreDelta = metric.targetScore - metric.baselineScore;
  const baselineWidth = `${Math.max(0, Math.min(100, (metric.baselineScore / metric.maxScore) * 100))}%`;
  const targetWidth = `${Math.max(0, Math.min(100, (metric.targetScore / metric.maxScore) * 100))}%`;
  return (
    <div className="border-b border-gray-100 py-4 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-gray-900">{metric.label}</div>
          <div className="mt-1 text-xs leading-5 text-gray-500">{metric.description}</div>
        </div>
        <div className="shrink-0 text-xs font-medium text-emerald-700">
          {scoreDelta === 0 ? "持平" : `+${scoreText(scoreDelta)}`}
        </div>
      </div>
      <div className="mt-3 grid gap-2.5">
        <div className="grid grid-cols-[68px_1fr_32px] items-center gap-2 text-xs">
          <span className="text-gray-500">对照平均</span>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full rounded-full bg-gray-400" style={{ width: baselineWidth }} />
          </div>
          <span className="text-right font-mono text-gray-600">{scoreText(metric.baselineScore)}</span>
        </div>
        <div className="grid grid-cols-[68px_1fr_32px] items-center gap-2 text-xs">
          <span className="font-medium text-emerald-700">目标 Skill</span>
          <div className="h-2 overflow-hidden rounded-full bg-emerald-50">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: targetWidth }} />
          </div>
          <span className="text-right font-mono font-semibold text-emerald-700">
            {scoreText(metric.targetScore)}
          </span>
        </div>
      </div>
    </div>
  );
}

function CaseOutput({
  label,
  score,
  items,
  target,
}: {
  label: string;
  score: number;
  items: string[];
  target?: boolean;
}) {
  return (
    <div className={cn(
      "min-w-0 border p-4",
      target ? "border-emerald-200 bg-emerald-50/40" : "border-gray-200 bg-gray-50/60",
    )}>
      <div className="flex items-center justify-between gap-3">
        <div className={cn("text-sm font-semibold", target ? "text-emerald-800" : "text-gray-700")}>
          {label}
        </div>
        <div className={cn("font-mono text-sm font-semibold", target ? "text-emerald-700" : "text-gray-600")}>
          {scoreText(score)} / 4
        </div>
      </div>
      <ul className="mt-3 space-y-2.5">
        {items.map(item => (
          <li key={item} className="flex gap-2 text-sm leading-6 text-gray-700">
            <span className={cn("mt-2 h-1.5 w-1.5 shrink-0 rounded-full", target ? "bg-emerald-500" : "bg-gray-400")} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SkillValueCaseComparison({ evalCase }: { evalCase: SkillValueCase }) {
  return (
    <div>
      <div className="border-b border-gray-200 pb-4">
        <div className="text-xs font-medium text-emerald-700">{evalCase.caseId}</div>
        <h3 className="mt-1 text-base font-semibold text-gray-900">{evalCase.name}</h3>
        <div className="mt-2 rounded border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-600">
          {evalCase.taskPrompt}
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CaseOutput label={evalCase.baselineLabel} score={evalCase.baselineScore} items={evalCase.baselineExcerpt} />
        <CaseOutput label={evalCase.targetLabel} score={evalCase.targetScore} items={evalCase.targetExcerpt} target />
      </div>
      <div className="mt-4 border border-emerald-200 bg-emerald-50/60 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
          <Scale className="h-4 w-4" />
          专家为什么选择目标 Skill
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {evalCase.targetAdvantages.map(advantage => (
            <span key={advantage} className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-xs text-emerald-800">
              {advantage}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
