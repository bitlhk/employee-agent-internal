import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  expectedReferenceRoleTaskIds,
  referenceRolePack,
  type ReferenceRolePackDefinition,
} from "./reference-role-pack-registry";

export const WEALTH_EVAL_SUITE_VERSION = referenceRolePack("wealth-manager")!.evalSuiteVersion;
export const INSURANCE_EVAL_SUITE_VERSION = referenceRolePack("insurance-advisor")!.evalSuiteVersion;
export const POST_LOAN_RISK_EVAL_SUITE_VERSION = referenceRolePack("post-loan-risk-control")!.evalSuiteVersion;
export const SMART_AUDIT_EVAL_SUITE_VERSION = referenceRolePack("smart-audit")!.evalSuiteVersion;
export const INVESTMENT_RESEARCH_EVAL_SUITE_VERSION = referenceRolePack("investment-research")!.evalSuiteVersion;

type BenchmarkCase = {
  caseId: string;
  path: "NORMAL" | "DENY" | "DEGRADED" | "CONFIRM" | "SOURCE";
  prompt: string;
  requiredCapabilities?: string[];
  assertions: string[];
};

type BenchmarkTask = {
  schemaVersion: string;
  taskId: string;
  taskName: string;
  roleTemplate: string;
  requiredCapabilities?: string[];
  cases: BenchmarkCase[];
};

export type AssertionCategory = "business_data" | "knowledge_policy" | "execution_control" | "user_experience" | "runtime_invariant";

