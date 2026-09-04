import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SkillMcpReadiness } from "./skill-mcp-readiness";
import { curatedSkillValueSuiteMatchesVersion } from "./skill-value-evaluation";

export type SkillValueEvaluationSupportLevel = "full" | "partial" | "unsupported";

export type SkillValueEvaluationSupportCheck = {
  id: "artifact" | "standard_cases" | "model" | "runtime_environment";
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
};

export type SkillValueEvaluationSupport = {
  level: SkillValueEvaluationSupportLevel;
  label: "完全支持" | "部分支持" | "暂不支持";
  canStart: boolean;
  summary: string;
  curatedCaseCount: number;
  checks: SkillValueEvaluationSupportCheck[];
  limitations: string[];
};

export type CuratedSkillValueSuiteInspection = {
  exists: boolean;
  matchesVersion: boolean;
  caseCount: number;
};

export const PRIORITY_SKILL_VALUE_EVALUATION_IDS = [
  "wealth-manager-assistant",
  "auto-insurance-advisor",
  "bond-quote-parse",
  "goldencoach-stage-evaluation",
  "investment-research-assistant",
  "post-loan-risk-control-assistant",
  "smart-audit-assistant",
] as const;

export function inspectCuratedSkillValueSuite(input: {
  root?: string;
  skillId: string;
  version: string;
  artifactSha256: string;
}): CuratedSkillValueSuiteInspection {
  const root = path.resolve(input.root || process.cwd());
  const suitePath = path.join(
    root,
    "examples",
    "skill-quality-evaluation-v1",
    "suites",
    `${input.skillId}.v1.json`,
  );
  if (!existsSync(suitePath)) {
    return { exists: false, matchesVersion: false, caseCount: 0 };
  }
  try {
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as {
      targetVersion?: unknown;
      targetArtifactSha256?: unknown;
      cases?: Array<{ prompt?: unknown }>;
    };
    const matchesVersion = curatedSkillValueSuiteMatchesVersion(suite, input);
    const caseCount = matchesVersion && Array.isArray(suite.cases)
      ? suite.cases.filter(item => String(item?.prompt || "").trim()).length
      : 0;
    return { exists: true, matchesVersion, caseCount };
  } catch {
    return { exists: true, matchesVersion: false, caseCount: 0 };
  }
}

export function assessSkillValueEvaluationSupport(input: {
  artifactAvailable: boolean;
  modelCount: number;
  suite: CuratedSkillValueSuiteInspection;
  readiness: SkillMcpReadiness;
}): SkillValueEvaluationSupport {
  const checks: SkillValueEvaluationSupportCheck[] = [
    {
      id: "artifact",
      label: "Skill 版本",
      status: input.artifactAvailable ? "pass" : "fail",
      detail: input.artifactAvailable ? "版本资产可装配" : "版本资产不可用",
    },
    {
      id: "standard_cases",
      label: "固定业务题",
      status: input.suite.caseCount > 0 ? "pass" : "warning",
      detail: input.suite.caseCount > 0
        ? `${input.suite.caseCount} 道固定业务题可用`
        : input.suite.exists && !input.suite.matchesVersion
          ? "固定题未匹配当前版本"
          : "尚无固定业务题，将仅使用 AI 变化题",
    },
    {
      id: "model",
      label: "评测模型",
      status: input.modelCount > 0 ? "pass" : "fail",
      detail: input.modelCount > 0 ? `${input.modelCount} 个模型可用` : "没有可用模型",
    },
    {
      id: "runtime_environment",
      label: "运行环境",
      status: input.readiness.status === "ready" || input.readiness.status === "not_required"
        ? "pass"
        : input.readiness.status === "unchecked"
          ? "warning"
          : "fail",
      detail: input.readiness.message,
    },
  ];
  const hardFailures = checks.filter(item => item.status === "fail");
  const limitations = checks
    .filter(item => item.status === "warning")
    .map(item => item.detail);

  if (hardFailures.length > 0) {
    return {
      level: "unsupported",
      label: "暂不支持",
      canStart: false,
      summary: `当前缺少${hardFailures.map(item => item.label).join("、")}，暂时不能形成有效对比。`,
      curatedCaseCount: input.suite.caseCount,
      checks,
      limitations,
    };
  }
  if (limitations.length > 0) {
    return {
      level: "partial",
      label: "部分支持",
      canStart: true,
      summary: "当前可以运行 A/B 对比，但证据覆盖存在限制。",
      curatedCaseCount: input.suite.caseCount,
      checks,
      limitations,
    };
  }
  return {
    level: "full",
    label: "完全支持",
    canStart: true,
    summary: "版本、固定业务题、模型和运行环境均已就绪，可直接进行真实 A/B 评测。",
    curatedCaseCount: input.suite.caseCount,
    checks,
    limitations: [],
  };
}
