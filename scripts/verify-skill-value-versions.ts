import "dotenv/config";
import {
  getSkillIdentityBySkillId,
  listSkillMarketItems,
  listSkillVersionsByIdentity,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { resolveSkillValueRoleTemplate } from "../server/_core/skill-value-evaluation-catalog";
import { resolveCuratedSkillValueSuite } from "../server/_core/skill-value-evaluation";
import {
  getSkillValueEvaluationJob,
  startSkillValueEvaluationJob,
  type SkillValueEvaluationArtifact,
  type SkillValueEvaluationJob,
} from "../server/_core/skill-value-evaluation-runner";
import { probeJiuwenSkillMcpReadiness } from "../server/_core/skill-mcp-readiness";

function option(name: string): string {
  const prefix = `--${name}=`;
  return String(process.argv.find(argument => argument.startsWith(prefix)) || "")
    .slice(prefix.length)
    .trim();
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

async function approvedArtifact(
  skillId: string,
  versionName: string,
): Promise<SkillValueEvaluationArtifact> {
  const identity = await getSkillIdentityBySkillId(skillId);
  if (!identity) return null;
  const version = (await listSkillVersionsByIdentity(identity.identityId))
    .find(item => item.status === "approved" && item.version === versionName);
  return version ? {
    versionId: version.versionId,
    version: version.version,
    artifactSha256: version.artifactSha256,
    artifactPath: version.artifactPath,
  } : null;
}

async function main() {
  const skillId = option("skill");
  const leftVersion = option("left-version");
  const rightVersion = option("right-version");
  if (!skillId || !leftVersion || !rightVersion) {
    throw new Error(
      "--skill=<skill-id>, --left-version=<version|without-skill> and --right-version=<version> are required",
    );
  }
  if (leftVersion === rightVersion) throw new Error("Left and right versions must differ");

  const [left, right] = await Promise.all([
    leftVersion === "without-skill" ? Promise.resolve(null) : approvedArtifact(skillId, leftVersion),
    approvedArtifact(skillId, rightVersion),
  ]);
  if (leftVersion !== "without-skill" && !left) {
    throw new Error(`Approved left version is unavailable: ${skillId}@${leftVersion}`);
  }
  if (!right) throw new Error(`Approved right version is unavailable: ${skillId}@${rightVersion}`);

  const resolvedSuite = resolveCuratedSkillValueSuite(process.cwd(), skillId, right);
  const suite = resolvedSuite.suite as {
    cases?: Array<{
      caseId?: unknown;
      name?: unknown;
      prompt?: unknown;
      expectedOutput?: unknown;
    }>;
  } | null;
  if (!suite) {
    throw new Error(`No curated suite matches approved ${skillId}@${rightVersion}`);
  }
  const configuredCases = (suite.cases || [])
    .filter(item => String(item.prompt || "").trim())
    .map((item, index) => ({
      promptId: String(item.caseId || `${skillId}-VERSION-${index + 1}`),
      name: String(item.name || `Version comparison case ${index + 1}`),
      prompt: String(item.prompt || ""),
      evaluationGoal: String(item.expectedOutput || "验证正式 Skill 版本的专业增益"),
    }));
  const caseId = option("case");
  const prompts = caseId
    ? configuredCases.filter(item => item.promptId === caseId)
    : process.argv.includes("--all-cases")
      ? configuredCases
      : configuredCases.slice(0, 1);
  if (prompts.length === 0) throw new Error(`No matching evaluation case: ${caseId || "first"}`);

  const roleTemplate = await resolveSkillValueRoleTemplate(skillId);
  const preflight = await probeJiuwenSkillMcpReadiness({
    skillId,
    roleTemplate,
    force: true,
    allowPlannedEnterpriseRuntime: true,
  });
  if (!preflight.canProceed) throw new Error(preflight.message);
  const marketRows = await listSkillMarketItems();
  const marketItem = marketRows.find(row => row.skillId === skillId && row.status === "approved");
  const modelId = option("model") || "glm-5.2";
  const job = startSkillValueEvaluationJob({
    skillId,
    skillName: String(marketItem?.name || skillId),
    roleTemplate,
    organization: "EA Skill Release Verification",
    left: { modelId, artifact: left },
    right: { modelId, artifact: right },
    prompts,
    preflight,
  });
  console.log(JSON.stringify({
    jobId: job.jobId,
    left: left ? `${left.version}/${left.versionId}/${left.artifactSha256}` : "without-skill",
    right: `${right.version}/${right.versionId}/${right.artifactSha256}`,
    cases: prompts.map(item => item.promptId),
  }, null, 2));

  const completed = await waitForTerminalJob(job.jobId);
  console.log(JSON.stringify({
    jobId: completed?.jobId,
    status: completed?.status,
    headline: completed?.summary?.headline,
    cases: completed?.cases.map(item => ({
      promptId: item.promptId,
      leftStatus: item.left?.status,
      rightStatus: item.right?.status,
      winner: item.judge?.winner || null,
      judgeSummary: item.judge?.summary || null,
      leftCharacters: item.left?.assistantText.length || 0,
      rightCharacters: item.right?.assistantText.length || 0,
    })),
    error: completed?.error || null,
  }, null, 2));
  if (completed?.status !== "completed") process.exitCode = 1;
}

main()
  .then(() => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
