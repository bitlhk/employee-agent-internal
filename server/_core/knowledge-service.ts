import {
  listKnowledgeDocuments,
  setKnowledgeBaseIndexState,
  setKnowledgeDocumentState,
  type KnowledgeBaseRecord,
  type KnowledgeDocumentRecord,
} from "../db";
import { knowledgeServiceToken, resolveKnowledgeStoragePath } from "./knowledge-storage";

const SERVICE_URL = String(process.env.KNOWLEDGE_SERVICE_URL || "http://127.0.0.1:5191").replace(/\/$/, "");
const SERVICE_TIMEOUT_MS = Math.max(5_000, Number(process.env.KNOWLEDGE_SERVICE_TIMEOUT_MS || 180_000) || 180_000);
type IndexTaskState = { task: Promise<void>; rerun: boolean };
const indexing = new Map<number, IndexTaskState>();

export type KnowledgeSearchResult = {
  chunkId: string;
  score: number;
  text: string;
  documentId: string;
  documentName: string;
  position: string;
  ordinal: number;
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

export async function getKnowledgeServiceHealth(): Promise<{ ok: boolean; engine: string; embeddingConfigured: boolean; error?: string }> {
  try {
    const payload = await serviceRequest("/health", { method: "GET" }, 3_000);
    return { ok: Boolean(payload?.ok), engine: String(payload?.engine || "llamaindex"), embeddingConfigured: Boolean(payload?.embedding_configured) };
  } catch (error) {
    return { ok: false, engine: "llamaindex", embeddingConfigured: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runKnowledgeIndex(base: KnowledgeBaseRecord): Promise<void> {
  const documents = await listKnowledgeDocuments(base.id);
  await setKnowledgeBaseIndexState({ id: base.id, status: documents.length ? "indexing" : "empty", error: null });
  for (const document of documents) await setKnowledgeDocumentState({ id: document.id, status: "indexing", error: null });
  if (!documents.length) return;
  try {
    const serviceDocuments = documents.map((document) => {
      const absolute = resolveKnowledgeStoragePath(document.storagePath);
      if (!absolute) throw new Error(`知识文档不存在：${document.name}`);
      return { id: document.publicId, name: document.name, path: absolute };
    });
    const payload = await serviceRequest("/index", {
      method: "POST",
      body: JSON.stringify({ knowledge_base_id: base.publicId, documents: serviceDocuments }),
    });
    const counts = payload?.document_chunks && typeof payload.document_chunks === "object" ? payload.document_chunks : {};
    for (const document of documents) {
      await setKnowledgeDocumentState({ id: document.id, status: "ready", chunkCount: Number(counts[document.publicId] || 0), error: null });
    }
    await setKnowledgeBaseIndexState({ id: base.id, status: "ready", chunkCount: Number(payload?.chunk_count || 0), error: null });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
    for (const document of documents) await setKnowledgeDocumentState({ id: document.id, status: "failed", error: message });
    await setKnowledgeBaseIndexState({ id: base.id, status: "failed", error: message });
    throw error;
  }
}

export function queueKnowledgeIndex(base: KnowledgeBaseRecord): Promise<void> {
  const existing = indexing.get(base.id);
  if (existing) {
    existing.rerun = true;
    return existing.task;
  }
  const state: IndexTaskState = { task: Promise.resolve(), rerun: false };
  state.task = (async () => {
    do {
      state.rerun = false;
      await runKnowledgeIndex(base);
    } while (state.rerun);
  })().finally(() => indexing.delete(base.id));
  indexing.set(base.id, state);
  return state.task;
}

export async function searchKnowledgeBase(base: KnowledgeBaseRecord, query: string, topK = 6): Promise<{ retrieval: string; results: KnowledgeSearchResult[] }> {
  if (base.status !== "ready") return { retrieval: "unavailable", results: [] };
  const payload = await serviceRequest("/search", {
    method: "POST",
    body: JSON.stringify({ knowledge_base_id: base.publicId, query, top_k: Math.max(1, Math.min(topK, 20)) }),
  }, 30_000);
  const results = Array.isArray(payload?.results) ? payload.results.map((item: any) => ({
    chunkId: String(item.chunk_id || ""),
    score: Number(item.score || 0),
    text: String(item.text || ""),
    documentId: String(item.document_id || ""),
    documentName: String(item.document_name || ""),
    position: String(item.position || "正文"),
    ordinal: Number(item.ordinal || 0),
  })) : [];
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
      metrics: { knowledgeBaseCount: 0, bm25MaxScore: 0, vectorMinDistance: null },
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
      chunkId: String(item.chunk_id || ""),
      score: Number(item.score || 0),
      text: String(item.text || ""),
      documentId: String(item.document_id || ""),
      documentName: String(item.document_name || ""),
      position: String(item.position || "正文"),
      ordinal: Number(item.ordinal || 0),
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
    },
  };
}

export function publicKnowledgeDocument(document: KnowledgeDocumentRecord) {
  const { storagePath: _storagePath, sha256: _sha256, ...safe } = document;
  return safe;
}
