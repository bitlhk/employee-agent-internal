import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  ClipboardList,
  FlaskConical,
  History,
  Info,
  Loader2,
  PackageCheck,
  Play,
  RefreshCw,
  Scale,
  Sparkles,
  Target,
  UserRoundCheck,
} from "lucide-react";
import { Button } from "@/components/ui/action-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  getSkillValueEvaluationReport,
  type SkillValueCase,
  type SkillValueEvaluationReport,
  type SkillValueMetric,
} from "@/data/skill-value-evaluations";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type SkillValueEvaluationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillId: string | null;
  skillName?: string | null;
};

type EvaluationVersionOption = {
  versionId: string;
  version: string;
  artifactSha256: string;
  isLatest: boolean;
  releaseStatus: "approved" | "candidate";
  isRecommendedCandidate?: boolean;
};

type EvaluationModelOption = {
  id: string;
  name: string;
  description: string;
};

const WITHOUT_TARGET_SKILL = "without_target_skill";

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

function ComparisonSide({
  label,
  accent,
  selection,
  modelId,
  versions,
  models,
  onSelectionChange,
  onModelChange,
}: {
  label: string;
  accent: "neutral" | "primary";
  selection: string;
  modelId: string;
  versions: EvaluationVersionOption[];
  models: EvaluationModelOption[];
  onSelectionChange: (value: string) => void;
  onModelChange: (value: string) => void;
}) {
  const selectedVersion = versions.find(item => item.versionId === selection);
  return (
    <section
      className={cn(
        "min-w-0 border bg-white p-4",
        accent === "primary" ? "border-emerald-300" : "border-gray-200",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold",
              accent === "primary"
                ? "bg-emerald-600 text-white"
                : "bg-gray-800 text-white",
            )}
          >
            {label}
          </span>
          <span className="text-sm font-semibold text-gray-900">对比配置</span>
        </div>
        {accent === "primary" ? (
          <span className="text-xs font-medium text-emerald-700">目标组</span>
        ) : (
          <span className="text-xs text-gray-500">对照组</span>
        )}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-gray-600">
          Skill
          <Select value={selection} onValueChange={onSelectionChange}>
            <SelectTrigger className="w-full bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WITHOUT_TARGET_SKILL}>不加载当前 Skill</SelectItem>
              {versions.map(version => (
                <SelectItem key={version.versionId} value={version.versionId}>
                  v{version.version}{version.releaseStatus === "candidate" ? " · 候选" : version.isLatest ? " · 当前" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-gray-600">
          模型
          <Select value={modelId} onValueChange={onModelChange}>
            <SelectTrigger className="w-full bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map(model => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <div className="mt-3 min-h-10 border-t border-gray-100 pt-3 text-xs leading-5 text-gray-500">
        {selectedVersion ? (
          <span className="flex flex-wrap items-center gap-2">
            <span>{selectedVersion.releaseStatus === "candidate" ? "评测候选" : "已上架版本"}</span>
            <span>Artifact <span className="font-mono text-gray-700">{selectedVersion.artifactSha256.slice(0, 12)}</span></span>
          </span>
        ) : (
          <span>保留岗位基础能力，仅移除当前目标 Skill。</span>
        )}
      </div>
    </section>
  );
}

function NewEvaluationWorkbench({
  open,
  skillId,
}: {
  open: boolean;
  skillId: string;
}) {
  const contextQuery = trpc.claw.adminSkillEvaluationContext.useQuery(
    { skillId },
    { enabled: open && Boolean(skillId), retry: false },
  );
  const prepareMutation = trpc.claw.adminPrepareSkillEvaluation.useMutation({
    onError: error => toast.error(error.message || "准备评测失败"),
  });
  const [jobId, setJobId] = useState("");
  const startMutation = trpc.claw.adminStartSkillEvaluation.useMutation({
    onSuccess: job => setJobId(job.jobId),
    onError: error => toast.error(error.message || "启动评测失败"),
  });
  const jobQuery = trpc.claw.adminGetSkillEvaluationJob.useQuery(
    { jobId },
    {
      enabled: open && Boolean(jobId),
      retry: false,
      refetchInterval: jobId ? 1_000 : false,
    },
  );
  const [leftSelection, setLeftSelection] = useState(WITHOUT_TARGET_SKILL);
  const [rightSelection, setRightSelection] = useState("");
  const [leftModel, setLeftModel] = useState("");
  const [rightModel, setRightModel] = useState("");
  const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});

  const context = contextQuery.data;
  const plan = prepareMutation.data;
  const job = jobQuery.data;
  useEffect(() => {
    if (!context) return;
    setLeftSelection(context.defaultComparison.left.mode === "without_target_skill"
      ? WITHOUT_TARGET_SKILL
      : String(context.defaultComparison.left.versionId || ""));
    setRightSelection(String(context.defaultComparison.right.versionId || ""));
    setLeftModel(context.recommendedModelId);
    setRightModel(context.recommendedModelId);
  }, [context]);
  useEffect(() => {
    if (!plan) return;
    const firstStandard = plan.prompts.find(item => item.source === "curated");
    const firstVariation = plan.prompts.find(item => item.source !== "curated");
    setSelectedPromptIds(
      [firstStandard?.promptId, firstVariation?.promptId].filter(Boolean) as string[],
    );
    setPromptDrafts(Object.fromEntries(plan.prompts.map(item => [item.promptId, item.prompt])));
  }, [plan]);

  const versions = (context?.versions || []) as EvaluationVersionOption[];
  const models = (context?.models || []) as EvaluationModelOption[];
  const selectedVersionId = rightSelection !== WITHOUT_TARGET_SKILL
    ? rightSelection
    : leftSelection !== WITHOUT_TARGET_SKILL
      ? leftSelection
      : "";
  const sameConfiguration = Boolean(
    leftSelection
    && rightSelection
    && leftModel
    && rightModel
    && leftSelection === rightSelection
    && leftModel === rightModel,
  );
  const mixedVariables = leftSelection !== rightSelection && leftModel !== rightModel;

  if (contextQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取 Skill 版本与模型
      </div>
    );
  }
  if (contextQuery.error || !context) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center border border-red-200 bg-red-50 px-6 text-center">
        <Info className="h-8 w-8 text-red-500" />
        <div className="mt-3 text-sm font-semibold text-red-900">评测上下文读取失败</div>
        <p className="mt-2 text-xs text-red-700">{contextQuery.error?.message || "Skill 当前不可用"}</p>
        <Button className="mt-4" size="sm" variant="outline" onClick={() => contextQuery.refetch()}>
          <RefreshCw />重试
        </Button>
      </div>
    );
  }

  const prepare = () => {
    if (!selectedVersionId) {
      toast.error("至少一侧需要选择当前 Skill 的版本");
      return;
    }
    setJobId("");
    prepareMutation.mutate({ skillId, targetVersionId: selectedVersionId });
  };
  const togglePrompt = (promptId: string) => {
    setSelectedPromptIds(current => current.includes(promptId)
      ? current.filter(item => item !== promptId)
      : [...current, promptId]);
  };
  const startEvaluation = () => {
    if (!plan) return;
    const prompts = plan.prompts
      .filter(item => selectedPromptIds.includes(item.promptId))
      .map(item => ({
        promptId: item.promptId,
        name: item.name,
        prompt: String(promptDrafts[item.promptId] || item.prompt).trim(),
        evaluationGoal: item.evaluationGoal,
      }))
      .filter(item => item.prompt.length >= 8);
    if (prompts.length === 0) {
      toast.error("至少选择一条有效测试题");
      return;
    }
    startMutation.mutate({
      skillId,
      left: { selectionId: leftSelection, modelId: leftModel },
      right: { selectionId: rightSelection, modelId: rightModel },
      prompts,
    });
  };

  return (
    <div className="space-y-5">
      <section className="border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
              <Target className="h-3.5 w-3.5" />固定评测对象
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-base font-semibold text-gray-950">{context.skill.name}</span>
              <span className="font-mono text-xs text-gray-500">{context.skill.skillId}</span>
            </div>
          </div>
          <div className="text-xs text-gray-500">
            {versions.length} 个可评版本 · {models.length} 个可用模型
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ComparisonSide
          label="A"
          accent="neutral"
          selection={leftSelection}
          modelId={leftModel}
          versions={versions}
          models={models}
          onSelectionChange={setLeftSelection}
          onModelChange={setLeftModel}
        />
        <ComparisonSide
          label="B"
          accent="primary"
          selection={rightSelection}
          modelId={rightModel}
          versions={versions}
          models={models}
          onSelectionChange={setRightSelection}
          onModelChange={setRightModel}
        />
      </div>

      {sameConfiguration ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          左右配置完全相同，无法形成有效对比。
        </div>
      ) : mixedVariables ? (
        <div className="border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
          Skill 与模型同时变化，本轮只能得出综合方案差异，不能把提升单独归因于 Skill。
        </div>
      ) : null}

      <section className="border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <BrainCircuit className="h-4 w-4 text-emerald-700" />
              测试任务
            </div>
            <p className="mt-1 text-xs text-gray-500">
              固定业务锚点与 AI 变化题使用同一份输入运行左右两组。
            </p>
          </div>
          <Button
            size="sm"
            onClick={prepare}
            disabled={!selectedVersionId || sameConfiguration || prepareMutation.isPending}
          >
            {prepareMutation.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {plan ? "重新准备" : "准备测试"}
          </Button>
        </div>

        {prepareMutation.isPending ? (
          <div className="mt-4 grid gap-2 border-t border-gray-100 pt-4 sm:grid-cols-4">
            {["读取 Skill", "识别任务", "生成变化题", "组装对照"].map((label, index) => (
              <div key={label} className="flex items-center gap-2 text-xs text-gray-600">
                {index === 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" /> : <span className="h-2 w-2 rounded-full bg-gray-200" />}
                {label}
              </div>
            ))}
          </div>
        ) : null}

        {plan ? (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="border border-gray-200 bg-gray-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-gray-900">AI 分析结果</span>
                  <span className="text-[11px] text-gray-500">{plan.analyzerModel}</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-gray-700">{plan.summary}</p>
                <div className="mt-4">
                  <div className="text-[11px] font-medium text-gray-500">识别能力</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {plan.capabilities.map(item => (
                      <span key={item} className="border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700">{item}</span>
                    ))}
                  </div>
                </div>
                <div className="mt-4 text-[11px] leading-5 text-gray-500">
                  已读取 {plan.inspectedFiles.length} 个文件 · {plan.taskMode === "single_turn" ? "单步任务" : plan.taskMode === "multi_step" ? "多步任务" : "混合任务"}
                </div>
              </div>
              <div className="space-y-2">
                {plan.prompts.map((item, index) => {
                  const selected = selectedPromptIds.includes(item.promptId);
                  return (
                    <div key={item.promptId} className={cn("border p-3", selected ? "border-emerald-200 bg-emerald-50/30" : "border-gray-200 bg-gray-50 opacity-70")}>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => togglePrompt(item.promptId)}
                          aria-label={`选择测试题 ${item.name}`}
                          className="h-4 w-4 accent-emerald-600"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-gray-900">{index + 1}. {item.name}</span>
                            <span className={cn("border px-1.5 py-0.5 text-[10px]", item.source === "curated" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-violet-200 bg-violet-50 text-violet-700")}>
                              {item.source === "curated" ? "标准题" : item.source === "ai_generated" ? "AI 变化题" : "规则题"}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] text-gray-500">{item.evaluationGoal}</div>
                        </div>
                      </div>
                      <Textarea
                        value={promptDrafts[item.promptId] || ""}
                        onChange={event => setPromptDrafts(current => ({ ...current, [item.promptId]: event.target.value }))}
                        disabled={!selected}
                        className="mt-3 min-h-20 resize-y bg-white text-sm leading-6"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-gray-500">
                已选择 {selectedPromptIds.length} 条 · Promptfoo 对照执行 · 专业 Judge 盲评
              </div>
              <Button
                onClick={startEvaluation}
                disabled={
                  selectedPromptIds.length === 0
                  || sameConfiguration
                  || startMutation.isPending
                  || job?.status === "preparing"
                  || job?.status === "running"
                  || job?.status === "judging"
                }
              >
                {startMutation.isPending
                  || job?.status === "preparing"
                  || job?.status === "running"
                  || job?.status === "judging"
                  ? <Loader2 className="animate-spin" />
                  : <Play />}
                {job ? "重新对比" : "开始对比"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex min-h-28 items-center justify-center border border-dashed border-gray-300 bg-gray-50 text-xs text-gray-500">
            选择左右配置后准备测试任务
          </div>
        )}
      </section>

      {job ? (
        <section className="border border-gray-200 bg-white p-4">
          <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                {job.status === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : job.status === "failed" ? (
                  <Info className="h-4 w-4 text-red-500" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
                )}
                {job.stageLabel}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {job.roleTemplate} · Promptfoo {job.promptfoo.version}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-2 w-36 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width]"
                  style={{ width: `${job.totalRuns ? Math.round((job.completedRuns / job.totalRuns) * 100) : 0}%` }}
                />
              </div>
              <span className="font-mono text-xs text-gray-600">{job.completedRuns}/{job.totalRuns}</span>
            </div>
          </div>
          {job.error ? (
            <div className="mt-4 border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">{job.error}</div>
          ) : null}
          {job.summary ? (
            <div className="mt-4 border border-emerald-200 bg-emerald-50/40">
              <div className="flex flex-col gap-3 border-b border-emerald-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                    <BarChart3 className="h-4 w-4 text-emerald-700" />
                    {job.summary.headline}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {job.judge.modelId} 匿名业务 Judge · 不读取 Skill 版本标签
                  </div>
                </div>
                <div className="flex gap-2 text-xs font-medium">
                  <span className="border border-gray-300 bg-white px-2.5 py-1 text-gray-800">A 胜 {job.summary.leftWins}</span>
                  <span className="border border-emerald-300 bg-white px-2.5 py-1 text-emerald-800">B 胜 {job.summary.rightWins}</span>
                  <span className="border border-gray-200 bg-white px-2.5 py-1 text-gray-600">持平 {job.summary.ties}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 divide-x divide-emerald-100 text-center text-xs text-gray-600 sm:grid-cols-4">
                {[
                  "专业匹配",
                  "业务完整",
                  "表达清晰",
                  "可执行性",
                ].map(label => (
                  <div key={label} className="px-3 py-2">{label}</div>
                ))}
              </div>
            </div>
          ) : job.status === "judging" ? (
            <div className="mt-4 flex items-center justify-between border border-violet-200 bg-violet-50 px-4 py-3 text-xs text-violet-900">
              <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />专业 Judge 正在匿名比较左右输出</span>
              <span className="font-mono">{job.judge.completedCases}/{job.cases.length}</span>
            </div>
          ) : null}
          <div className="mt-4 space-y-4">
            {job.cases.map((item, index) => (
              <div key={item.promptId} className="border border-gray-200">
                <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
                  <div className="text-xs font-semibold text-gray-900">{index + 1}. {item.name}</div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{item.prompt}</div>
                </div>
                <div className="grid lg:grid-cols-2">
                  {(["left", "right"] as const).map((side, sideIndex) => {
                    const result = item[side];
                    const sideMeta = job[side];
                    return (
                      <div
                        key={side}
                        className={cn(
                          "min-w-0 p-4",
                          sideIndex === 0 ? "border-b border-gray-200 lg:border-b-0 lg:border-r" : "",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white", side === "left" ? "bg-gray-800" : "bg-emerald-600")}>
                              {side === "left" ? "A" : "B"}
                            </span>
                            <span className="truncate text-xs font-medium text-gray-700">
                              {sideMeta.skillVersion ? `v${sideMeta.skillVersion}` : "不加载当前 Skill"} · {sideMeta.modelId}
                            </span>
                          </div>
                          {result ? (
                            <span className={cn("text-[11px] font-medium", result.status === "completed" ? "text-emerald-700" : "text-red-600")}>
                              {result.status === "completed" ? `${(result.elapsedMs / 1000).toFixed(1)}s` : "失败"}
                            </span>
                          ) : (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                          )}
                        </div>
                        {result ? (
                          <>
                            <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-gray-700">
                              {result.assistantText || result.error || "无输出"}
                            </div>
                            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-100 pt-3">
                              {result.runtimeIdentityVerified ? (
                                <span className="border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">所选 Skill 已装配</span>
                              ) : null}
                              {result.toolCalls.map((tool, toolIndex) => (
                                <span key={`${tool.name}-${toolIndex}`} className={cn("border px-2 py-0.5 text-[10px]", tool.status === "completed" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-red-200 bg-red-50 text-red-700")}>
                                  {tool.name}
                                </span>
                              ))}
                              {result.error ? (
                                <span className="border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] text-red-700">{result.error}</span>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <div className="mt-3 flex min-h-32 items-center justify-center bg-gray-50 text-xs text-gray-400">等待执行</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {item.judge ? (
                  <div className="border-t border-gray-200 bg-gray-50">
                    <div className="flex flex-col gap-2 border-b border-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2">
                        <Scale className="h-4 w-4 text-violet-700" />
                        <span className="text-xs font-semibold text-gray-900">匿名专业评审</span>
                        <span className={cn(
                          "border px-2 py-0.5 text-[10px] font-semibold",
                          item.judge.winner === "right"
                            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                            : item.judge.winner === "left"
                              ? "border-gray-400 bg-white text-gray-800"
                              : "border-amber-300 bg-amber-50 text-amber-800",
                        )}>
                          {item.judge.winner === "right" ? "B 更优" : item.judge.winner === "left" ? "A 更优" : "表现持平"}
                        </span>
                      </div>
                      <span className="text-[10px] text-gray-500">{item.judge.reviewerLabel} · 置信度 {item.judge.confidence}</span>
                    </div>
                    <p className="px-4 py-3 text-sm leading-6 text-gray-700">{item.judge.summary}</p>
                    <div className="grid border-t border-gray-200 sm:grid-cols-2 xl:grid-cols-4">
                      {item.judge.dimensions.map((dimension, dimensionIndex) => (
                        <div
                          key={dimension.id}
                          className={cn(
                            "px-4 py-3",
                            dimensionIndex > 0 ? "border-t border-gray-200 sm:border-t-0 sm:border-l" : "",
                            dimensionIndex === 2 ? "sm:border-l-0 sm:border-t xl:border-l xl:border-t-0" : "",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-gray-800">{dimension.label}</span>
                            <span className="font-mono text-xs text-gray-600">
                              A {dimension.leftScore} · B {dimension.rightScore}
                            </span>
                          </div>
                          <p className="mt-2 text-[11px] leading-5 text-gray-500">{dimension.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : item.judgeError ? (
                  <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                    左右输出已保留，专业 Judge 暂不可用：{item.judgeError}
                  </div>
                ) : job.status === "judging" && item.left && item.right ? (
                  <div className="flex items-center gap-2 border-t border-violet-100 bg-violet-50 px-4 py-3 text-xs text-violet-800">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />等待专业评审
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
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
            {skillId ? (
              <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-600">
                {skillId}
              </span>
            ) : null}
          </div>
          <DialogDescription>
            {skillName || report?.skillName || skillId || "当前 Skill"} · 单 Skill 对照评测
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="new" className="min-h-0 gap-4">
          <TabsList className="w-full justify-start rounded-md bg-gray-100 sm:w-fit">
            <TabsTrigger value="new">
              <FlaskConical />新建对比
            </TabsTrigger>
            <TabsTrigger value="history">
              <History />历史结果{report ? " · 1" : ""}
            </TabsTrigger>
          </TabsList>
          <div className="max-h-[calc(86vh-150px)] overflow-y-auto pr-1">
            <TabsContent value="new">
              {skillId ? <NewEvaluationWorkbench open={open} skillId={skillId} /> : null}
            </TabsContent>
            <TabsContent value="history">
              {report ? (
                <EvaluationReport report={report} />
              ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center border border-dashed border-gray-300 bg-gray-50 px-6 text-center">
                  <BookOpenCheck className="h-9 w-9 text-gray-400" />
                  <div className="mt-3 text-sm font-semibold text-gray-800">暂无历史评测结果</div>
                  <p className="mt-2 max-w-md text-xs leading-5 text-gray-500">
                    完成首轮对比后，结果会保留在这里。
                  </p>
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
