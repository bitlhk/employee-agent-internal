import path from "node:path";
import {
  getSkillIdentityBySkillId,
  listSkillMarketItems,
  listSkillVersionsByIdentity,
} from "../server/db";
import { resolveSkillValueRoleTemplate } from "../server/_core/skill-value-evaluation-catalog";
import { resolveCuratedSkillValueSuite } from "../server/_core/skill-value-evaluation";
import { probeJiuwenSkillMcpReadiness } from "../server/_core/skill-mcp-readiness";
import {
  getSkillValueEvaluationJob,
  startSkillValueEvaluationJob,
  type SkillValueEvaluationArtifact,
  type SkillValueEvaluationJob,
} from "../server/_core/skill-value-evaluation-runner";
import { digestSkillSourceTree } from "../server/_core/skills/skill-artifact";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";

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

async function currentApprovedArtifact(skillId: string): Promise<SkillValueEvaluationArtifact> {
  const identity = await getSkillIdentityBySkillId(skillId);
  if (!identity) return null;
  const versions = (await listSkillVersionsByIdentity(identity.identityId))
    .filter(version => version.status === "approved");
  const selected = versions.find(version => version.versionId === identity.latestApprovedVersionId)
    || versions.sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }))[0];
  return selected ? {
    versionId: selected.versionId,
    version: selected.version,
    artifactSha256: selected.artifactSha256,
    artifactPath: selected.artifactPath,
  } : null;
}

async function main() {
  const skillId = option("skill");
  const sourceOption = option("candidate-path");
  if (!skillId || !sourceOption) {
    throw new Error("--skill=<skill-id> and --candidate-path=<directory> are required");
  }
  const sourcePath = path.resolve(sourceOption);
  const parsed = parseSkillSourceDirectory(sourcePath, skillId);
  if (parsed.skillId !== skillId) throw new Error(`Candidate Skill ID mismatch: ${parsed.skillId}`);
  if (parsed.warnings.length > 0) throw new Error(`Candidate static scan failed: ${parsed.warnings.join("; ")}`);
  const version = String(parsed.manifest?.version || "").trim();
  if (!version) throw new Error("Candidate version is missing");
  const digest = digestSkillSourceTree(sourcePath);
  const candidate: SkillValueEvaluationArtifact = {
    versionId: `candidate-${skillId}-${version}`,
    version,
    artifactSha256: digest.sha256,
    artifactPath: sourcePath,
  };
  const suite = resolveCuratedSkillValueSuite(process.cwd(), skillId, candidate).suite as {
    cases?: Array<{
      caseId?: unknown;
      name?: unknown;
      prompt?: unknown;
      expectedOutput?: unknown;
    }>;
  } | null;
  if (!suite) throw new Error(`No curated suite matches ${skillId}@${version}/${digest.sha256}`);
  const configuredCases = (suite.cases || [])
    .filter(item => String(item.prompt || "").trim())
    .map((item, index) => ({
      promptId: String(item.caseId || `${skillId}-CANDIDATE-${index + 1}`),
      name: String(item.name || `Candidate case ${index + 1}`),
      prompt: String(item.prompt || ""),
      evaluationGoal: String(item.expectedOutput || "验证候选 Skill 的专业增益"),
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
  const baseline = option("baseline") || "current";
  if (!new Set(["current", "without-skill"]).has(baseline)) {
    throw new Error("--baseline must be current or without-skill");
  }
  const current = baseline === "current" ? await currentApprovedArtifact(skillId) : null;
  if (baseline === "current" && !current) throw new Error(`No approved baseline for ${skillId}`);
  const marketRows = await listSkillMarketItems();
  const marketItem = marketRows.find(row => row.skillId === skillId && row.status === "approved");
  const modelId = option("model") || "glm-5.2";
  const job = startSkillValueEvaluationJob({
    skillId,
    skillName: String(marketItem?.name || parsed.displayName || skillId),
    roleTemplate,
    organization: "EA Skill Candidate Verification",
    left: { modelId, artifact: current },
    right: { modelId, artifact: candidate },
    prompts,
    preflight,
  });
  console.log(JSON.stringify({
    jobId: job.jobId,
    baseline: current ? `${current.version}/${current.artifactSha256}` : "without-skill",
    candidate: `${candidate.version}/${candidate.artifactSha256}`,
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

main().then(
  () => process.exit(process.exitCode || 0),
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
