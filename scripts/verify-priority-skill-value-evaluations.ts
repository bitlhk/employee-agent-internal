import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  getSkillIdentityBySkillId,
  listSkillMarketItems,
  listSkillVersionsByIdentity,
} from "../server/db";
import {
  buildPrioritySkillValueEvaluationSupportCatalog,
  resolveSkillValueRoleTemplate,
} from "../server/_core/skill-value-evaluation-catalog";
import { listRepositorySkillCandidates } from "../server/_core/skill-value-evaluation";
import { PRIORITY_SKILL_VALUE_EVALUATION_IDS } from "../server/_core/skill-value-evaluation-support";
import { probeJiuwenSkillMcpReadiness } from "../server/_core/skill-mcp-readiness";
import {
  getSkillValueEvaluationJob,
  startSkillValueEvaluationJob,
  type SkillValueEvaluationArtifact,
  type SkillValueEvaluationJob,
} from "../server/_core/skill-value-evaluation-runner";

const APP_ROOT = path.resolve(process.cwd());
const executeSmoke = process.argv.includes("--execute-smoke");
const requiredSkill = process.argv
  .find(argument => argument.startsWith("--skill="))
  ?.slice("--skill=".length);
const targetSkillIds = PRIORITY_SKILL_VALUE_EVALUATION_IDS
  .filter(skillId => skillId !== "wealth-manager-assistant")
  .filter(skillId => !requiredSkill || skillId === requiredSkill);

async function resolveArtifact(skillId: string): Promise<SkillValueEvaluationArtifact> {
  const identity = await getSkillIdentityBySkillId(skillId);
  const versions = identity
    ? (await listSkillVersionsByIdentity(identity.identityId))
      .filter(version => version.status === "approved")
    : [];
  const selected = versions.find(version => version.versionId === identity?.latestApprovedVersionId)
    || versions.sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }))[0];
  if (selected) return {
    versionId: selected.versionId,
    version: selected.version,
    artifactSha256: selected.artifactSha256,
    artifactPath: selected.artifactPath,
  };
  return listRepositorySkillCandidates(APP_ROOT, skillId)[0] || null;
}

function firstCuratedPrompt(skillId: string) {
  const suitePath = path.join(
    APP_ROOT,
    "examples",
    "skill-quality-evaluation-v1",
    "suites",
    `${skillId}.v1.json`,
  );
  if (!existsSync(suitePath)) return null;
  const suite = JSON.parse(readFileSync(suitePath, "utf8")) as {
    cases?: Array<{
      caseId?: unknown;
      name?: unknown;
      prompt?: unknown;
      expectedOutput?: unknown;
    }>;
  };
  const first = suite.cases?.find(item => String(item.prompt || "").trim());
  return first ? {
    promptId: String(first.caseId || `${skillId}-SMOKE`),
    name: String(first.name || "最小真实对比"),
    prompt: String(first.prompt || ""),
    evaluationGoal: String(first.expectedOutput || "验证 Skill 的专业增益"),
  } : null;
}

async function waitForTerminalJob(jobId: string): Promise<SkillValueEvaluationJob | null> {
  return await new Promise(resolve => {
    const timer = setInterval(() => {
      const current = getSkillValueEvaluationJob(jobId);
      if (current && !["completed", "failed", "cancelled"].includes(current.status)) return;
      clearInterval(timer);
      resolve(current);
    }, 1_000);
  });
}

async function main() {
  if (requiredSkill && targetSkillIds.length === 0) {
    throw new Error(`不属于本轮重点验证范围：${requiredSkill}`);
  }
  const catalog = (await buildPrioritySkillValueEvaluationSupportCatalog(APP_ROOT))
    .filter(item => targetSkillIds.includes(item.skillId as typeof targetSkillIds[number]));
  console.table(catalog.map(item => ({
    skill: item.skillId,
    version: item.version || "-",
    support: item.support.label,
    cases: item.support.curatedCaseCount,
    environment: item.readiness.status,
  })));
  if (catalog.some(item => item.support.level !== "full")) {
    process.exitCode = 1;
    if (!executeSmoke) return;
  }
  if (!executeSmoke) return;

  const marketRows = await listSkillMarketItems();
  for (const item of catalog) {
    const artifact = await resolveArtifact(item.skillId);
    const prompt = firstCuratedPrompt(item.skillId);
    if (!artifact || !prompt) throw new Error(`${item.skillId} 缺少可执行版本或固定业务题`);
    const roleTemplate = await resolveSkillValueRoleTemplate(item.skillId);
    const preflight = await probeJiuwenSkillMcpReadiness({
      skillId: item.skillId,
      roleTemplate,
      force: true,
    });
    const marketItem = marketRows.find(row => (
      row.skillId === item.skillId && row.status === "approved"
    ));
    const job = startSkillValueEvaluationJob({
      skillId: item.skillId,
      skillName: String(marketItem?.name || item.skillId),
      roleTemplate,
      organization: "EA Priority Skill Verification",
      left: { modelId: "glm-5.2", artifact: null },
      right: { modelId: "glm-5.2", artifact },
      prompts: [prompt],
      preflight,
    });
    console.log(`[${item.skillId}] 已开始 ${job.jobId}`);
    const completed = await waitForTerminalJob(job.jobId);
    console.log(JSON.stringify({
      skillId: item.skillId,
      jobId: job.jobId,
      status: completed?.status,
      leftStatus: completed?.cases[0]?.left?.status,
      rightStatus: completed?.cases[0]?.right?.status,
      winner: completed?.cases[0]?.judge?.winner || null,
      headline: completed?.summary?.headline || null,
      error: completed?.error || null,
    }));
    if (completed?.status !== "completed") process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode || 0),
  error => {
    console.error(error);
    process.exit(1);
  },
);