export function classifyBenchmarkAssertion(assertion: string): AssertionCategory | null {
  if (/(?:customer|product|data_as_of|maturity|facts|source_tools|profile|coverage|exam_points|source_ids|needs_and_selection)/u.test(assertion)) return "business_data";
  if (/(?:policy|knowledge|eligibility|expired|historical|validity|document|current_previsit|source_is|sources_are|evidence_is)/u.test(assertion)) return "knowledge_policy";
  if (/(?:executor|approval|idempotency|receipt|record|side_effect|pep|confirmation|write|same_key|human_escalation|sensitive_data|is_blocked|are_refused|is_refused)/u.test(assertion)) return "execution_control";
  if (/(?:output|title|guidance|recovery|remediation|failure|error|minimum_input|minimum_safe|visible|disclos|next_step|unavailable|explain|script|score|language|framework|coaching|identified|is_shown|is_returned)/u.test(assertion)) return "user_experience";
  if (/(?:limit|priority|deterministic|retry|bypass|invented|static|scope|owned|authorized|mismatch|restricted|formal|recommendation|candidate|excluded|stopped|channel|risk|at_most_one|does_not|not_|skill_is_reused|verification_is_required|dimension_fails|may_continue)/u.test(assertion)) return "runtime_invariant";
  return null;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function runReferenceRolePackContractChecks(root: string, config: ReferenceRolePackDefinition) {
  const packRoot = path.join(root, "examples", config.packDirectory);
  const evalRoot = path.join(packRoot, "eval");
  const filePattern = new RegExp(`^${config.taskPrefix.toLowerCase()}-gt-\\d{2}-cases\\.json$`, "u");
  const taskFiles = readdirSync(evalRoot).filter((file) => filePattern.test(file)).sort();
  const tasks = taskFiles.map((file) => ({ file, value: readJson<BenchmarkTask>(path.join(evalRoot, file)) }));
  const errors: string[] = [];
  const expectedTaskIds = expectedReferenceRoleTaskIds(config);
  if (JSON.stringify(tasks.map((task) => task.value.taskId)) !== JSON.stringify(expectedTaskIds)) {
    errors.push(`Expected benchmark tasks ${expectedTaskIds.join(", ")}`);
  }

  const assertionCategories: Record<AssertionCategory, number> = {
    business_data: 0,
    knowledge_policy: 0,
    execution_control: 0,
    user_experience: 0,
    runtime_invariant: 0,
  };
  const capabilities = new Set<string>();
  for (const { file, value } of tasks) {
    if (value.schemaVersion !== "linggan.benchmark-task/v1") errors.push(`${file}: unsupported schema`);
    if (value.roleTemplate !== config.roleTemplate) errors.push(`${file}: roleTemplate must be ${config.roleTemplate}`);
    if (!value.cases.length) errors.push(`${file}: no benchmark cases`);
    for (const capability of value.requiredCapabilities || []) capabilities.add(capability);
    for (const item of value.cases) {
      if (!item.caseId.startsWith(value.taskId)) errors.push(`${file}: case ${item.caseId} is not bound to ${value.taskId}`);
      if (!item.prompt.trim()) errors.push(`${file}: case ${item.caseId} has no prompt`);
      if (!item.assertions.length) errors.push(`${file}: case ${item.caseId} has no assertions`);
      for (const capability of item.requiredCapabilities || []) capabilities.add(capability);
      for (const assertion of item.assertions) {
        const category = classifyBenchmarkAssertion(assertion);
        if (!category) errors.push(`${file}: assertion ${assertion} has no proof category`);
        else assertionCategories[category] += 1;
      }
    }
  }

  const capabilityEvidence = Array.from(capabilities).sort().map((capabilityId) => {
    const proof = config.capabilityProofs[capabilityId];
    if (!proof) {
      errors.push(`Capability ${capabilityId} has no implementation proof`);
      return { capabilityId, owner: "unknown", implementation: null, test: null, additionalEvidence: [], status: "FAIL" };
    }
    for (const evidencePath of [proof.implementation, proof.test, ...(proof.additionalEvidence || [])]) {
      if (!existsSync(path.join(root, evidencePath))) errors.push(`Capability ${capabilityId} proof is missing: ${evidencePath}`);
    }
    return { capabilityId, ...proof, status: "PASS" };
  });

  const knowledgeManifestPath = path.join(packRoot, "knowledge", "manifest.json");
  const knowledgeManifest = readJson<{ rolePackId: string; roleTemplate: string; assets: Array<{ assetId: string; file: string; taskIds: string[] }> }>(knowledgeManifestPath);
  if (knowledgeManifest.roleTemplate !== config.roleTemplate) errors.push(`Knowledge manifest roleTemplate must be ${config.roleTemplate}`);
  for (const taskId of expectedTaskIds) {
    if (!knowledgeManifest.assets.some((asset) => asset.taskIds.includes(taskId))) errors.push(`Knowledge manifest does not cover ${taskId}`);
  }
  for (const asset of knowledgeManifest.assets) {
    const candidate = path.join(root, config.knowledgeSourceDirectory, asset.file);
    if (!existsSync(candidate)) errors.push(`Knowledge asset file is missing: ${asset.file}`);
  }

  const fingerprintInputs = [
    ...tasks.map((task) => path.join(evalRoot, task.file)),
    knowledgeManifestPath,
    ...config.skillManifests.map((file) => path.join(packRoot, file)),
    ...Array.from(new Set(capabilityEvidence.flatMap((item) => [
      item.implementation,
      item.test,
      ...(item.additionalEvidence || []),
    ]).filter(Boolean) as string[])).map((file) => path.join(root, file)),
  ].sort();
  for (const file of fingerprintInputs) {
    if (!existsSync(file)) errors.push(`Release asset is missing: ${path.relative(root, file)}`);
  }
  const existingInputs = fingerprintInputs.filter(existsSync);
  const assetSetFingerprint = sha256(existingInputs.map((file) => `${path.relative(root, file)}:${sha256(readFileSync(file))}`).join("\n"));

  return {
    schema: "ea.reference-role-pack-contract-report.v1",
    status: errors.length ? "FAIL" : "PASS",
    executionLevel: "contract",
    scenarioExecution: false,
    rolePackId: knowledgeManifest.rolePackId,
    roleTemplate: config.roleTemplate,
    evalSuiteVersion: config.evalSuiteVersion,
    releaseCandidateId: `${knowledgeManifest.rolePackId}@${assetSetFingerprint.slice(0, 16)}:${config.evalSuiteVersion}`,
    assetSetFingerprint,
    taskCount: tasks.length,
    caseCount: tasks.reduce((total, task) => total + task.value.cases.length, 0),
    assertionCount: Object.values(assertionCategories).reduce((total, count) => total + count, 0),
    assertionCategories,
    capabilityEvidence,
    errors,
  };
}

export function runWealthRolePackContractChecks(root = process.cwd()) {
  return runReferenceRolePackContractChecks(root, referenceRolePack("wealth-manager")!);
}

export function runInsuranceRolePackContractChecks(root = process.cwd()) {
  return runReferenceRolePackContractChecks(root, referenceRolePack("insurance-advisor")!);
}

export function runPostLoanRiskRolePackContractChecks(root = process.cwd()) {
  return runReferenceRolePackContractChecks(root, referenceRolePack("post-loan-risk-control")!);
}

export function runSmartAuditRolePackContractChecks(root = process.cwd()) {
  return runReferenceRolePackContractChecks(root, referenceRolePack("smart-audit")!);
}

export function runInvestmentResearchRolePackContractChecks(root = process.cwd()) {
  return runReferenceRolePackContractChecks(root, referenceRolePack("investment-research")!);
}
