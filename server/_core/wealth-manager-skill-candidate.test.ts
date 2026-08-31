import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWealthSkill21CandidateComparisonPlan,
  loadWealthSkill21CandidateComparison,
} from "./skill-quality-evaluation-candidate";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const candidateRoot = path.resolve(
  process.cwd(),
  "examples",
  "skill-quality-evaluation-v1",
  "candidates",
  "wealth-manager-assistant",
  "2.1.0"
);
const hardenedCandidateRoot = path.resolve(
  process.cwd(),
  "examples",
  "skill-quality-evaluation-v1",
  "candidates",
  "wealth-manager-assistant",
  "2.1.1"
);
const runtimeHardenedCandidateRoot = path.resolve(
  process.cwd(),
  "examples",
  "skill-quality-evaluation-v1",
  "candidates",
  "wealth-manager-assistant",
  "2.1.2"
);
const fastPathCandidateRoot = path.resolve(
  process.cwd(),
  "examples",
  "skill-quality-evaluation-v1",
  "candidates",
  "wealth-manager-assistant",
  "2.1.3"
);
const productionRoot = path.resolve(
  process.cwd(),
  "examples",
  "wealth-manager-reference-role-pack",
  "skills",
  "wealth-manager-assistant"
);
const baselinePath = path.resolve(
  process.cwd(),
  "examples",
  "skill-quality-evaluation-v1",
  "wealth-manager-assistant-2.1-candidate-baseline.v1.json"
);

