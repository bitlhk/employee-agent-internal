import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessSkillValueEvaluationSupport,
  inspectCuratedSkillValueSuite,
  type CuratedSkillValueSuiteInspection,
} from "./skill-value-evaluation-support";
import type { SkillMcpReadiness } from "./skill-mcp-readiness";

const suite: CuratedSkillValueSuiteInspection = {
  exists: true,
  matchesVersion: true,
  caseCount: 2,
};

function readiness(
  status: SkillMcpReadiness["status"],
  canProceed = status !== "blocked",
): SkillMcpReadiness {
  return {
    skillId: "demo-skill",
    status,
    canProceed,
    message: status === "blocked" ? "缺少 required_tool" : "运行环境已就绪",
    checkedAt: "2026-09-04T00:00:00.000Z",
    servers: [],
  };
}

describe("Skill value evaluation support", () => {
  it("reports full support when the comparison evidence is ready", () => {
    expect(assessSkillValueEvaluationSupport({
      artifactAvailable: true,
      modelCount: 2,
      suite,
      readiness: readiness("ready"),
    })).toMatchObject({
      level: "full",
      label: "完全支持",
      canStart: true,
      curatedCaseCount: 2,
      limitations: [],
    });
  });

  it("keeps AI-generated evaluation available but marks missing fixed cases", () => {
    const result = assessSkillValueEvaluationSupport({
      artifactAvailable: true,
      modelCount: 1,
      suite: { exists: false, matchesVersion: false, caseCount: 0 },
      readiness: readiness("not_required"),
    });

    expect(result).toMatchObject({ level: "partial", canStart: true });
    expect(result.limitations).toContain("尚无固定业务题，将仅使用 AI 变化题");
  });

  it("blocks a comparison when its declared Runtime dependencies are unavailable", () => {
    const result = assessSkillValueEvaluationSupport({
      artifactAvailable: true,
      modelCount: 1,
      suite,
      readiness: readiness("blocked", false),
    });

    expect(result).toMatchObject({ level: "unsupported", canStart: false });
    expect(result.checks.find(item => item.id === "runtime_environment"))
      .toMatchObject({ status: "fail" });
  });

  it("blocks a comparison without an installable artifact or model", () => {
    const result = assessSkillValueEvaluationSupport({
      artifactAvailable: false,
      modelCount: 0,
      suite,
      readiness: readiness("not_required"),
    });

    expect(result).toMatchObject({ level: "unsupported", canStart: false });
    expect(result.summary).toContain("Skill 版本、评测模型");
  });

  it("counts only fixed cases matching the selected version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "skill-value-support-"));
    const suiteDir = path.join(root, "examples", "skill-quality-evaluation-v1", "suites");
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(path.join(suiteDir, "demo-skill.v1.json"), JSON.stringify({
      targetVersion: "2.0.0",
      cases: [
        { prompt: "请完成第一项业务任务" },
        { prompt: "" },
        { prompt: "请完成第二项业务任务" },
      ],
    }));
    try {
      expect(inspectCuratedSkillValueSuite({
        root,
        skillId: "demo-skill",
        version: "2.0.0",
        artifactSha256: "a".repeat(64),
      })).toEqual({ exists: true, matchesVersion: true, caseCount: 2 });
      expect(inspectCuratedSkillValueSuite({
        root,
        skillId: "demo-skill",
        version: "2.1.0",
        artifactSha256: "b".repeat(64),
      })).toEqual({ exists: true, matchesVersion: false, caseCount: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
