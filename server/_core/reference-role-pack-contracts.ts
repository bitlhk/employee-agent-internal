import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const WEALTH_EVAL_SUITE_VERSION = "wm-golden-task-v3";

type BenchmarkCase = {
  caseId: string;
  path: "NORMAL" | "DENY" | "DEGRADED" | "CONFIRM";
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

type CapabilityProof = {
  owner: "employee-agent" | "enterprise-mcp";
  implementation: string;
  test: string;
};

const CAPABILITY_PROOFS: Record<string, CapabilityProof> = {
  prepare_wealth_previsit_context: { owner: "employee-agent", implementation: "server/_core/wealth-previsit-tool-handler.ts", test: "server/_core/wealth-previsit-context.test.ts" },
  wealth_assistant_context_probe: { owner: "enterprise-mcp", implementation: "scripts/install-wealth-manager-reference-pack.ts", test: "server/_core/wealth-manager-reference-assets.test.ts" },
  wealth_assistant_customer_detail: { owner: "enterprise-mcp", implementation: "scripts/install-wealth-manager-reference-pack.ts", test: "server/_core/wealth-manager-reference-assets.test.ts" },
  prepare_wealth_allocation_context: { owner: "employee-agent", implementation: "server/_core/wealth-allocation-context.ts", test: "server/_core/wealth-allocation-context.test.ts" },
  get_wealth_policy_basis: { owner: "employee-agent", implementation: "server/_core/wealth-policy-source.ts", test: "server/_core/wealth-policy-source.test.ts" },
  demo_create_portfolio_draft: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
  demo_create_followup_task: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
  prepare_wealth_maturity_context: { owner: "employee-agent", implementation: "server/_core/wealth-maturity-context.ts", test: "server/_core/wealth-maturity-context.test.ts" },
};

export type AssertionCategory = "business_data" | "knowledge_policy" | "execution_control" | "user_experience" | "runtime_invariant";

export function classifyBenchmarkAssertion(assertion: string): AssertionCategory | null {
  if (/(?:customer|product|data_as_of|maturity|facts|source_tools)/u.test(assertion)) return "business_data";
  if (/(?:policy|knowledge|eligibility|expired|historical|validity|document|current_previsit)/u.test(assertion)) return "knowledge_policy";
  if (/(?:executor|approval|idempotency|receipt|record|side_effect|pep|confirmation|write|same_key)/u.test(assertion)) return "execution_control";
  if (/(?:output|title|guidance|recovery|remediation|failure|minimum_input|visible|discloses|next_step|unavailable)/u.test(assertion)) return "user_experience";
  if (/(?:limit|priority|deterministic|retry|bypass|invented|static|scope|owned|authorized|mismatch|restricted|formal|recommendation|candidate|excluded|stopped|channel|risk|at_most_one)/u.test(assertion)) return "runtime_invariant";
  return null;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function runWealthRolePackContractChecks(root = process.cwd()) {
  const packRoot = path.join(root, "examples", "wealth-manager-reference-role-pack");
  const evalRoot = path.join(packRoot, "eval");
  const taskFiles = readdirSync(evalRoot).filter((file) => /^wm-gt-\d{2}-cases\.json$/u.test(file)).sort();
  const tasks = taskFiles.map((file) => ({ file, value: readJson<BenchmarkTask>(path.join(evalRoot, file)) }));
  const errors: string[] = [];
  const expectedTaskIds = Array.from({ length: 6 }, (_, index) => `WM-GT-0${index + 1}`);
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
    if (value.roleTemplate !== "wealth-manager") errors.push(`${file}: roleTemplate must be wealth-manager`);
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
    const proof = CAPABILITY_PROOFS[capabilityId];
    if (!proof) {
      errors.push(`Capability ${capabilityId} has no implementation proof`);
      return { capabilityId, owner: "unknown", implementation: null, test: null, status: "FAIL" };
    }
    for (const evidencePath of [proof.implementation, proof.test]) {
      if (!existsSync(path.join(root, evidencePath))) errors.push(`Capability ${capabilityId} proof is missing: ${evidencePath}`);
    }
    return { capabilityId, ...proof, status: "PASS" };
  });

  const knowledgeManifestPath = path.join(packRoot, "knowledge", "manifest.json");
  const knowledgeManifest = readJson<{ rolePackId: string; roleTemplate: string; assets: Array<{ assetId: string; file: string; taskIds: string[] }> }>(knowledgeManifestPath);
  if (knowledgeManifest.roleTemplate !== "wealth-manager") errors.push("Knowledge manifest roleTemplate must be wealth-manager");
  for (const taskId of expectedTaskIds) {
    if (!knowledgeManifest.assets.some((asset) => asset.taskIds.includes(taskId))) errors.push(`Knowledge manifest does not cover ${taskId}`);
  }
  for (const asset of knowledgeManifest.assets) {
    const candidate = path.join(root, "examples", "financial-enterprise-knowledge-demo", asset.file);
    if (!existsSync(candidate)) errors.push(`Knowledge asset file is missing: ${asset.file}`);
  }

  const fingerprintInputs = [
    ...tasks.map((task) => path.join(evalRoot, task.file)),
    knowledgeManifestPath,
    path.join(packRoot, "skills", "privbank-previsit", "manifest.json"),
    path.join(packRoot, "skills", "wealth-manager-assistant", "manifest.json"),
    ...Array.from(new Set(capabilityEvidence.flatMap((item) => [item.implementation, item.test]).filter(Boolean) as string[])).map((file) => path.join(root, file)),
  ].sort();
  const assetSetFingerprint = sha256(fingerprintInputs.map((file) => `${path.relative(root, file)}:${sha256(readFileSync(file))}`).join("\n"));

  return {
    schema: "ea.reference-role-pack-contract-report.v1",
    status: errors.length ? "FAIL" : "PASS",
    executionLevel: "contract",
    scenarioExecution: false,
    rolePackId: knowledgeManifest.rolePackId,
    evalSuiteVersion: WEALTH_EVAL_SUITE_VERSION,
    releaseCandidateId: `${knowledgeManifest.rolePackId}@${assetSetFingerprint.slice(0, 16)}:${WEALTH_EVAL_SUITE_VERSION}`,
    assetSetFingerprint,
    taskCount: tasks.length,
    caseCount: tasks.reduce((total, task) => total + task.value.cases.length, 0),
    assertionCount: Object.values(assertionCategories).reduce((total, count) => total + count, 0),
    assertionCategories,
    capabilityEvidence,
    errors,
  };
}
