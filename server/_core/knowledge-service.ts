import {
  createKnowledgeIndexJob,
  getKnowledgeBaseById,
  isKnowledgeDocumentCurrentlyActive,
  listKnowledgeBasesForIndexRecovery,
  listRecoverableKnowledgeIndexJobs,
  listKnowledgeDocuments,
  pruneKnowledgeIndexJobs,
  setKnowledgeBaseIndexState,
  setKnowledgeDocumentState,
  setKnowledgeIndexJobState,
  type KnowledgeBaseRecord,
  type KnowledgeDocumentRecord,
} from "../db";
import { knowledgeServiceToken, resolveKnowledgeStoragePath } from "./knowledge-storage";
import { planKnowledgeQueries, type KnowledgeQueryPlan } from "./knowledge-query-planner";
import { beginOperationalActivity, observeOperationalActivity } from "./observability/metrics";

const SERVICE_URL = String(process.env.KNOWLEDGE_SERVICE_URL || "http://127.0.0.1:5191").replace(/\/$/, "");
const SERVICE_TIMEOUT_MS = Math.max(5_000, Number(process.env.KNOWLEDGE_SERVICE_TIMEOUT_MS || 180_000) || 180_000);
type IndexTaskState = { task: Promise<void>; rerun: boolean; pendingJobIds: Array<Promise<number>> };
const indexing = new Map<number, IndexTaskState>();
let recoveryStarted = false;
let recoveryEvaluated = false;
let recoveryMissingIndexes = 0;

export type KnowledgeSearchResult = {
  chunkId: string;
  score: number;
  text: string;
  documentId: string;
  documentName: string;
  position: string;
  ordinal: number;
  parentId: string;
  matchedText: string;
  documentVersion: string;
  headingPath: string[];
  page: number | null;
  contentType: string;
  sourceDepartment: string;
  classification: string;
  authority: string;
  engine: string;
  indexVersion: string;
};

export type KnowledgeRetrievalMode = "auto" | "forced";
export type KnowledgeRetrievalResult = {
  triggered: boolean;
  retrieval: string;
  results: Array<KnowledgeSearchResult & { knowledgeBaseId: string; knowledgeBaseName: string }>;
  metrics: {
    knowledgeBaseCount: number;
    bm25MaxScore: number;
    bm25RelevantMaxScore?: number;
    vectorMinDistance: number | null;
    reranker: string;
    cacheHit: boolean;
    externalQueryAllowed: boolean;
    queryCount: number;
    queryExpansion: KnowledgeQueryPlan["expansion"];
    queryTermCount?: number;
    lexicalMatchCount?: number;
    lexicalCoverage?: number;
    autoGate?: string;
  };
};

export type KnowledgeCitationLocator = {
  documentId: string;
  parentId: string;
  chunkId: string;
  page: number | null;
  position: string;
  headingPath: string[];
  matchedText: string;
};

async function serviceRequest(pathname: string, init: RequestInit, timeoutMs = SERVICE_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVICE_URL}${pathname}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-EA-Knowledge-Token": knowledgeServiceToken(),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload?.detail || payload?.error || `knowledge service ${response.status}`));
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getKnowledgeCitationLocator(input: {
  knowledgeBaseId: string;
  documentId: string;
  parentId: string;
  chunkId: string;
}): Promise<KnowledgeCitationLocator> {
  const payload = await serviceRequest("/citation", {
    method: "POST",
    body: JSON.stringify({
      knowledge_base_id: input.knowledgeBaseId,
      document_id: input.documentId,
      parent_id: input.parentId,
      chunk_id: input.chunkId,
    }),
  }, 10_000);
  return {
    documentId: String(payload?.document_id || input.documentId),
    parentId: String(payload?.parent_id || input.parentId),
    chunkId: String(payload?.chunk_id || input.chunkId),
    page: payload?.page == null ? null : Number(payload.page),
    position: String(payload?.position || "正文"),
    headingPath: Array.isArray(payload?.heading_path) ? payload.heading_path.map(String) : [],
    matchedText: String(payload?.matched_text || "").slice(0, 1600),
  };
}

