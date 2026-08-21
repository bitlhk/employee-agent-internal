import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ContextGoldenSetV1 } from "../shared/context-governance";
import type { ProviderCertificationProfileV1 } from "../shared/provider-certification";
import { getKnowledgeBaseByPublicId, listKnowledgeDocuments } from "../server/db";
import { closeDbConnection } from "../server/db/connection";
import { runWealthContextGovernanceContractChecks } from "../server/_core/context-governance-contracts";
import { governanceFingerprint } from "../server/_core/governance/contracts";
import { getKnowledgeServiceHealth } from "../server/_core/knowledge-service";
import { planKnowledgeQueries } from "../server/_core/knowledge-query-planner";
import {
  buildLlamaIndexCertificationGovernance,
  evaluateLlamaIndexContextContract,
  type ReferenceKnowledgeManifestV1,
} from "../server/_core/llamaindex-provider-certification";
import { evaluateProviderCertification } from "../server/_core/provider-certification";

const DEFAULT_PROFILE = "examples/wealth-manager-reference-role-pack/eval/llamaindex-provider-certification.v1.json";
const MANIFEST_PATH = "examples/wealth-manager-reference-role-pack/knowledge/manifest.json";

type RetrievalEvaluationResult = {
  hitRate?: number;
  documentRecall?: number;
  versionAccuracy?: number | null;
  forbiddenSourceRate?: number | null;
  positionHitRate?: number | null;
  mrr?: number;
  latencyP95Ms?: number;
  latencyP99Ms?: number;
  errorRate?: number;
  emptyResultRate?: number;
  eligibility?: { pushdownApplied?: boolean; violations?: unknown[] };
  results?: Array<{
    id: string;
    actualItems: Array<{
      documentId: string;
      documentVersion: string;
      position: string;
      page?: number | null;
      score?: number;
    }>;
  }>;
};

function argument(name: string): string {
  return String(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=", 2)[1] || "").trim();
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.resolve(file), "utf8")) as T;
}