describe("wealth manager assistant 2.1 candidate", () => {
  it("is a separate parseable candidate for the existing Skill identity", () => {
    const parsed = parseSkillSourceDirectory(
      candidateRoot,
      "wealth-manager-assistant"
    );
    expect(parsed.skillId).toBe("wealth-manager-assistant");
    expect(parsed.manifest?.version).toBe("2.1.0");
    expect(parsed.manifest?.status).toBe("candidate");
    expect(parsed.manifest?.source).toMatchObject({
      originalAuthor: "李文华",
      baseVersion: "2.0.2",
      candidateMaintainer: "灵感岗位智能体团队",
      domainReview: "ai_assisted_confirmed",
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("binds the candidate and professional-delta baseline to source digests", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      status: string;
      candidate: {
        sourceTreeSha256: string;
        sourceTreeSize: number;
        published: boolean;
        deployed: boolean;
      };
      comparisonBaselines: { professionalDelta: { sourceTreeSha256: string } };
      promotionBoundary: {
        mayPublish: boolean;
        mayDeploy: boolean;
        internalPilot: {
          status: string;
          maxAdoptionsPerEnvironment: number;
          roleDefaultReleaseAllowed: boolean;
          marketQualityBadgeAllowed: boolean;
          formalScoreAvailable: boolean;
          rollbackVersion: string;
          requiredCandidateSha256: string;
        };
      };
    };
    const candidateDigest = digestSkillSourceTree(candidateRoot);
    const productionDigest = digestSkillSourceTree(productionRoot);
    expect(baseline.status).toBe(
      "controlled_harness_runtime_ai_expert_and_judge_holdout_passed_human_review_pending"
    );
    expect(baseline.candidate).toMatchObject({
      sourceTreeSha256: candidateDigest.sha256,
      sourceTreeSize: candidateDigest.size,
      published: false,
      deployed: false,
    });
    expect(
      baseline.comparisonBaselines.professionalDelta.sourceTreeSha256
    ).toBe(productionDigest.sha256);
    expect(baseline.promotionBoundary).toMatchObject({
      mayPublish: false,
      mayDeploy: false,
      internalPilot: {
        status: "APPROVED_FOR_SINGLE_ADOPTION_PILOT",
        maxAdoptionsPerEnvironment: 1,
        roleDefaultReleaseAllowed: false,
        marketQualityBadgeAllowed: false,
        formalScoreAvailable: false,
        rollbackVersion: "2.0.2",
        requiredCandidateSha256: candidateDigest.sha256,
      },
    });
  });

  it("keeps the default entrypoint smaller than the current reference Skill", () => {
    const candidate = readFileSync(
      path.join(candidateRoot, "SKILL.md"),
      "utf8"
    );
    const production = readFileSync(
      path.join(productionRoot, "SKILL.md"),
      "utf8"
    );
    expect(Buffer.byteLength(candidate)).toBeLessThan(
      Buffer.byteLength(production)
    );
    expect(candidate.split(/\r?\n/u).length).toBeLessThan(220);
    expect(candidate).toContain("EA Runtime 决定能不能做");
    expect(candidate).toContain("先组合、后产品");
    expect(candidate).toContain("首轮最多提出三个");
    expect(candidate).toContain("不为凑格式强制两套方案");
  });

  it("uses canonical customer tools and the governed recommendation contract", () => {
    const skill = readFileSync(path.join(candidateRoot, "SKILL.md"), "utf8");
    expect(skill).toContain("`search_customers`");
    expect(skill).toContain("`get_customer_profile`");
    expect(skill).toContain("`get_customer_portfolio`");
    expect(skill).toContain("`prepare_wealth_allocation_context`");
    expect(skill).toContain("`wealth_assistant_product_search`");
    expect(skill).toContain("`wealth_assistant_product_info`");
    expect(skill).toContain("正式推荐只能使用 `eligibleProducts`");
    expect(skill).toContain("可以解释 `excludedProducts`");
    expect(skill).toContain("应完成正式候选推荐");
    expect(skill).toContain("只读结果，不生成确认卡");
    expect(skill).not.toContain("wealth_assistant_customer_list");
    expect(skill).not.toContain("wealth_assistant_customer_detail");
  });

  it("ships only the four frozen professional references", () => {
    const references = readdirSync(path.join(candidateRoot, "references"))
      .filter(file => file.endsWith(".md"))
      .sort();
    expect(references).toEqual([
      "communication-patterns.md",
      "expert-cases-v1.md",
      "portfolio-recommendation.md",
      "previsit-and-discovery.md",
    ]);
  });

  it("covers insight, risk experience, complaint recovery and positive recommendation", () => {
    const cases = readFileSync(
      path.join(candidateRoot, "references", "expert-cases-v1.md"),
      "utf8"
    );
    for (const caseId of [
      "WM-PRE-001",
      "WM-PRE-004",
      "WM-COM-008",
      "WM-REC-009",
    ]) {
      expect(cases).toContain(caseId);
    }
    expect(cases).toContain("将 323 天期限产品描述为高流动性资产");
    expect(cases).toContain("先选择产品，再反向拼配置理由");
  });

  it("keeps locked products outside the liquidity floor", () => {
    const recommendation = readFileSync(
      path.join(candidateRoot, "references", "portfolio-recommendation.md"),
      "utf8"
    );
    expect(recommendation).toContain("323` 天封闭产品应归入期限受限的稳健层");
    expect(recommendation).toContain("必须使用这些事实形成两套金额闭合的方案");
    expect(recommendation).toContain("必须形成正式候选");
    expect(recommendation).toContain("正向推荐本身是只读分析");
  });

  it("does not duplicate platform authorization and transaction engines", () => {
    const files = [
      "SKILL.md",
      ...readdirSync(path.join(candidateRoot, "references")).map(
        file => `references/${file}`
      ),
    ];
    const text = files
      .map(file => readFileSync(path.join(candidateRoot, file), "utf8"))
      .join("\n");
    expect(text).not.toContain("allowedPurposes:");
    expect(text).not.toContain("mappingRuleVersion:");
    expect(text).not.toContain("calculatorRef:");
    expect(text).not.toContain("hardGateFailures:");
  });

  it("freezes a repository-bound three-arm candidate comparison", () => {
    const plan = buildWealthSkill21CandidateComparisonPlan();
    expect(plan).toMatchObject({
      status: "READY",
      sourceIdentityMode: "candidate_repository",
      targetVersion: "2.1.3",
      previousVersion: "2.1.2",
      cases: 7,
      repeats: 3,
      plannedRuns: 63,
      nativeRuntimeIdentity: "UNVERIFIED",
    });
    expect(plan.arms).toEqual([
      "target_skill",
      "without_target_skill",
      "previous_version",
    ]);
  });

  it("freezes 2.1.1 as a separate evidence-hardening candidate", () => {
    const parsed = parseSkillSourceDirectory(
      hardenedCandidateRoot,
      "wealth-manager-assistant"
    );
    expect(parsed.manifest).toMatchObject({
      version: "2.1.1",
      status: "candidate",
      source: {
        originalAuthor: "李文华",
        baseVersion: "2.1.0",
        adaptation: "professional-evidence-hardening",
      },
    });
    expect(parsed.warnings).toEqual([]);

    const comparison = loadWealthSkill21CandidateComparison(
      process.cwd(),
      "wealth-manager-assistant-2.1.1"
    );
    expect(comparison.target).toMatchObject({
      version: "2.1.1",
      artifactSha256:
        "a9a38f60c4ee9b9918350c1cb27548fcc860ec586969cf24db3644b0e100513b",
    });
    expect(comparison.previousVersion).toMatchObject({ version: "2.1.0" });
  });

  it("keeps raw business codes and unsupported numeric scenarios out of professional claims", () => {
    const skill = readFileSync(
      path.join(hardenedCandidateRoot, "SKILL.md"),
      "utf8"
    );
    const previsit = readFileSync(
      path.join(
        hardenedCandidateRoot,
        "references",
        "previsit-and-discovery.md"
      ),
      "utf8"
    );
    const communication = readFileSync(
      path.join(
        hardenedCandidateRoot,
        "references",
        "communication-patterns.md"
      ),
      "utf8"
    );
    expect(skill).toContain("原始业务码不是自然语言结论");
    expect(skill).toContain("具体含义待机构口径确认");
    expect(skill).toContain("不自行选择 `3%`、`5%` 等场景");
    expect(skill).toContain("当前来源在数据时点未返回相应记录");
    expect(previsit).toContain("最大短期浮亏大约是多少");
    expect(communication).not.toContain("短期下降 3%");
  });

  it("freezes 2.1.2 as a runtime-injection hardening candidate", () => {
    const parsed = parseSkillSourceDirectory(
      runtimeHardenedCandidateRoot,
      "wealth-manager-assistant"
    );
    expect(parsed.manifest).toMatchObject({
      version: "2.1.2",
      status: "candidate",
      source: {
        originalAuthor: "李文华",
        baseVersion: "2.1.1",
        adaptation: "runtime-injection-hardening",
      },
    });
    expect(parsed.warnings).toEqual([]);

    const comparison = loadWealthSkill21CandidateComparison(
      process.cwd(),
      "wealth-manager-assistant-2.1.2"
    );
    expect(comparison.target).toMatchObject({
      version: "2.1.2",
      artifactSha256:
        "b669dd2ad7e6f95a1b0945d2c43302f1d307d7b1d8c8b463424fbcd2fba2f606",
    });
    expect(comparison.previousVersion).toMatchObject({
      version: "2.1.1",
      artifactSha256:
        "a9a38f60c4ee9b9918350c1cb27548fcc860ec586969cf24db3644b0e100513b",
    });
  });

  it("places the runtime fact rules inside the complete injected entrypoint", () => {
    const skill = readFileSync(
      path.join(runtimeHardenedCandidateRoot, "SKILL.md"),
      "utf8"
    );
    const hardRules = skill.indexOf("## 事实表达硬规则");
    const references = skill.indexOf("## 参考资料按需读取");
    expect(skill.length).toBeLessThan(8_000);
    expect(hardRules).toBeGreaterThanOrEqual(0);
    expect(hardRules).toBeLessThan(1_000);
    expect(references).toBeGreaterThan(hardRules);
    expect(skill.slice(hardRules, references)).toContain(
      "不得把 `C4` 写成“进取型”"
    );
    expect(skill.slice(hardRules, references)).toContain(
      "不得把层级 `2` 写成“2级”“2星”"
    );
    expect(skill.slice(hardRules, references)).toContain(
      "不得自行补 `3%`、`1-3年`、`24小时`、`3个工作日`"
    );
    expect(skill.slice(hardRules, references)).toContain(
      "用户未明确要求下载文件时，直接在对话中输出"
    );
  });

  it("freezes 2.1.3 as a professional fast-path candidate", () => {
    const parsed = parseSkillSourceDirectory(
      fastPathCandidateRoot,
      "wealth-manager-assistant"
    );
    expect(parsed.manifest).toMatchObject({
      version: "2.1.3",
      status: "candidate",
      source: {
        originalAuthor: "李文华",
        baseVersion: "2.1.2",
        adaptation: "professional-fast-path-and-product-rigor",
      },
    });
    expect(parsed.warnings).toEqual([]);

    const comparison = loadWealthSkill21CandidateComparison(
      process.cwd(),
      "wealth-manager-assistant-2.1.3"
    );
    expect(comparison.target).toMatchObject({
      version: "2.1.3",
      artifactSha256:
        "be28b298fd3ff80406338099c8e7c4ff2fd18e24c270f958f2d1bc0e785b0bfc",
    });
    expect(comparison.previousVersion).toMatchObject({ version: "2.1.2" });
  });

  it("uses short task paths and comparable product metrics", () => {
    const skill = readFileSync(
      path.join(fastPathCandidateRoot, "SKILL.md"),
      "utf8"
    );
    const recommendation = readFileSync(
      path.join(
        fastPathCandidateRoot,
        "references",
        "portfolio-recommendation.md"
      ),
      "utf8"
    );
    expect(skill).toContain("单客户访前或需求诊断");
    expect(skill).toContain("不调用批量到期扫描、市场资讯或任何产品工具");
    expect(skill).toContain("普通单任务最多调用五次业务工具");
    expect(skill).toContain("一次任务最多读取一个参考文件");
    expect(skill).toContain("不得改写成“近一年收益”");
    expect(skill).toContain("不代表未来“收益潜力”");
    expect(recommendation).toContain("权益类、固定收益类或风险等级更高不等于“收益潜力最高”");
  });
});