export async function getKnowledgeServiceHealth(): Promise<{
  ok: boolean;
  engine: string;
  embeddingConfigured: boolean;
  rerankerConfigured?: boolean;
  parserVersion?: string;
  indexSchemaVersion?: number;
  capabilities?: string[];
  error?: string;
}> {
  try {
    const payload = await serviceRequest("/health", { method: "GET" }, 3_000);
    return {
      ok: Boolean(payload?.ok),
      engine: String(payload?.engine || "llamaindex"),
      embeddingConfigured: Boolean(payload?.embedding_configured),
      rerankerConfigured: Boolean(payload?.reranker_configured),
      parserVersion: String(payload?.parser_version || ""),
      indexSchemaVersion: Number(payload?.index_schema_version || 1),
      capabilities: Array.isArray(payload?.capabilities) ? payload.capabilities.map(String) : [],
    };
  } catch (error) {
    return { ok: false, engine: "llamaindex", embeddingConfigured: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type KnowledgeIndexStatus = {
  knowledgeBaseId: string;
  exists: boolean;
  indexVersion: string;
};

async function getKnowledgeIndexStatuses(knowledgeBaseIds: string[]): Promise<KnowledgeIndexStatus[]> {
  if (!knowledgeBaseIds.length) return [];
  const payload = await serviceRequest("/index-status", {
    method: "POST",
    body: JSON.stringify({ knowledge_base_ids: knowledgeBaseIds }),
  }, 10_000);
  const items: Array<Record<string, unknown>> = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map((item) => ({
      knowledgeBaseId: String(item?.knowledge_base_id || ""),
      exists: Boolean(item?.exists),
      indexVersion: String(item?.index_version || ""),
    }));
}

export function getKnowledgeIndexRecoveryStatus(): {
  started: boolean;
  evaluated: boolean;
  missingIndexes: number;
} {
  return {
    started: recoveryStarted,
    evaluated: recoveryEvaluated,
    missingIndexes: recoveryMissingIndexes,
  };
}

async function runKnowledgeIndex(base: KnowledgeBaseRecord): Promise<void> {
  const documents = await listKnowledgeDocuments(base.id);
  const indexableDocuments = documents.filter((document) => isKnowledgeDocumentCurrentlyActive(document));
  await setKnowledgeBaseIndexState({
    id: base.id,
    status: documents.length ? (base.indexVersion || base.status === "ready" ? "ready" : "indexing") : "empty",
    error: null,
  });
  for (const document of indexableDocuments) {
    if (document.status !== "ready") await setKnowledgeDocumentState({ id: document.id, status: "indexing", error: null });
  }
  if (!documents.length) return;
  try {
    const serviceDocuments = indexableDocuments.map((document) => {
      const absolute = resolveKnowledgeStoragePath(document.storagePath);
      if (!absolute) throw new Error(`知识文档不存在：${document.name}`);
      const classificationAllowsExternal = document.classification === "public" || document.classification === "internal";
      const baseAllowsExternal = base.classification === "public" || base.classification === "internal";
      return {
        id: document.publicId,
        name: document.name,
        path: absolute,
        sha256: document.sha256,
        version_label: document.versionLabel,
        lifecycle: document.lifecycle,
        source_department: document.sourceDepartment,
        classification: document.classification,
        authority: document.authority,
        effective_at: document.effectiveAt,
        expires_at: document.expiresAt,
        external_processing_allowed: Boolean(
          base.externalProcessingAllowed
          && document.externalProcessingAllowed
          && classificationAllowsExternal
          && baseAllowsExternal
        ),
      };
    });
    const payload = await serviceRequest("/index", {
      method: "POST",
      body: JSON.stringify({ knowledge_base_id: base.publicId, documents: serviceDocuments }),
    });
    const counts = payload?.document_chunks && typeof payload.document_chunks === "object" ? payload.document_chunks : {};
    for (const document of documents) {
      await setKnowledgeDocumentState({
        id: document.id,
        status: "ready",
        chunkCount: Number(counts[document.publicId] || 0),
        error: null,
        parserVersion: String(payload?.parser_version || ""),
        indexVersion: String(payload?.index_version || ""),
      });
    }
    await setKnowledgeBaseIndexState({
      id: base.id,
      status: indexableDocuments.length ? "ready" : "empty",
      chunkCount: Number(payload?.chunk_count || 0),
      error: null,
      indexVersion: String(payload?.index_version || ""),
      indexSchemaVersion: Number(payload?.index_schema_version || 1),
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
    for (const document of indexableDocuments.filter((item) => item.status !== "ready")) {
      await setKnowledgeDocumentState({ id: document.id, status: "failed", error: message });
    }
    await setKnowledgeBaseIndexState({ id: base.id, status: base.indexVersion || base.status === "ready" ? "ready" : "failed", error: message });
    throw error;
  }
}

function persistentJob(base: KnowledgeBaseRecord, reason: string): Promise<number> {
  return createKnowledgeIndexJob(base.id, reason)
    .then((job) => job.id)
    .catch((error) => {
      console.warn("[KNOWLEDGE] durable index job could not be recorded; continuing in-process", error);
      return 0;
    });
}

function queueKnowledgeIndexWithJob(base: KnowledgeBaseRecord, jobId: Promise<number>): Promise<void> {
  const existing = indexing.get(base.id);
  if (existing) {
    existing.rerun = true;
    existing.pendingJobIds.push(jobId);
    return existing.task;
  }
  const state: IndexTaskState = { task: Promise.resolve(), rerun: false, pendingJobIds: [jobId] };
  indexing.set(base.id, state);
  state.task = (async () => {
    do {
      state.rerun = false;
      const jobIds = (await Promise.all(state.pendingJobIds.splice(0))).filter((id) => id > 0);
      for (const id of jobIds) await setKnowledgeIndexJobState({ id, status: "running", error: null }).catch(() => {});
      const indexingStartedAt = Date.now();
      const finishIndexingMetric = beginOperationalActivity("knowledge_index");
      try {
        const latestBase = await getKnowledgeBaseById(base.id) || base;
        await runKnowledgeIndex(latestBase);
        for (const id of jobIds) await setKnowledgeIndexJobState({ id, status: "succeeded", error: null }).catch(() => {});
        observeOperationalActivity({
          activity: "knowledge_index",
          outcome: "success",
          durationMs: Date.now() - indexingStartedAt,
        });
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
        for (const id of jobIds) await setKnowledgeIndexJobState({ id, status: "failed", error: message }).catch(() => {});
        observeOperationalActivity({
          activity: "knowledge_index",
          outcome: "error",
          durationMs: Date.now() - indexingStartedAt,
        });
        throw error;
      } finally {
        finishIndexingMetric();
      }
    } while (state.rerun);
  })().finally(() => indexing.delete(base.id));
  return state.task;
}

export function queueKnowledgeIndex(base: KnowledgeBaseRecord, reason = "content_changed"): Promise<void> {
  return queueKnowledgeIndexWithJob(base, persistentJob(base, reason));
}

export function startKnowledgeIndexRecovery(): () => void {
  if (recoveryStarted) return () => {};
  recoveryStarted = true;
  let running = false;
  let initialRetry: ReturnType<typeof setTimeout> | undefined;
  const recover = async () => {
    await pruneKnowledgeIndexJobs(Number(process.env.KNOWLEDGE_INDEX_JOB_RETENTION_DAYS || 30)).catch(() => {});
    const jobs = await listRecoverableKnowledgeIndexJobs(200);
    const queuedBaseIds = new Set(jobs.map((job) => job.knowledgeBaseId));
    for (const job of jobs) {
      const base = await getKnowledgeBaseById(job.knowledgeBaseId);
      if (!base) {
        await setKnowledgeIndexJobState({ id: job.id, status: "failed", error: "knowledge base no longer exists" }).catch(() => {});
        continue;
      }
      void queueKnowledgeIndexWithJob(base, Promise.resolve(job.id)).catch((error) => {
        console.warn("[KNOWLEDGE] recovered index job failed", { jobId: job.id, knowledgeBaseId: base.id, error });
      });
    }
    const bases = await listKnowledgeBasesForIndexRecovery(1000);
    const statuses = await getKnowledgeIndexStatuses(bases.map((base) => base.publicId));
    const byPublicId = new Map(statuses.map((status) => [status.knowledgeBaseId, status]));
    const missing = bases.filter((base) => !byPublicId.get(base.publicId)?.exists);
    recoveryMissingIndexes = missing.length;
    recoveryEvaluated = true;
    for (const base of missing) {
      if (queuedBaseIds.has(base.id) || indexing.has(base.id)) continue;
      void queueKnowledgeIndex(base, "index_missing_recovery").catch((error) => {
        console.warn("[KNOWLEDGE] missing index rebuild failed", { knowledgeBaseId: base.id, error });
      });
    }
  };
  const runRecover = async () => {
    if (running) return;
    running = true;
    try {
      await recover();
    } catch (error) {
      console.warn("[KNOWLEDGE] index recovery failed", error);
      if (!recoveryEvaluated && !initialRetry) {
        initialRetry = setTimeout(() => {
          initialRetry = undefined;
          void runRecover();
        }, 5_000);
        initialRetry.unref?.();
      }
    } finally {
      running = false;
    }
  };
  void runRecover();
  const timer = setInterval(() => {
    void runRecover();
  }, Math.max(15_000, Number(process.env.KNOWLEDGE_INDEX_RECOVERY_INTERVAL_MS || 60_000)));
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (initialRetry) clearTimeout(initialRetry);
    recoveryStarted = false;
    recoveryEvaluated = false;
    recoveryMissingIndexes = 0;
  };
}

function mapKnowledgeSearchItem(item: any): KnowledgeSearchResult {
  return {
    chunkId: String(item.chunk_id || ""),
    parentId: String(item.parent_id || item.chunk_id || ""),
    score: Number(item.score || 0),
    text: String(item.text || ""),
    matchedText: String(item.matched_text || item.text || ""),
    documentId: String(item.document_id || ""),
    documentName: String(item.document_name || ""),
    documentVersion: String(item.document_version || "1.0"),
    position: String(item.position || "正文"),
    headingPath: Array.isArray(item.heading_path) ? item.heading_path.map(String) : [],
    page: item.page == null ? null : Number(item.page),
    contentType: String(item.content_type || "text"),
    sourceDepartment: String(item.source_department || ""),
    classification: String(item.classification || "internal"),
    authority: String(item.authority || "reference"),
    ordinal: Number(item.ordinal || 0),
    engine: String(item.engine || "local"),
    indexVersion: String(item.index_version || ""),
  };
}

export async function searchKnowledgeBase(base: KnowledgeBaseRecord, query: string, topK = 6): Promise<{ retrieval: string; results: KnowledgeSearchResult[] }> {
  if (base.status !== "ready") return { retrieval: "unavailable", results: [] };
  const startedAt = Date.now();
  const finishMetric = beginOperationalActivity("knowledge_search");
  try {
    const payload = await serviceRequest("/search", {
      method: "POST",
      body: JSON.stringify({ knowledge_base_id: base.publicId, query, top_k: Math.max(1, Math.min(topK, 20)) }),
    }, 30_000);
    const results = Array.isArray(payload?.results) ? payload.results.map(mapKnowledgeSearchItem) : [];
    observeOperationalActivity({
      activity: "knowledge_search",
      outcome: results.length > 0 ? "success" : "empty",
      durationMs: Date.now() - startedAt,
    });
    return { retrieval: String(payload?.retrieval || "bm25"), results };
  } catch (error) {
    observeOperationalActivity({
      activity: "knowledge_search",
      outcome: "error",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    finishMetric();
  }
}

export async function searchAcrossKnowledgeBases(bases: KnowledgeBaseRecord[], query: string, totalLimit = 8): Promise<Array<KnowledgeSearchResult & { knowledgeBaseId: string; knowledgeBaseName: string }>> {
  const retrieval = await retrieveAcrossKnowledgeBases(bases, query, totalLimit, "forced");
  return retrieval.results;
}

export async function retrieveAcrossKnowledgeBases(
  bases: KnowledgeBaseRecord[],
  query: string,
  totalLimit = 4,
  mode: KnowledgeRetrievalMode = "auto",
): Promise<KnowledgeRetrievalResult> {
  const available = bases.filter((base) => base.status === "ready").slice(0, 8);
  if (!available.length) {
    return {
      triggered: false,
      retrieval: "unavailable",
      results: [],
      metrics: {
        knowledgeBaseCount: 0,
        bm25MaxScore: 0,
        bm25RelevantMaxScore: 0,
        vectorMinDistance: null,
        reranker: "disabled",
        cacheHit: false,
        externalQueryAllowed: false,
        queryCount: 0,
        queryExpansion: "skipped",
        queryTermCount: 0,
        lexicalMatchCount: 0,
        lexicalCoverage: 0,
        autoGate: "unavailable",
      },
    };
  }
  const basesById = new Map(available.map((base) => [base.publicId, base]));
  const queryPlan = await planKnowledgeQueries(query);
  const searches = await Promise.allSettled(queryPlan.queries.map(async (plannedQuery, queryIndex) => {
    const payload = await serviceRequest("/search-multi", {
      method: "POST",
      body: JSON.stringify({
        knowledge_base_ids: available.map((base) => base.publicId),
        query: plannedQuery,
        top_k: Math.max(1, Math.min(totalLimit, 12)),
        mode,
      }),
    }, 30_000);
    const results = Array.isArray(payload?.results) ? payload.results.map((item: any) => {
      const knowledgeBaseId = String(item.knowledge_base_id || "");
      const base = basesById.get(knowledgeBaseId);
      if (!base) return null;
      return {
        ...mapKnowledgeSearchItem(item),
        knowledgeBaseId,
        knowledgeBaseName: base.name,
      };
    }).filter(Boolean) as Array<KnowledgeSearchResult & { knowledgeBaseId: string; knowledgeBaseName: string }> : [];
    return { payload, results, queryIndex };
  }));
  const successful = searches.flatMap((search) => search.status === "fulfilled" ? [search.value] : []);
  if (!successful.length) {
    const failure = searches.find((search) => search.status === "rejected");
    throw failure && failure.status === "rejected" ? failure.reason : new Error("knowledge retrieval failed");
  }

  type Result = KnowledgeSearchResult & { knowledgeBaseId: string; knowledgeBaseName: string };
  let results: Result[];
  if (successful.length === 1) {
    results = successful[0].results.slice(0, totalLimit);
  } else {
    const fused = new Map<string, { result: Result; score: number }>();
    successful.forEach(({ results: queryResults, queryIndex }) => {
      queryResults.forEach((result, rankIndex) => {
        const key = `${result.knowledgeBaseId}:${result.parentId || result.chunkId}`;
        const rankScore = (queryIndex === 0 ? 1.1 : 1) / (60 + rankIndex + 1);
        const existing = fused.get(key);
        if (existing) {
          existing.score += rankScore;
          if (result.score > existing.result.score) existing.result = result;
        } else {
          fused.set(key, { result, score: rankScore });
        }
      });
    });
    const orderedKeys: string[] = [];
    const selected = new Set<string>();
    const expandedRankedKeys = successful
      .filter((search) => search.queryIndex > 0)
      .map((search) => search.results.map((result) => `${result.knowledgeBaseId}:${result.parentId || result.chunkId}`));
    for (let depth = 0; depth < 2 && orderedKeys.length < totalLimit; depth += 1) {
      const queryOrder = depth === 0 ? expandedRankedKeys : [...expandedRankedKeys].reverse();
      for (const keys of queryOrder) {
        const representative = keys.slice(depth).find((key) => !selected.has(key));
        if (!representative) continue;
        selected.add(representative);
        orderedKeys.push(representative);
        if (orderedKeys.length >= totalLimit) break;
      }
    }
    for (const [key] of Array.from(fused.entries()).sort((left, right) => right[1].score - left[1].score)) {
      if (selected.has(key)) continue;
      selected.add(key);
      orderedKeys.push(key);
    }
    results = orderedKeys.slice(0, totalLimit).flatMap((key) => {
      const item = fused.get(key);
      return item ? [{ ...item.result, score: item.score }] : [];
    });
  }

  const payloads = successful.map((item) => item.payload);
  const retrievalKinds = Array.from(new Set(payloads.map((payload) => String(payload?.retrieval || "bm25"))));
  const rerankerStatuses = payloads.map((payload) => String(payload?.metrics?.reranker || "disabled"));
  const reranker = ["applied", "fallback", "skipped_policy", "disabled"].find((status) => rerankerStatuses.includes(status)) || "disabled";
  const autoGateStatuses = payloads.map((payload) => String(payload?.metrics?.auto_gate || ""));
  const autoGate = ["forced", "bm25+vector", "bm25", "vector", "rejected"]
    .find((status) => autoGateStatuses.includes(status)) || "unknown";
  const vectorDistances = payloads
    .map((payload) => payload?.metrics?.vector_min_distance)
    .filter((value) => value != null)
    .map(Number)
    .filter(Number.isFinite);
  return {
    triggered: Boolean(results.length && successful.some(({ payload }) => payload?.triggered)),
    retrieval: `${retrievalKinds.join("+")}${successful.length > 1 ? "+multi_query" : ""}`,
    results,
    metrics: {
      knowledgeBaseCount: Math.max(...payloads.map((payload) => Number(payload?.metrics?.knowledge_base_count || 0)), available.length),
      bm25MaxScore: Math.max(0, ...payloads.map((payload) => Number(payload?.metrics?.bm25_max_score || 0))),
      bm25RelevantMaxScore: Math.max(0, ...payloads.map((payload) => Number(payload?.metrics?.bm25_relevant_max_score || 0))),
      vectorMinDistance: vectorDistances.length ? Math.min(...vectorDistances) : null,
      reranker,
      cacheHit: payloads.every((payload) => Boolean(payload?.metrics?.cache_hit)),
      externalQueryAllowed: payloads.every((payload) => Boolean(payload?.metrics?.external_query_allowed)),
      queryCount: successful.length,
      queryExpansion: queryPlan.expansion,
      queryTermCount: Math.max(0, ...payloads.map((payload) => Number(payload?.metrics?.query_term_count || 0))),
      lexicalMatchCount: Math.max(0, ...payloads.map((payload) => Number(payload?.metrics?.lexical_match_count || 0))),
      lexicalCoverage: Math.max(0, ...payloads.map((payload) => Number(payload?.metrics?.lexical_coverage || 0))),
      autoGate,
    },
  };
}

export function publicKnowledgeDocument(document: KnowledgeDocumentRecord) {
  const { storagePath: _storagePath, sha256: _sha256, ...safe } = document;
  return safe;
}
