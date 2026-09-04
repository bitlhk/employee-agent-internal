import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { skillEvalSuiteV1Schema } from "../../shared/skill-quality-evaluation";
import { skillEvalSuiteFingerprint } from "./skill-quality-evaluation";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const skillRoot = path.resolve(
  process.cwd(),
  "examples/insurance-advisor-reference-role-pack/skills/goldencoach-stage-evaluation",
);
const suitePath = path.resolve(
  process.cwd(),
  "examples/skill-quality-evaluation-v1/suites/goldencoach-stage-evaluation.2.2.1.json",
);

describe("goldencoach stage evaluation 2.2.1 candidate", () => {
  it("is a clean installable patch release", () => {
    const parsed = parseSkillSourceDirectory(skillRoot, "goldencoach-stage-evaluation");
    expect(parsed.skillId).toBe("goldencoach-stage-evaluation");
    expect(parsed.manifest?.version).toBe("2.2.1");
    expect(parsed.warnings).toEqual([]);
  });

  it("defaults short stage-review tasks to focused output", () => {
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(markdown).toContain("聚焦阶段点评，默认模式");
    expect(markdown).toContain("不能仅因用户粘贴了对话就判定为完整点评");
    expect(markdown).toContain("不输出总分、等级、完整七模块表或完整客户画像");
  });

  it("keeps customer and product inferences evidence-bound", () => {
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(markdown).toContain("不得从一次简短对话推断客户的金融素养");
    expect(markdown).toContain("不得臆测产品责任、保费变化原因、理赔规则");
    expect(markdown).toContain("能改变后续方案、报价、沟通顺序或下一步动作");
    expect(markdown).toContain("整句话只保留一个问号");
  });

  it("ships a fingerprinted three-case candidate suite", () => {
    const suite = skillEvalSuiteV1Schema.parse(JSON.parse(readFileSync(suitePath, "utf8")));
    expect(suite.cases).toHaveLength(3);
    expect(suite.targetVersion).toBe("2.2.1");
    expect(suite.suiteFingerprint).toBe(skillEvalSuiteFingerprint(suite));
  });
});