function validateProfile(profile: ProviderCertificationProfileV1): void {
  if (profile.schema !== "ea.provider-certification-profile.v1") throw new Error("Unsupported Provider Certification profile");
  if (profile.providerType !== "llamaindex") throw new Error("This runner certifies only LlamaIndex");
  if (profile.topK < 1 || profile.topK > 12) throw new Error("Certification topK must be between 1 and 12");
  for (const [name, value] of Object.entries(profile.thresholds)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid certification threshold: ${name}`);
  }
}

function runRetrievalEvaluation(input: {
  python: string;
  knowledgeBaseId: string;
  profile: ProviderCertificationProfileV1;
  serviceUrl: string;
  eligibleDocumentIds: string[];
  output: string;
  strategy: "hybrid" | "bm25" | "vector";
  rerank: "configured" | "disabled";
  repeat: number;
  warmup: number;
  datasetPath?: string;
}) {
  execFileSync(input.python, [
    "server/knowledge/evaluate.py",
    "--knowledge-base-id", input.knowledgeBaseId,
    "--dataset", input.datasetPath || input.profile.datasetPath,
    "--service-url", input.serviceUrl,
    "--top-k", String(input.profile.topK),
    "--mode", "forced",
    "--strategy", input.strategy,
    "--rerank", input.rerank,
    "--repeat", String(input.repeat),
    "--warmup", String(input.warmup),
    "--output", input.output,
    ...input.eligibleDocumentIds.flatMap(id => ["--eligible-document-id", id]),
  ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"], maxBuffer: 8 * 1024 * 1024 });
  return readJson<RetrievalEvaluationResult>(input.output);
}

async function main() {
  const knowledgeBaseId = argument("knowledge-base");
  if (!knowledgeBaseId) throw new Error("--knowledge-base=<kb_public_id> is required");
  const profile = readJson<ProviderCertificationProfileV1>(argument("profile") || DEFAULT_PROFILE);
  validateProfile(profile);
  const baseline = runWealthContextGovernanceContractChecks(process.cwd(), { requireExpertConfirmed: true });
  if (baseline.status !== "PASS") throw new Error(`Context Quality Baseline is not frozen: ${baseline.errors.join("; ")}`);

  const base = await getKnowledgeBaseByPublicId(knowledgeBaseId);
  if (!base) throw new Error("Knowledge base is not registered in the current environment");
  if (base.status !== "ready") throw new Error("Knowledge base is not ready");
  const documents = await listKnowledgeDocuments(base.id);
  const manifest = readJson<ReferenceKnowledgeManifestV1>(MANIFEST_PATH);
  const evaluatedAt = new Date();
  const serviceUrl = String(process.env.KNOWLEDGE_SERVICE_URL || "http://127.0.0.1:5191").replace(/\/$/u, "");
  const governance = buildLlamaIndexCertificationGovernance({
    base,
    documents,
    manifest,
    roleTemplate: profile.roleTemplate,
    now: evaluatedAt,
  });
  if (!governance.eligibility.documentIds.length) throw new Error("Certification Eligibility snapshot is empty");

  const health = await getKnowledgeServiceHealth();
  if (!health.ok) throw new Error(`LlamaIndex service is unavailable: ${health.error || "health check failed"}`);
  const goldenSet = readJson<ContextGoldenSetV1>(profile.datasetPath);
  const retrievalQueryPlans = await Promise.all(goldenSet.cases.map(async (item) => ({
    caseId: item.caseId,
    ...(await planKnowledgeQueries(item.query, { deterministicOnly: true })),
  })));
  const providerConfig = {
    providerType: profile.providerType,
    indexVersion: base.indexVersion || "",
    indexSchemaVersion: base.indexSchemaVersion,
    parserVersion: health.parserVersion || "unknown",
    embeddingModel: health.embeddingModel || "unknown",
    rerankerModel: health.rerankerModel || "unknown",
    chunking: health.chunking || null,
    capabilities: health.capabilities || [],
    retrievalMode: "forced",
    topK: profile.topK,
    queryPlanner: {
      mode: "deterministic-only",
      fingerprint: governanceFingerprint(retrievalQueryPlans),
    },
    eligibilityFingerprint: governance.eligibility.fingerprint,
    eligibleDocumentIdsFingerprint: governanceFingerprint(governance.eligibility.documentIds),
  };

  const work = mkdtempSync(path.join(tmpdir(), "grace-llamaindex-cert-"));
  const evaluationPath = path.join(work, "retrieval.json");
  try {
    const python = process.env.KNOWLEDGE_PYTHON || path.join(homedir(), ".venvs/employee-agent-knowledge/bin/python");
    const plannedDatasetPath = path.join(work, "planned-dataset.json");
    const queryPlanByCase = new Map(retrievalQueryPlans.map(item => [item.caseId, item]));
    writeFileSync(plannedDatasetPath, `${JSON.stringify({
      ...goldenSet,
      cases: goldenSet.cases.map(item => ({
        ...item,
        retrievalQueries: queryPlanByCase.get(item.caseId)?.queries || [item.query],
      })),
    }, null, 2)}\n`, "utf8");
    const retrieval = runRetrievalEvaluation({
      python,
      knowledgeBaseId,
      profile,
      serviceUrl,
      eligibleDocumentIds: governance.eligibility.documentIds,
      output: evaluationPath,
      strategy: "hybrid",
      rerank: "configured",
      repeat: profile.repeat,
      warmup: profile.warmup,
      datasetPath: plannedDatasetPath,
    });
    const supportsStrategy = health.capabilities?.includes("retrieval_strategy") || false;
    const supportsRerankToggle = health.capabilities?.includes("rerank_toggle") || false;
    const variantRuns: Record<string, RetrievalEvaluationResult> = {};
    if (supportsStrategy) {
      for (const strategy of ["bm25", "vector"] as const) {
        variantRuns[strategy] = runRetrievalEvaluation({
          python,
          knowledgeBaseId,
          profile,
          serviceUrl,
          eligibleDocumentIds: governance.eligibility.documentIds,
          output: path.join(work, `${strategy}.json`),
          strategy,
          rerank: "disabled",
          repeat: 1,
          warmup: 0,
          datasetPath: plannedDatasetPath,
        });
      }
    }
    if (supportsRerankToggle) {
      variantRuns.hybridWithoutRerank = runRetrievalEvaluation({
        python,
        knowledgeBaseId,
        profile,
        serviceUrl,
        eligibleDocumentIds: governance.eligibility.documentIds,
        output: path.join(work, "hybrid-no-rerank.json"),
        strategy: "hybrid",
        rerank: "disabled",
        repeat: 1,
        warmup: 0,
        datasetPath: plannedDatasetPath,
      });
    }
    const contextContract = evaluateLlamaIndexContextContract({
      goldenSet,
      evaluationResults: retrieval.results || [],
      documents: governance.benchmarkDocuments,
      knowledgeBaseId,
      asOf: evaluatedAt.toISOString(),
    });
    const certification = evaluateProviderCertification({
      profile,
      evaluatedAt: evaluatedAt.toISOString(),
      evidence: {
        baselineFingerprint: baseline.contractFingerprint,
        expertConfirmed: baseline.reviewStatus.expertConfirmed === baseline.caseCount,
        providerConfigFingerprint: governanceFingerprint(providerConfig),
        resourceRefFingerprint: governanceFingerprint(`kb://${knowledgeBaseId}`),
        indexVersion: base.indexVersion || "unknown",
        parserVersion: health.parserVersion || "unknown",
        retrieval: {
          hitRate: Number(retrieval.hitRate || 0),
          documentRecall: Number(retrieval.documentRecall || 0),
          versionAccuracy: retrieval.versionAccuracy == null ? null : Number(retrieval.versionAccuracy),
          forbiddenSourceRate: retrieval.forbiddenSourceRate == null ? null : Number(retrieval.forbiddenSourceRate),
          positionHitRate: retrieval.positionHitRate == null ? null : Number(retrieval.positionHitRate),
          mrr: Number(retrieval.mrr || 0),
          latencyP95Ms: Number(retrieval.latencyP95Ms || 0),
          latencyP99Ms: Number(retrieval.latencyP99Ms || 0),
          errorRate: Number(retrieval.errorRate || 0),
          emptyResultRate: Number(retrieval.emptyResultRate || 0),
          eligibility: {
            pushdownApplied: Boolean(retrieval.eligibility?.pushdownApplied),
            violations: Array.isArray(retrieval.eligibility?.violations) ? retrieval.eligibility.violations.map(String) : [],
          },
        },
        governance: {
          passed: governance.passed,
          scenarioCount: governance.scenarios.length,
          failedScenarios: governance.failedScenarios,
        },
        contextContract: {
          completeness: contextContract.completeness,
          normalizedItemCount: contextContract.normalizedItemCount,
          invalidItemCount: contextContract.invalidItemCount,
          evidenceStagesSeparated: contextContract.evidenceStagesSeparated,
        },
      },
    });
    const result = {
      schema: "ea.llamaindex-provider-certification-run.v1",
      certification,
      providerSnapshot: providerConfig,
      governance: {
        scenarios: governance.scenarios,
        excludedByReason: governance.eligibility.excludedByReason,
      },
      contextContract,
      retrievalEvaluation: retrieval,
      operationalVariants: {
        coverage: {
          hybrid: true,
          bm25Only: supportsStrategy,
          vectorOnly: supportsStrategy,
          rerankToggle: supportsRerankToggle,
          coldStart: false,
        },
        note: "Measured requests are warm-cache samples after per-case warmup. Cold process startup is not claimed by this certification run.",
        results: Object.fromEntries(Object.entries(variantRuns).map(([name, value]) => [name, {
          hitRate: value.hitRate,
          documentRecall: value.documentRecall,
          versionAccuracy: value.versionAccuracy,
          forbiddenSourceRate: value.forbiddenSourceRate,
          positionHitRate: value.positionHitRate,
          mrr: value.mrr,
          latencyP95Ms: value.latencyP95Ms,
          errorRate: value.errorRate,
        }])),
      },
    };
    const output = argument("output");
    if (output) {
      const resolved = path.resolve(output);
      mkdirSync(path.dirname(resolved), { recursive: true });
      writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    // Keep stdout concise; the full result is available through --output.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      status: certification.status,
      certificationId: certification.certificationId,
      baselineFingerprint: certification.contextQualityBaselineFingerprint,
      certificationProfileFingerprint: certification.certificationProfileFingerprint,
      providerConfigFingerprint: certification.providerConfigFingerprint,
      certificationFingerprint: certification.certificationFingerprint,
      failureCodes: certification.failureCodes,
      metrics: {
        hitRate: retrieval.hitRate,
        documentRecall: retrieval.documentRecall,
        versionAccuracy: retrieval.versionAccuracy,
        forbiddenSourceRate: retrieval.forbiddenSourceRate,
        positionHitRate: retrieval.positionHitRate,
        mrr: retrieval.mrr,
        latencyP95Ms: retrieval.latencyP95Ms,
        latencyP99Ms: retrieval.latencyP99Ms,
        errorRate: retrieval.errorRate,
        emptyResultRate: retrieval.emptyResultRate,
        eligibilityViolations: retrieval.eligibility?.violations?.length || 0,
        contextItemCompleteness: contextContract.completeness,
      },
    }, null, 2));
    if (certification.status !== "certified") process.exitCode = 2;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await closeDbConnection().catch(() => undefined);
});
