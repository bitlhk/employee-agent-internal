import {
  createKnowledgeIndexJob,
  getKnowledgeBaseById,
  isKnowledgeDocumentCurrentlyActive,
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

const SERVICE_URL = String(process.env.KNOWLEDGE_SERVICE_URL || "http://127.0.0.1:5191").replace(/\/$/, "");
const SERVICE_TIMEOUT_MS = Math.max(5_000, Number(process.env.KNOWLEDGE_SERVICE_TIMEOUT_MS || 180_000) || 180_000);
type IndexTaskState = { task: Promise<void>; rerun: boolean; pendingJobIds: Array<Promise<number>> };
const indexing = new Map<number, IndexTaskState>();
let recoveryStarted = false;

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
    vectorMinDistance: number | null;
    reranker: string;
    cacheHit: boolean;
    externalQueryAllowed: boolean;
  };
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
      try {
        const latestBase = await getKnowledgeBaseById(base.id) || base;
        await runKnowledgeIndex(latestBase);
        for (const id of jobIds) await setKnowledgeIndexJobState({ id, status: "succeeded", error: null }).catch(() => {});
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
        for (const id of jobIds) await setKnowledgeIndexJobState({ id, status: "failed", error: message }).catch(() => {});
        throw error;
      }
    } while (state.rerun);
  })().finally(() => indexing.delete(base.id));
  return state.task;
}

export function queueKnowledgeIndex(base: KnowledgeBaseRecord, reason = "content_changed"): Promise<void> {
  return queueKnowledgeIndexWithJob(base, persistentJob(base, reason));
}

export function startKnowledgeIndexRecovery(): void {
  if (recoveryStarted) return;
  recoveryStarted = true;
  const recover = async () => {
    await pruneKnowledgeIndexJobs(Number(process.env.KNOWLEDGE_INDEX_JOB_RETENTION_DAYS || 30)).catch(() => {});
    const jobs = await listRecoverableKnowledgeIndexJobs(200);
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
  };
  void recover().catch((error) => console.warn("[KNOWLEDGE] index recovery failed", error));
  const timer = setInterval(() => {
    void recover().catch((error) => console.warn("[KNOWLEDGE] index recovery failed", error));
  }, Math.max(15_000, Number(process.env.KNOWLEDGE_INDEX_RECOVERY_INTERVAL_MS || 60_000)));
  timer.unref?.();
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
  const payload = await serviceRequest("/search", {
    method: "POST",
    body: JSON.stringify({ knowledge_base_id: base.publicId, query, top_k: Math.max(1, Math.min(topK, 20)) }),
  }, 30_000);
  const results = Array.isArray(payload?.results) ? payload.results.map(mapKnowledgeSearchItem) : [];
  return { retrieval: String(payload?.retrieval || "bm25"), results };
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
      metrics: { knowledgeBaseCount: 0, bm25MaxScore: 0, vectorMinDistance: null, reranker: "disabled", cacheHit: false, externalQueryAllowed: false },
    };
  }
  const payload = await serviceRequest("/search-multi", {
    method: "POST",
    body: JSON.stringify({
      knowledge_base_ids: available.map((base) => base.publicId),
      query,
      top_k: Math.max(1, Math.min(totalLimit, 12)),
      mode,
    }),
  }, 30_000);
  const basesById = new Map(available.map((base) => [base.publicId, base]));
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
  return {
    triggered: Boolean(payload?.triggered && results.length),
    retrieval: String(payload?.retrieval || "bm25"),
    results,
    metrics: {
      knowledgeBaseCount: Number(payload?.metrics?.knowledge_base_count || available.length),
      bm25MaxScore: Number(payload?.metrics?.bm25_max_score || 0),
      vectorMinDistance: payload?.metrics?.vector_min_distance == null ? null : Number(payload.metrics.vector_min_distance),
      reranker: String(payload?.metrics?.reranker || "disabled"),
      cacheHit: Boolean(payload?.metrics?.cache_hit),
      externalQueryAllowed: Boolean(payload?.metrics?.external_query_allowed),
    },
  };
}

export function publicKnowledgeDocument(document: KnowledgeDocumentRecord) {
  const { storagePath: _storagePath, sha256: _sha256, ...safe } = document;
  return safe;
}
