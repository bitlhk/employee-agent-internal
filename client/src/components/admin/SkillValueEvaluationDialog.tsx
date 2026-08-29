import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  CheckCircle2,
  ClipboardList,
  FlaskConical,
  Info,
  PackageCheck,
  Scale,
  UserRoundCheck,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getSkillValueEvaluationReport,
  type SkillValueCase,
  type SkillValueEvaluationReport,
  type SkillValueMetric,
} from "@/data/skill-value-evaluations";
import { cn } from "@/lib/utils";

type SkillValueEvaluationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillId: string | null;
  skillName?: string | null;
};

const scoreText = (score: number) =>
  Number.isInteger(score) ? String(score) : score.toFixed(2);

function StatusBadge({ report }: { report: SkillValueEvaluationReport }) {
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
        tone
      )}
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      {report.statusLabel}
    </span>
  );
}

function MetricComparison({ metric }: { metric: SkillValueMetric }) {
  const scoreDelta = metric.targetScore - metric.baselineScore;
  const baselineWidth = `${Math.max(0, Math.min(100, (metric.baselineScore / metric.maxScore) * 100))}%`;
  const targetWidth = `${Math.max(0, Math.min(100, (metric.targetScore / metric.maxScore) * 100))}%`;
  return (
    <div className="border-b border-gray-100 py-4 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            {metric.label}
          </div>
          <div className="mt-1 text-xs leading-5 text-gray-500">
            {metric.description}
          </div>
        </div>
        <div className="shrink-0 text-xs font-medium text-emerald-700">
          {scoreDelta === 0 ? "持平" : `+${scoreText(scoreDelta)}`}
        </div>
      </div>
      <div className="mt-3 grid gap-2.5">
        <div className="grid grid-cols-[68px_1fr_32px] items-center gap-2 text-xs">
          <span className="text-gray-500">对照平均</span>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-gray-400"
              style={{ width: baselineWidth }}
            />
          </div>
          <span className="text-right font-mono text-gray-600">
            {scoreText(metric.baselineScore)}
          </span>
        </div>
        <div className="grid grid-cols-[68px_1fr_32px] items-center gap-2 text-xs">
          <span className="font-medium text-emerald-700">目标 Skill</span>
          <div className="h-2 overflow-hidden rounded-full bg-emerald-50">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: targetWidth }}
            />
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
    <div
      className={cn(
        "min-w-0 border p-4",
        target
          ? "border-emerald-200 bg-emerald-50/40"
          : "border-gray-200 bg-gray-50/60"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div
          className={cn(
            "text-sm font-semibold",
            target ? "text-emerald-800" : "text-gray-700"
          )}
        >
          {label}
        </div>
        <div
          className={cn(
            "font-mono text-sm font-semibold",
            target ? "text-emerald-700" : "text-gray-600"
          )}
        >
          {scoreText(score)} / 4
        </div>
      </div>
      <ul className="mt-3 space-y-2.5">
        {items.map(item => (
          <li key={item} className="flex gap-2 text-sm leading-6 text-gray-700">
            <span
              className={cn(
                "mt-2 h-1.5 w-1.5 shrink-0 rounded-full",
                target ? "bg-emerald-500" : "bg-gray-400"
              )}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaseComparison({ evalCase }: { evalCase: SkillValueCase }) {
  return (
    <div>
      <div className="border-b border-gray-200 pb-4">
        <div className="text-xs font-medium text-emerald-700">
          {evalCase.caseId}
        </div>
        <h3 className="mt-1 text-base font-semibold text-gray-900">
          {evalCase.name}
        </h3>
        <div className="mt-2 rounded border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-600">
          {evalCase.taskPrompt}
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CaseOutput
          label={evalCase.baselineLabel}
          score={evalCase.baselineScore}
          items={evalCase.baselineExcerpt}
        />
        <CaseOutput
          label={evalCase.targetLabel}
          score={evalCase.targetScore}
          items={evalCase.targetExcerpt}
          target
        />
      </div>
      <div className="mt-4 border border-emerald-200 bg-emerald-50/60 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
          <Scale className="h-4 w-4" />
          专家为什么选择目标 Skill
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {evalCase.targetAdvantages.map(advantage => (
            <span
              key={advantage}
              className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-xs text-emerald-800"
            >
              {advantage}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const methodIcon = (id: string) => {
  if (id === "agent-skills") return PackageCheck;
  if (id === "prompt-library") return BookOpenCheck;
  if (id === "promptfoo") return FlaskConical;
  return UserRoundCheck;
};

function EvaluationReport({ report }: { report: SkillValueEvaluationReport }) {
  const [selectedCaseId, setSelectedCaseId] = useState(
    report.cases[0]?.caseId || ""
  );
  useEffect(
    () => setSelectedCaseId(report.cases[0]?.caseId || ""),
    [report.reportId, report.cases]
  );
  const selectedCase = useMemo(
    () =>
      report.cases.find(item => item.caseId === selectedCaseId) ||
      report.cases[0],
    [report.cases, selectedCaseId]
  );

  return (
    <Tabs defaultValue="overview" className="min-h-0 gap-4">
      <TabsList className="w-full justify-start rounded-md bg-gray-100 sm:w-fit">
        <TabsTrigger value="overview">
          <BarChart3 />
          价值总览
        </TabsTrigger>
        <TabsTrigger value="cases">
          <ClipboardList />
          案例对比
        </TabsTrigger>
        <TabsTrigger value="method">
          <FlaskConical />
          评测方法
        </TabsTrigger>
      </TabsList>

      <div className="max-h-[calc(86vh-150px)] overflow-y-auto pr-1">
        <TabsContent value="overview" className="space-y-5">
          <section className="border border-gray-200 bg-white p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge report={report} />
                  <span className="text-xs text-gray-500">
                    {report.domain} · {report.evaluatedAt}
                  </span>
                </div>
                <h2 className="mt-3 text-lg font-semibold leading-7 text-gray-950">
                  {report.headline}
                </h2>
                <p className="mt-2 text-sm leading-6 text-gray-600">
                  {report.summary}
                </p>
              </div>
              <div className="grid min-w-[280px] grid-cols-3 border border-gray-200 bg-gray-50">
                <div className="border-r border-gray-200 px-3 py-3 text-center">
                  <div className="font-mono text-xl font-semibold text-emerald-700">
                    {report.preference.targetWins}/
                    {report.preference.comparisonCount}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">
                    目标版胜出
                  </div>
                </div>
                <div className="border-r border-gray-200 px-3 py-3 text-center">
                  <div className="font-mono text-xl font-semibold text-gray-900">
                    {report.cases.length}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">业务场景</div>
                </div>
                <div className="px-3 py-3 text-center">
                  <div className="font-mono text-xl font-semibold text-gray-900">
                    {report.preference.orderDisagreements}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">换序分歧</div>
                </div>
              </div>
            </div>
          </section>

          <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
            <section className="border border-gray-200 bg-white px-5 py-2">
              <div className="border-b border-gray-100 py-3">
                <h3 className="text-sm font-semibold text-gray-900">
                  专业质量对比
                </h3>
                <p className="mt-1 text-xs text-gray-500">
                  0-4 分，展示四组匿名评审的平均结果
                </p>
              </div>
              {report.metrics.map(metric => (
                <MetricComparison key={metric.id} metric={metric} />
              ))}
            </section>

            <section className="border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-900">
                Skill 带来的业务变化
              </h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {report.improvements.map(item => (
                  <div key={item.title} className="border border-gray-200 p-4">
                    <div className="text-sm font-semibold text-gray-900">
                      {item.title}
                    </div>
                    <div className="mt-3 grid gap-2 text-xs leading-5">
                      <div>
                        <span className="font-medium text-gray-500">
                          原有表现：
                        </span>
                        <span className="text-gray-700">{item.before}</span>
                      </div>
                      <div>
                        <span className="font-medium text-emerald-700">
                          目标表现：
                        </span>
                        <span className="text-gray-700">{item.after}</span>
                      </div>
                    </div>
                    <div className="mt-3 border-t border-gray-100 pt-3 text-xs leading-5 text-gray-500">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent value="cases" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {report.cases.map(item => (
              <button
                type="button"
                key={item.caseId}
                onClick={() => setSelectedCaseId(item.caseId)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors",
                  item.caseId === selectedCase?.caseId
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                )}
              >
                {item.name}
              </button>
            ))}
          </div>
          {selectedCase ? <CaseComparison evalCase={selectedCase} /> : null}
        </TabsContent>

        <TabsContent value="method" className="space-y-5">
          <section className="border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-emerald-700" />
              <h3 className="text-sm font-semibold text-gray-900">
                我们怎么证明 Skill 有价值
              </h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
              使用同一模型、同一业务数据和同一任务，只替换
              Skill；再隐藏版本身份进行匿名 A/B
              评审，避免把回答更长或技术字段更多误判成专业能力。
            </p>
            <div className="mt-5 grid gap-3 lg:grid-cols-4">
              {report.methodology.map((step, index) => {
                const Icon = methodIcon(step.id);
                return (
                  <div
                    key={step.id}
                    className="relative border border-gray-200 p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 text-gray-700">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="font-mono text-xs text-gray-400">
                        0{index + 1}
                      </span>
                    </div>
                    <div className="mt-3 text-sm font-semibold text-gray-900">
                      {step.label}
                    </div>
                    <div className="mt-1 text-xs font-medium text-emerald-700">
                      {step.role}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-gray-500">
                      {step.description}
                    </p>
                    {index < report.methodology.length - 1 ? (
                      <ArrowRight className="absolute -right-5 top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-gray-300 lg:block" />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-900">评测依据</h3>
              <dl className="mt-3 divide-y divide-gray-100">
                {report.evidence.map(item => (
                  <div
                    key={item.label}
                    className="grid grid-cols-[100px_1fr] gap-3 py-3 text-xs"
                  >
                    <dt className="text-gray-500">{item.label}</dt>
                    <dd className="break-words font-medium text-gray-800">
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="border border-amber-200 bg-amber-50/50 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <Info className="h-4 w-4" />
                当前边界
              </div>
              <ul className="mt-3 space-y-2">
                {report.limitations.map(item => (
                  <li
                    key={item}
                    className="flex gap-2 text-xs leading-5 text-amber-900/80"
                  >
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </TabsContent>
      </div>
    </Tabs>
  );
}

export function SkillValueEvaluationDialog({
  open,
  onOpenChange,
  skillId,
  skillName,
}: SkillValueEvaluationDialogProps) {
  const report = getSkillValueEvaluationReport(skillId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[min(1180px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] flex-col gap-4 overflow-hidden p-5 sm:max-w-none">
        <DialogHeader className="border-b border-gray-200 pb-4 pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>Skill 价值评测</DialogTitle>
            {report ? (
              <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-600">
                {report.skillId}
              </span>
            ) : null}
          </div>
          <DialogDescription>
            {report
              ? `${report.skillName} · ${report.targetVersion} 对比 ${report.comparisonVersions.join(" / ")}`
              : `${skillName || skillId || "该技能"} 暂无价值评测报告`}
          </DialogDescription>
        </DialogHeader>
        {report ? (
          <EvaluationReport report={report} />
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center border border-dashed border-gray-300 bg-gray-50 px-6 text-center">
            <BookOpenCheck className="h-9 w-9 text-gray-400" />
            <div className="mt-3 text-sm font-semibold text-gray-800">
              尚未建立该 Skill 的价值评测
            </div>
            <p className="mt-2 max-w-md text-xs leading-5 text-gray-500">
              界面和报告结构适用于所有 Skill。后续只需补充该领域的任务
              Prompt、对照输出和专家评分，不需要重新开发页面。
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
