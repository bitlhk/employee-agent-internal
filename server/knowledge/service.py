#!/usr/bin/env python3
"""Local-only LlamaIndex retrieval service for EA knowledge bases."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from typing import Any, Literal
from urllib import request as urllib_request

from fastapi import FastAPI, Header, HTTPException
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from llama_index.core import StorageContext, VectorStoreIndex, load_index_from_storage
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import Document, NodeWithScore, QueryBundle, TextNode
from llama_index.retrievers.bm25 import BM25Retriever
from parsing import ParsedSegment, clean_text, read_segments


APP_ROOT = Path(os.environ.get("APP_ROOT") or Path(__file__).resolve().parents[2]).resolve()
load_dotenv(APP_ROOT / ".env", override=False)
DATA_ROOT = (APP_ROOT / "data" / "knowledge").resolve()
INDEX_ROOT = DATA_ROOT / "indexes"
TOKEN_PATH = Path(os.environ.get("KNOWLEDGE_SERVICE_TOKEN_FILE") or DATA_ROOT / ".service-token")
MAX_TOTAL_CHARS = int(os.environ.get("KNOWLEDGE_MAX_TOTAL_CHARS", "8000000"))
MAX_NODES = int(os.environ.get("KNOWLEDGE_MAX_NODES", "12000"))
KB_ID_RE = re.compile(r"^kb_[A-Za-z0-9_-]{8,56}$")
DOCUMENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
LOCATOR_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{3,128}$")
INDEX_SCHEMA_VERSION = 2
PARSER_VERSION = "2.1"
PARENT_CHUNK_SIZE = int(os.environ.get("KNOWLEDGE_PARENT_CHUNK_SIZE", "1400"))
PARENT_CHUNK_OVERLAP = int(os.environ.get("KNOWLEDGE_PARENT_CHUNK_OVERLAP", "120"))
CHILD_CHUNK_SIZE = int(os.environ.get("KNOWLEDGE_CHILD_CHUNK_SIZE", "420"))
CHILD_CHUNK_OVERLAP = int(os.environ.get("KNOWLEDGE_CHILD_CHUNK_OVERLAP", "60"))
INDEX_VERSIONS_TO_KEEP = max(2, min(int(os.environ.get("KNOWLEDGE_INDEX_VERSIONS_TO_KEEP", "2")), 5))
QUERY_CACHE_TTL_SECONDS = max(0, min(int(os.environ.get("KNOWLEDGE_QUERY_CACHE_TTL_SECONDS", "60")), 600))

app = FastAPI(title="EA Knowledge Service", docs_url=None, redoc_url=None)
_locks: dict[str, asyncio.Lock] = {}


class SourceDocument(BaseModel):
    id: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=240)
    path: str = Field(min_length=1, max_length=1200)
    sha256: str = Field(default="", max_length=64)
    version_label: str = Field(default="1.0", max_length=64)
    lifecycle: Literal["draft", "active", "expired", "archived"] = "active"
    source_department: str = Field(default="", max_length=120)
    classification: Literal["public", "internal", "sensitive", "restricted"] = "internal"
    authority: Literal["official", "approved", "reference", "personal"] = "reference"
    effective_at: str | None = None
    expires_at: str | None = None
    external_processing_allowed: bool = True


class IndexRequest(BaseModel):
    knowledge_base_id: str
    documents: list[SourceDocument] = Field(default_factory=list, max_length=2000)


class SearchRequest(BaseModel):
    knowledge_base_id: str
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=6, ge=1, le=20)


class MultiSearchRequest(BaseModel):
    knowledge_base_ids: list[str] = Field(min_length=1, max_length=8)
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=4, ge=1, le=12)
    mode: Literal["auto", "forced"] = "auto"


class CitationRequest(BaseModel):
    knowledge_base_id: str
    document_id: str = Field(min_length=3, max_length=64)
    chunk_id: str = Field(min_length=3, max_length=128)
    parent_id: str = Field(min_length=3, max_length=128)


class IndexStatusRequest(BaseModel):
    knowledge_base_ids: list[str] = Field(min_length=1, max_length=1000)


def _token() -> str:
    try:
        return TOKEN_PATH.read_text("utf-8").strip()
    except OSError:
        return ""


def _authorize(value: str | None) -> None:
    expected = _token()
    if not expected or not value or value != expected:
        raise HTTPException(status_code=401, detail="unauthorized")


def _kb_id(value: str) -> str:
    if not KB_ID_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="invalid knowledge base id")
    return value


def _safe_source_path(value: str) -> Path:
    source = Path(value).resolve(strict=True)
    documents_root = (DATA_ROOT / "documents").resolve()
    if source != documents_root and documents_root not in source.parents:
        raise ValueError("document path is outside knowledge storage")
    if not source.is_file():
        raise ValueError("document is not a file")
    return source


def _document_fingerprint(document: SourceDocument) -> str:
    source_hash = document.sha256 or hashlib.sha256(_safe_source_path(document.path).read_bytes()).hexdigest()
    payload = "|".join([
        source_hash,
        PARSER_VERSION,
        str(PARENT_CHUNK_SIZE),
        str(PARENT_CHUNK_OVERLAP),
        str(CHILD_CHUNK_SIZE),
        str(CHILD_CHUNK_OVERLAP),
        document.version_label,
        document.lifecycle,
        document.name,
        document.source_department,
        document.classification,
        document.authority,
        document.effective_at or "",
        document.expires_at or "",
        str(document.external_processing_allowed),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _segment_heading(segment: ParsedSegment) -> str:
    return " > ".join(item for item in segment.heading_path if item)


def _build_document_nodes(document: SourceDocument) -> tuple[list[TextNode], dict[str, dict[str, Any]]]:
    source = _safe_source_path(document.path)
    parent_splitter = SentenceSplitter(chunk_size=PARENT_CHUNK_SIZE, chunk_overlap=PARENT_CHUNK_OVERLAP)
    child_splitter = SentenceSplitter(chunk_size=CHILD_CHUNK_SIZE, chunk_overlap=CHILD_CHUNK_OVERLAP)
    nodes: list[TextNode] = []
    parents: dict[str, dict[str, Any]] = {}
    parent_ordinal = 0
    child_ordinal = 0
    total_chars = 0

    for segment in read_segments(source):
        if not segment.text:
            continue
        total_chars += len(segment.text)
        if total_chars > MAX_TOTAL_CHARS:
            raise ValueError("knowledge document text exceeds indexing limit")
        parent_chunks = parent_splitter.get_nodes_from_documents([Document(text=segment.text)], show_progress=False)
        for parent_chunk in parent_chunks:
            parent_text = clean_text(parent_chunk.get_content())
            if not parent_text:
                continue
            parent_ordinal += 1
            parent_id = f"{document.id}:p{parent_ordinal}"
            heading = _segment_heading(segment)
            parent_metadata = {
                "document_id": document.id,
                "document_name": document.name,
                "document_version": document.version_label,
                "position": segment.position,
                "heading_path": list(segment.heading_path),
                "page": segment.page,
                "content_type": segment.content_type,
                "source_department": document.source_department,
                "classification": document.classification,
                "authority": document.authority,
                "effective_at": document.effective_at,
                "expires_at": document.expires_at,
                "external_processing_allowed": document.external_processing_allowed,
                "parent_ordinal": parent_ordinal,
            }
            parents[parent_id] = {"text": parent_text, "metadata": parent_metadata}
            child_chunks = child_splitter.get_nodes_from_documents([Document(text=parent_text)], show_progress=False)
            for child_chunk in child_chunks:
                child_text = clean_text(child_chunk.get_content())
                if not child_text:
                    continue
                child_ordinal += 1
                retrieval_text = f"{heading}\n{child_text}" if heading else child_text
                nodes.append(TextNode(
                    id_=f"{document.id}:c{child_ordinal}",
                    text=retrieval_text,
                    metadata={
                        **parent_metadata,
                        "parent_id": parent_id,
                        "ordinal": child_ordinal,
                    },
                ))
    return nodes, parents


@lru_cache(maxsize=1)
def _embedding_model():
    api_key = os.environ.get("KNOWLEDGE_EMBED_API_KEY", "").strip()
    api_base = os.environ.get("KNOWLEDGE_EMBED_API_BASE", "").strip()
    model = os.environ.get("KNOWLEDGE_EMBED_MODEL", "").strip()
    if not api_key or not api_base or not model:
        return None
    from llama_index.embeddings.openai import OpenAIEmbedding

    batch_size = max(1, min(int(os.environ.get("KNOWLEDGE_EMBED_BATCH_SIZE", "32")), 64))
    return OpenAIEmbedding(
        model_name=model,
        api_key=api_key,
        api_base=api_base,
        embed_batch_size=batch_size,
    )


def _persist_nodes(nodes: list[TextNode], target: Path) -> None:
    payload = [node.to_dict() for node in nodes]
    (target / "nodes.json").write_text(json.dumps(payload, ensure_ascii=False), "utf-8")


def _load_nodes(target: Path) -> list[TextNode]:
    payload = json.loads((target / "nodes.json").read_text("utf-8"))
    return [TextNode.from_dict(item) for item in payload]


def _write_json_atomic(target: Path, payload: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
    temporary.replace(target)


def _knowledge_base_root(knowledge_base_id: str) -> Path:
    return INDEX_ROOT / _kb_id(knowledge_base_id)


def _current_index_target(knowledge_base_id: str) -> Path | None:
    root = _knowledge_base_root(knowledge_base_id)
    pointer = root / "current.json"
    if pointer.is_file():
        try:
            version = str(json.loads(pointer.read_text("utf-8")).get("version") or "")
            target = root / "versions" / version
            if version and target.is_dir() and (target / "manifest.json").is_file():
                return target
        except (OSError, ValueError, json.JSONDecodeError):
            return None
    if (root / "manifest.json").is_file() and (root / "nodes.json").is_file():
        return root
    return None


def _current_index_version(knowledge_base_id: str) -> str:
    target = _current_index_target(knowledge_base_id)
    if target is None:
        return ""
    try:
        manifest = json.loads((target / "manifest.json").read_text("utf-8"))
        return str(manifest.get("index_version") or target.name)
    except (OSError, ValueError, json.JSONDecodeError):
        return target.name


def _index_status(knowledge_base_ids: list[str]) -> dict[str, Any]:
    items = []
    for raw_id in dict.fromkeys(knowledge_base_ids):
        knowledge_base_id = _kb_id(raw_id)
        target = _current_index_target(knowledge_base_id)
        items.append({
            "knowledge_base_id": knowledge_base_id,
            "exists": target is not None,
            "index_version": _current_index_version(knowledge_base_id) if target is not None else "",
        })
    return {"ok": True, "items": items}


def _index_target_for_version(knowledge_base_id: str, version: str) -> Path | None:
    root = _knowledge_base_root(knowledge_base_id)
    version_target = root / "versions" / version
    if version_target.is_dir() and (version_target / "manifest.json").is_file():
        return version_target
    legacy_target = _current_index_target(knowledge_base_id)
    if legacy_target != root:
        return None
    try:
        manifest = json.loads((root / "manifest.json").read_text("utf-8"))
        if str(manifest.get("index_version") or root.name) == version:
            return root
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return None


def _load_parents(target: Path, nodes: list[TextNode]) -> dict[str, dict[str, Any]]:
    parent_path = target / "parents.json"
    if parent_path.is_file():
        payload = json.loads(parent_path.read_text("utf-8"))
        if isinstance(payload, dict):
            return payload
    return {
        str(node.metadata.get("parent_id") or node.node_id): {
            "text": node.get_content(),
            "metadata": dict(node.metadata),
        }
        for node in nodes
    }


def _document_cache_directory(root: Path, document: SourceDocument) -> Path:
    if not DOCUMENT_ID_RE.fullmatch(document.id):
        raise ValueError("invalid knowledge document id")
    return root / "cache" / document.id / _document_fingerprint(document)


def _load_or_build_document_artifact(root: Path, document: SourceDocument) -> tuple[list[TextNode], dict[str, dict[str, Any]], Path]:
    cache = _document_cache_directory(root, document)
    nodes_path = cache / "nodes.json"
    parents_path = cache / "parents.json"
    if nodes_path.is_file() and parents_path.is_file():
        try:
            nodes = [TextNode.from_dict(item) for item in json.loads(nodes_path.read_text("utf-8"))]
            parents = json.loads(parents_path.read_text("utf-8"))
            if isinstance(parents, dict):
                return nodes, parents, cache
        except (OSError, ValueError, json.JSONDecodeError):
            shutil.rmtree(cache, ignore_errors=True)

    nodes, parents = _build_document_nodes(document)
    cache.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(nodes_path, [node.to_dict() for node in nodes])
    _write_json_atomic(parents_path, parents)
    _write_json_atomic(cache / "manifest.json", {
        "parser_version": PARSER_VERSION,
        "fingerprint": _document_fingerprint(document),
        "document_id": document.id,
        "document_sha256": document.sha256,
        "child_count": len(nodes),
        "parent_count": len(parents),
    })
    return nodes, parents, cache


def _attach_cached_embeddings(nodes: list[TextNode], cache: Path, document: SourceDocument) -> bool:
    embed_model = _embedding_model()
    if embed_model is None or not document.external_processing_allowed or not nodes:
        return False
    model_name = os.environ.get("KNOWLEDGE_EMBED_MODEL", "").strip()
    model_identity = "|".join([
        model_name,
        os.environ.get("KNOWLEDGE_EMBED_API_BASE", "").strip().rstrip("/"),
    ])
    cache_key = hashlib.sha256(model_identity.encode("utf-8")).hexdigest()[:16]
    vector_path = cache / f"embeddings-{cache_key}.json"
    embeddings: list[list[float]]
    if vector_path.is_file():
        try:
            payload = json.loads(vector_path.read_text("utf-8"))
            if payload.get("node_ids") != [str(node.node_id) for node in nodes]:
                raise ValueError("embedding cache node mismatch")
            embeddings = payload.get("embeddings") or []
            if len(embeddings) != len(nodes):
                raise ValueError("embedding cache length mismatch")
        except (OSError, ValueError, json.JSONDecodeError, AttributeError):
            vector_path.unlink(missing_ok=True)
            embeddings = []
    else:
        embeddings = []
    if not embeddings:
        embeddings = embed_model.get_text_embedding_batch([node.get_content() for node in nodes], show_progress=False)
        _write_json_atomic(vector_path, {
            "model": model_name,
            "node_ids": [str(node.node_id) for node in nodes],
            "embeddings": embeddings,
        })
    for node, embedding in zip(nodes, embeddings):
        node.embedding = embedding
    return True


def _cleanup_document_cache(root: Path, documents: list[SourceDocument]) -> None:
    cache_root = root / "cache"
    if not cache_root.is_dir():
        return
    expected = {document.id: _document_fingerprint(document) for document in documents}
    for document_dir in cache_root.iterdir():
        if not document_dir.is_dir():
            continue
        expected_fingerprint = expected.get(document_dir.name)
        if not expected_fingerprint:
            shutil.rmtree(document_dir, ignore_errors=True)
            continue
        for fingerprint_dir in document_dir.iterdir():
            if fingerprint_dir.is_dir() and fingerprint_dir.name != expected_fingerprint:
                shutil.rmtree(fingerprint_dir, ignore_errors=True)


def _bm25_text(value: str) -> str:
    import jieba

    return " ".join(token.strip().lower() for token in jieba.cut_for_search(value) if token.strip())


def _build_index(request: IndexRequest) -> dict[str, Any]:
    kb_id = _kb_id(request.knowledge_base_id)
    INDEX_ROOT.mkdir(parents=True, exist_ok=True)
    root = _knowledge_base_root(kb_id)
    active_documents = [document for document in request.documents if document.lifecycle == "active"]
    if not active_documents:
        shutil.rmtree(root, ignore_errors=True)
        _runtime_index.cache_clear()
        _query_cache.clear()
        return {
            "ok": True,
            "chunk_count": 0,
            "document_chunks": {},
            "vector_enabled": False,
            "index_version": "",
            "index_schema_version": INDEX_SCHEMA_VERSION,
            "parser_version": PARSER_VERSION,
            "engine": "local",
        }

    root.mkdir(parents=True, exist_ok=True)
    nodes: list[TextNode] = []
    parents: dict[str, dict[str, Any]] = {}
    counts: dict[str, int] = {}
    vector_nodes: list[TextNode] = []
    for document in active_documents:
        document_nodes, document_parents, cache = _load_or_build_document_artifact(root, document)
        if len(nodes) + len(document_nodes) > MAX_NODES:
            raise ValueError("knowledge base contains too many chunks")
        nodes.extend(document_nodes)
        parents.update(document_parents)
        counts[document.id] = len(document_nodes)
        if _attach_cached_embeddings(document_nodes, cache, document):
            vector_nodes.extend(document_nodes)
    if not nodes:
        raise ValueError("documents contain no extractable text")

    version_seed = "|".join(f"{document.id}:{document.sha256}:{document.version_label}" for document in active_documents)
    version = f"v{int(time.time() * 1000)}-{hashlib.sha256(version_seed.encode('utf-8')).hexdigest()[:8]}"
    versions_root = root / "versions"
    versions_root.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix=f".{version}-", dir=versions_root))
    destination = versions_root / version
    try:
        _persist_nodes(nodes, temp_root)
        _write_json_atomic(temp_root / "parents.json", parents)
        bm25_dir = temp_root / "bm25"
        bm25_dir.mkdir(parents=True, exist_ok=True)
        bm25_nodes = [TextNode(
            id_=node.node_id,
            text=_bm25_text(node.get_content()),
            metadata=node.metadata,
        ) for node in nodes]
        BM25Retriever.from_defaults(
            nodes=bm25_nodes,
            similarity_top_k=min(20, len(nodes)),
            skip_stemming=True,
            token_pattern=r"(?u)\b\w+\b",
        ).persist(str(bm25_dir))

        vector_enabled = False
        embed_model = _embedding_model()
        if embed_model is not None and vector_nodes:
            try:
                import faiss
                from llama_index.vector_stores.faiss import FaissVectorStore

                dimension = len(vector_nodes[0].embedding or [])
                if dimension <= 0:
                    raise ValueError("embedding dimension is unavailable")
                vector_store = FaissVectorStore(faiss_index=faiss.IndexFlatL2(dimension))
                storage_context = StorageContext.from_defaults(vector_store=vector_store)
                index = VectorStoreIndex(vector_nodes, storage_context=storage_context, embed_model=embed_model, show_progress=False)
                vector_dir = temp_root / "vector"
                index.storage_context.persist(persist_dir=str(vector_dir))
                _write_json_atomic(temp_root / "vector.json", {
                    "model": os.environ.get("KNOWLEDGE_EMBED_MODEL", ""),
                    "dimension": dimension,
                    "node_count": len(vector_nodes),
                })
                vector_enabled = True
            except Exception as exc:
                (temp_root / "vector-error.txt").write_text(str(exc)[:2000], "utf-8")

        metadata = {
            "knowledge_base_id": kb_id,
            "document_count": len(active_documents),
            "chunk_count": len(nodes),
            "document_chunks": counts,
            "vector_enabled": vector_enabled,
            "vector_document_count": sum(1 for document in active_documents if document.external_processing_allowed),
            "index_version": version,
            "index_schema_version": INDEX_SCHEMA_VERSION,
            "parser_version": PARSER_VERSION,
            "engine": "local",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_json_atomic(temp_root / "manifest.json", metadata)
        temp_root.rename(destination)
        _write_json_atomic(root / "current.json", {"version": version, "schema_version": INDEX_SCHEMA_VERSION})
        _cleanup_document_cache(root, active_documents)
        versions = sorted(
            [entry for entry in versions_root.iterdir() if entry.is_dir() and not entry.name.startswith(".")],
            key=lambda entry: entry.stat().st_mtime,
            reverse=True,
        )
        for stale in versions[INDEX_VERSIONS_TO_KEEP:]:
            shutil.rmtree(stale, ignore_errors=True)
        _runtime_index.cache_clear()
        _query_cache.clear()
        return {"ok": True, **metadata}
    except Exception:
        shutil.rmtree(temp_root, ignore_errors=True)
        raise


@dataclass
class RuntimeIndex:
    version: str
    target: Path
    nodes: list[TextNode]
    parents: dict[str, dict[str, Any]]
    bm25: BM25Retriever
    vector_index: VectorStoreIndex | None
    external_query_allowed: bool


_query_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}


@lru_cache(maxsize=32)
def _runtime_index(knowledge_base_id: str, version: str) -> RuntimeIndex:
    target = _index_target_for_version(knowledge_base_id, version)
    if target is None:
        raise FileNotFoundError("knowledge index not found")
    nodes = _load_nodes(target)
    bm25 = BM25Retriever.from_persist_dir(str(target / "bm25"))
    bm25.similarity_top_k = min(36, len(nodes))
    try:
        manifest = json.loads((target / "manifest.json").read_text("utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        manifest = {}
    vector_index: VectorStoreIndex | None = None
    embed_model = _embedding_model()
    if embed_model is not None and (target / "vector").is_dir():
        try:
            from llama_index.vector_stores.faiss import FaissVectorStore

            vector_store = FaissVectorStore.from_persist_dir(str(target / "vector"))
            storage_context = StorageContext.from_defaults(persist_dir=str(target / "vector"), vector_store=vector_store)
            vector_index = load_index_from_storage(storage_context, embed_model=embed_model)
        except Exception:
            vector_index = None
    return RuntimeIndex(
        version=version,
        target=target,
        nodes=nodes,
        parents=_load_parents(target, nodes),
        bm25=bm25,
        vector_index=vector_index,
        external_query_allowed=(
            int(manifest.get("vector_document_count", manifest.get("document_count", 0)))
            >= int(manifest.get("document_count", 0))
        ),
    )


def _query_cache_get(key: tuple[Any, ...]) -> dict[str, Any] | None:
    if QUERY_CACHE_TTL_SECONDS <= 0:
        return None
    cached = _query_cache.get(key)
    if not cached:
        return None
    created_at, payload = cached
    if time.monotonic() - created_at > QUERY_CACHE_TTL_SECONDS:
        _query_cache.pop(key, None)
        return None
    return payload


def _query_cache_put(key: tuple[Any, ...], payload: dict[str, Any]) -> None:
    if QUERY_CACHE_TTL_SECONDS <= 0:
        return
    if len(_query_cache) >= 256:
        oldest = min(_query_cache.items(), key=lambda item: item[1][0])[0]
        _query_cache.pop(oldest, None)
    _query_cache[key] = (time.monotonic(), payload)


def _rrf(result_sets: list[list[NodeWithScore]], top_k: int) -> list[tuple[TextNode, float]]:
    scores: dict[str, float] = {}
    nodes: dict[str, TextNode] = {}
    for results in result_sets:
        for rank, result in enumerate(results, start=1):
            node = result.node
            node_id = str(node.node_id)
            scores[node_id] = scores.get(node_id, 0.0) + 1.0 / (60 + rank)
            nodes[node_id] = node
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:top_k]
    return [(nodes[node_id], score) for node_id, score in ordered]


def _rerank_url() -> str:
    base = os.environ.get("KNOWLEDGE_RERANK_API_BASE", "").strip().rstrip("/")
    if not base:
        return ""
    return base if base.endswith("/rerank") else f"{base}/rerank"


def _rerank_candidates(
    query: str,
    candidates: list[tuple[TextNode, float]],
) -> tuple[list[tuple[TextNode, float]], str]:
    url = _rerank_url()
    api_key = os.environ.get("KNOWLEDGE_RERANK_API_KEY", "").strip()
    model = os.environ.get("KNOWLEDGE_RERANK_MODEL", "").strip()
    if not url or not api_key or not model or len(candidates) < 2:
        return candidates, "disabled"
    if any(not bool(node.metadata.get("external_processing_allowed", True)) for node, _ in candidates):
        return candidates, "skipped_policy"
    body = json.dumps({
        "model": model,
        "query": query,
        "documents": [node.get_content()[:4000] for node, _ in candidates],
        "top_n": len(candidates),
    }, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    timeout = max(1.0, min(float(os.environ.get("KNOWLEDGE_RERANK_TIMEOUT_SECONDS", "5")), 30.0))
    try:
        req = urllib_request.Request(url, data=body, headers=headers, method="POST")
        with urllib_request.urlopen(req, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        results = payload.get("results") or payload.get("data") or []
        ordered: list[tuple[TextNode, float]] = []
        seen: set[int] = set()
        for item in results:
            index = int(item.get("index", -1))
            if index < 0 or index >= len(candidates) or index in seen:
                continue
            seen.add(index)
            score = float(item.get("relevance_score", item.get("score", candidates[index][1])))
            ordered.append((candidates[index][0], score))
        ordered.extend(candidate for index, candidate in enumerate(candidates) if index not in seen)
        return ordered, "applied" if ordered else "fallback"
    except Exception:
        return candidates, "fallback"


def _auto_query_candidate(value: str) -> bool:
    compact = re.sub(r"\s+", "", value).lower()
    if not compact or len(compact) < 4:
        return False
    if re.fullmatch(r"(?:你好|您好|嗨|hello|hi|在吗|谢谢|感谢|收到|好的|好|ok|test|测试)[!！。.，,？?]*", compact):
        return False
    if re.fullmatch(r"/(?:new|reset|help|status|tools|model|context|usage|tasks).*", compact):
        return False
    if re.search(r"(?:天气|气温|温度|下雨|降雨|降水|空气质量|台风|几点|现在时间|今天几号|星期几|实时路况)", compact):
        return False
    return True


_AUTO_QUERY_STOPWORDS = frozenset({
    "一个", "一些", "一下", "一份", "一首", "为什么", "为何", "什么", "什么时候",
    "时候", "几点", "哪个", "哪些", "哪里", "多少", "如何", "怎么", "怎样", "是否", "是不是",
    "有没有", "有无", "已经", "还是", "现在", "目前", "这个", "那个", "这些",
    "那些", "请问", "帮我", "给我", "告诉", "告诉我", "关于", "相关", "问题",
    "情况", "内容", "可以", "能够", "需要", "进行", "要求", "规定", "规则",
    "标准", "办法", "流程", "实施", "发布", "计划", "管理", "说明", "介绍",
    "制度", "一下子", "了吗", "的吗",
})
_AUTO_REFERENCE_ONLY_DOCUMENTS = frozenset({
    "sources.md", "references.md", "参考资料.md", "数据来源.md",
})


def _auto_query_terms(value: str) -> tuple[str, ...]:
    import jieba

    candidates: list[str] = []
    seen: set[str] = set()
    for raw in jieba.cut_for_search(value):
        term = re.sub(r"[\W_]+", "", raw.lower(), flags=re.UNICODE)
        if len(term) < 2 or term in _AUTO_QUERY_STOPWORDS or term in seen:
            continue
        seen.add(term)
        candidates.append(term)

    # jieba search mode emits both a compound and its shorter components. Keep
    # the compound so one concept cannot satisfy the gate multiple times.
    ordered = sorted(candidates, key=lambda item: (-len(item), candidates.index(item)))
    selected: list[str] = []
    for term in ordered:
        if any(term != existing and term in existing for existing in selected):
            continue
        selected.append(term)
    return tuple(selected)


def _auto_lexical_evidence(
    query: str,
    candidates: list[NodeWithScore],
    minimum_coverage: float = 0.0,
) -> tuple[tuple[str, ...], int, float, list[NodeWithScore]]:
    terms = _auto_query_terms(query)
    if not terms or not candidates:
        return terms, 0, 0.0, []

    required_matches = 1 if len(terms) == 1 else 2
    best_match_count = 0
    relevant: list[NodeWithScore] = []
    for candidate in candidates:
        metadata = candidate.node.metadata
        searchable = "\n".join([
            str(metadata.get("document_name") or ""),
            " / ".join(map(str, metadata.get("heading_path") or [])),
            str(metadata.get("position") or ""),
            candidate.node.get_content(),
        ]).lower()
        compact = re.sub(r"\s+", "", searchable)
        match_count = sum(1 for term in terms if term in compact)
        best_match_count = max(best_match_count, match_count)
        candidate_coverage = match_count / max(1, len(terms))
        if match_count >= required_matches and candidate_coverage >= minimum_coverage:
            relevant.append(candidate)

    coverage = best_match_count / max(1, len(terms))
    return terms, best_match_count, coverage, relevant


def _auto_source_candidate(node: TextNode) -> bool:
    document_name = str(node.metadata.get("document_name") or "").strip().lower()
    return document_name not in _AUTO_REFERENCE_ONLY_DOCUMENTS


def _auto_trigger_decision(
    *,
    forced: bool,
    bm25_signal: bool,
    vector_signal: bool,
) -> tuple[bool, str]:
    if forced:
        return True, "forced"
    if bm25_signal and vector_signal:
        return True, "bm25+vector"
    if bm25_signal:
        return True, "bm25"
    if vector_signal:
        return False, "vector-rejected"
    return False, "rejected"


def _tag_node(node: TextNode, knowledge_base_id: str) -> TextNode:
    node.metadata = {**node.metadata, "knowledge_base_id": knowledge_base_id}
    return node


def _navigation_only_text(value: str) -> bool:
    text = re.sub(r"\s+", " ", clean_text(value)).strip()
    if not text or len(text) > 260:
        return False
    if re.match(r"^(?:详见|参见|请参阅|请查阅|具体(?:参)?见|见本)", text):
        return True
    if re.search(r"(?:应当|应该|请).{0,30}特别?关注下述(?:各项)?风险因素", text):
        return True
    return bool(re.fullmatch(
        r".{0,40}(?:提醒|提示).{0,80}(?:阅读|参阅|查阅).{0,100}(?:全部)?内容[。.]?",
        text,
    ))


def _query_heading_anchors(query: str) -> tuple[str, ...]:
    compact = re.sub(r"\s+", "", query)
    if "风险因素" in compact:
        return ("风险",)
    if "主营业务" in compact:
        return ("业务", "产品")
    if "竞争地位" in compact:
        return ("竞争", "地位", "市场")
    return ()


def _heading_anchor_mismatch(query: str, metadata: dict[str, Any]) -> bool:
    anchors = _query_heading_anchors(query)
    if not anchors:
        return False
    headings = metadata.get("heading_path") or []
    position = " / ".join([*map(str, headings), str(metadata.get("position") or "")])
    if not position.strip() or position.strip() == "正文":
        return False
    return not any(anchor in position for anchor in anchors)


def _search_indexes(request: MultiSearchRequest) -> dict[str, Any]:
    knowledge_base_ids = list(dict.fromkeys(_kb_id(value) for value in request.knowledge_base_ids))
    targets: list[tuple[str, RuntimeIndex]] = []
    for knowledge_base_id in knowledge_base_ids:
        version = _current_index_version(knowledge_base_id)
        if not version:
            continue
        try:
            runtime = _runtime_index(knowledge_base_id, version)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            continue
        if runtime.nodes:
            targets.append((knowledge_base_id, runtime))
    if not targets:
        return {
            "ok": True,
            "triggered": False,
            "results": [],
            "retrieval": "unavailable",
            "engine": "local",
            "metrics": {"knowledge_base_count": 0, "bm25_max_score": 0, "vector_min_distance": None, "reranker": "disabled", "cache_hit": False},
        }

    bm25_threshold = float(os.environ.get("KNOWLEDGE_AUTO_BM25_MIN_SCORE", "1.2"))
    vector_threshold = float(os.environ.get("KNOWLEDGE_AUTO_VECTOR_MAX_DISTANCE", "0.72"))
    lexical_minimum_coverage = max(0.0, min(
        float(os.environ.get("KNOWLEDGE_AUTO_LEXICAL_MIN_COVERAGE", "0.4")),
        1.0,
    ))
    versions = tuple((knowledge_base_id, runtime.version) for knowledge_base_id, runtime in targets)
    cache_key = (
        versions,
        request.query.strip(),
        request.top_k,
        request.mode,
        _rerank_url(),
        os.environ.get("KNOWLEDGE_RERANK_MODEL", ""),
        bm25_threshold,
        vector_threshold,
        lexical_minimum_coverage,
    )
    cached = _query_cache_get(cache_key)
    if cached is not None:
        return {**cached, "metrics": {**cached.get("metrics", {}), "cache_hit": True}}

    auto_candidate = request.mode == "forced" or _auto_query_candidate(request.query)
    candidate_k = max(request.top_k * 3, request.top_k)
    bm25_candidates: list[NodeWithScore] = []
    bm25_max_score = 0.0
    for knowledge_base_id, runtime in targets:
        nodes_by_id = {str(node.node_id): node for node in runtime.nodes}
        for result in runtime.bm25.retrieve(QueryBundle(_bm25_text(request.query)))[:candidate_k]:
            score = float(result.score or 0)
            original = nodes_by_id.get(str(result.node.node_id))
            if original is None or score <= 0:
                continue
            if request.mode == "auto" and not _auto_source_candidate(original):
                continue
            bm25_max_score = max(bm25_max_score, score)
            bm25_candidates.append(NodeWithScore(node=_tag_node(original, knowledge_base_id), score=score))
    bm25_candidates.sort(key=lambda item: float(item.score or 0), reverse=True)

    vector_candidates: list[NodeWithScore] = []
    vector_min_distance: float | None = None
    embed_model = _embedding_model()
    vector_policy_allowed = all(runtime.external_query_allowed for _, runtime in targets)
    if auto_candidate and vector_policy_allowed and embed_model is not None and any(runtime.vector_index is not None for _, runtime in targets):
        try:
            query_embedding = embed_model.get_query_embedding(request.query)
            query_bundle = QueryBundle(query_str=request.query, embedding=query_embedding)
            for knowledge_base_id, runtime in targets:
                if runtime.vector_index is None:
                    continue
                retriever = runtime.vector_index.as_retriever(similarity_top_k=min(candidate_k, len(runtime.nodes)))
                for result in retriever.retrieve(query_bundle):
                    if request.mode == "auto" and not _auto_source_candidate(result.node):
                        continue
                    distance = float(result.score) if result.score is not None else None
                    if distance is not None:
                        vector_min_distance = distance if vector_min_distance is None else min(vector_min_distance, distance)
                    vector_candidates.append(NodeWithScore(node=_tag_node(result.node, knowledge_base_id), score=result.score))
            vector_candidates.sort(key=lambda item: float(item.score if item.score is not None else 1e9))
        except Exception:
            vector_candidates = []
            vector_min_distance = None

    query_terms, lexical_match_count, lexical_coverage, relevant_bm25_candidates = _auto_lexical_evidence(
        request.query,
        bm25_candidates,
        lexical_minimum_coverage,
    )
    relevant_bm25_max_score = max(
        (float(candidate.score or 0) for candidate in relevant_bm25_candidates),
        default=0.0,
    )
    forced = request.mode == "forced"
    bm25_signal = auto_candidate and relevant_bm25_max_score >= bm25_threshold
    vector_signal = (
        auto_candidate
        and vector_min_distance is not None
        and vector_min_distance <= vector_threshold
    )
    relevant_vector_candidates = [
        candidate for candidate in vector_candidates
        if candidate.score is not None and float(candidate.score) <= vector_threshold
    ]
    triggered, auto_gate = _auto_trigger_decision(
        forced=forced,
        bm25_signal=bm25_signal,
        vector_signal=vector_signal,
    )
    result_sets: list[list[NodeWithScore]] = []
    if forced:
        if bm25_candidates:
            result_sets.append(bm25_candidates)
        if vector_candidates:
            result_sets.append(vector_candidates)
    else:
        if bm25_signal and relevant_bm25_candidates:
            result_sets.append(relevant_bm25_candidates)
        if bm25_signal and vector_signal and relevant_vector_candidates:
            result_sets.append(relevant_vector_candidates)
    if not triggered or not result_sets:
        payload = {
            "ok": True,
            "triggered": False,
            "results": [],
            "retrieval": "hybrid" if vector_candidates else "bm25",
            "engine": "local",
            "metrics": {
                "knowledge_base_count": len(targets),
                "bm25_max_score": round(bm25_max_score, 6),
                "bm25_relevant_max_score": round(relevant_bm25_max_score, 6),
                "vector_min_distance": round(vector_min_distance, 6) if vector_min_distance is not None else None,
                "reranker": "disabled",
                "cache_hit": False,
                "external_query_allowed": vector_policy_allowed,
                "query_term_count": len(query_terms),
                "lexical_match_count": lexical_match_count,
                "lexical_coverage": round(lexical_coverage, 6),
                "auto_gate": auto_gate,
            },
        }
        _query_cache_put(cache_key, payload)
        return payload

    results = []
    document_counts: dict[str, int] = {}
    parent_counts: set[str] = set()
    fused = _rrf(result_sets, request.top_k * 6)
    reranked, reranker_status = _rerank_candidates(request.query, fused)
    runtimes = {knowledge_base_id: runtime for knowledge_base_id, runtime in targets}
    prepared_candidates = []
    for node, score in reranked:
        knowledge_base_id = str(node.metadata.get("knowledge_base_id") or "")
        document_id = str(node.metadata.get("document_id") or "")
        parent_id = str(node.metadata.get("parent_id") or node.node_id)
        runtime = runtimes.get(knowledge_base_id)
        parent = runtime.parents.get(parent_id) if runtime else None
        parent_metadata = dict(parent.get("metadata") or {}) if isinstance(parent, dict) else dict(node.metadata)
        parent_text = str(parent.get("text") or "") if isinstance(parent, dict) else node.get_content()
        prepared_candidates.append((
            _navigation_only_text(parent_text), _heading_anchor_mismatch(request.query, parent_metadata),
            node, score, knowledge_base_id, document_id,
            parent_id, runtime, parent_metadata, parent_text,
        ))
    prepared_candidates.sort(key=lambda item: (item[0], item[1]))
    for _navigation_only, _anchor_mismatch, node, score, knowledge_base_id, document_id, parent_id, runtime, parent_metadata, parent_text in prepared_candidates:
        document_key = f"{knowledge_base_id}:{document_id}"
        parent_key = f"{knowledge_base_id}:{parent_id}"
        if parent_key in parent_counts:
            continue
        if document_counts.get(document_key, 0) >= 2:
            continue
        parent_counts.add(parent_key)
        document_counts[document_key] = document_counts.get(document_key, 0) + 1
        results.append({
            "chunk_id": node.node_id,
            "parent_id": parent_id,
            "score": score,
            "text": parent_text[:4000],
            "matched_text": node.get_content()[:1200],
            "knowledge_base_id": knowledge_base_id,
            "document_id": document_id,
            "document_name": str(node.metadata.get("document_name") or ""),
            "document_version": str(parent_metadata.get("document_version") or "1.0"),
            "position": str(parent_metadata.get("position") or "正文"),
            "heading_path": parent_metadata.get("heading_path") or [],
            "page": parent_metadata.get("page"),
            "content_type": str(parent_metadata.get("content_type") or "text"),
            "source_department": str(parent_metadata.get("source_department") or ""),
            "classification": str(parent_metadata.get("classification") or "internal"),
            "authority": str(parent_metadata.get("authority") or "reference"),
            "ordinal": int(node.metadata.get("ordinal") or 0),
            "engine": "local",
            "index_version": runtime.version if runtime else "",
        })
        if len(results) >= request.top_k:
            break
    payload = {
        "ok": True,
        "triggered": bool(results),
        "results": results,
        "retrieval": "hybrid" if vector_candidates else "bm25",
        "engine": "local",
        "metrics": {
            "knowledge_base_count": len(targets),
            "bm25_max_score": round(bm25_max_score, 6),
            "bm25_relevant_max_score": round(relevant_bm25_max_score, 6),
            "vector_min_distance": round(vector_min_distance, 6) if vector_min_distance is not None else None,
            "reranker": reranker_status,
            "cache_hit": False,
            "external_query_allowed": vector_policy_allowed,
            "query_term_count": len(query_terms),
            "lexical_match_count": lexical_match_count,
            "lexical_coverage": round(lexical_coverage, 6),
            "auto_gate": auto_gate,
        },
    }
    _query_cache_put(cache_key, payload)
    return payload


def _search_index(request: SearchRequest) -> dict[str, Any]:
    payload = _search_indexes(MultiSearchRequest(
        knowledge_base_ids=[request.knowledge_base_id],
        query=request.query,
        top_k=request.top_k,
        mode="forced",
    ))
    if not payload["results"] and _current_index_target(request.knowledge_base_id) is None:
        raise FileNotFoundError("knowledge index not found")
    return payload


def _citation_locator(request: CitationRequest) -> dict[str, Any]:
    knowledge_base_id = _kb_id(request.knowledge_base_id)
    if not DOCUMENT_ID_RE.fullmatch(request.document_id):
        raise ValueError("invalid document id")
    if not LOCATOR_ID_RE.fullmatch(request.chunk_id) or not LOCATOR_ID_RE.fullmatch(request.parent_id):
        raise ValueError("invalid citation locator")
    version = _current_index_version(knowledge_base_id)
    if not version:
        raise FileNotFoundError("knowledge index not found")
    runtime = _runtime_index(knowledge_base_id, version)
    parent = runtime.parents.get(request.parent_id)
    if not isinstance(parent, dict):
        raise FileNotFoundError("citation parent not found")
    metadata = dict(parent.get("metadata") or {})
    if str(metadata.get("document_id") or "") != request.document_id:
        raise FileNotFoundError("citation document mismatch")
    matched = next((node for node in runtime.nodes if str(node.node_id) == request.chunk_id), None)
    if matched is None or str(matched.metadata.get("parent_id") or "") != request.parent_id:
        raise FileNotFoundError("citation chunk not found")
    matched_text = clean_text(matched.get_content())
    heading = " > ".join(map(str, metadata.get("heading_path") or []))
    if heading and matched_text.startswith(heading):
        matched_text = matched_text[len(heading):].lstrip()
    return {
        "ok": True,
        "document_id": request.document_id,
        "parent_id": request.parent_id,
        "chunk_id": request.chunk_id,
        "page": metadata.get("page"),
        "position": str(metadata.get("position") or "正文"),
        "heading_path": metadata.get("heading_path") or [],
        "matched_text": matched_text[:1600],
    }


@app.get("/health")
async def health(x_ea_knowledge_token: str | None = Header(default=None)):
    _authorize(x_ea_knowledge_token)
    return {
        "ok": True,
        "engine": "llamaindex",
        "embedding_configured": _embedding_model() is not None,
        "reranker_configured": bool(_rerank_url() and os.environ.get("KNOWLEDGE_RERANK_API_KEY") and os.environ.get("KNOWLEDGE_RERANK_MODEL")),
        "ocr_available": bool(shutil.which("pdftoppm") and shutil.which("tesseract")),
        "index_schema_version": INDEX_SCHEMA_VERSION,
        "parser_version": PARSER_VERSION,
        "capabilities": [
            "bm25", "vector", "rrf", "parent_child", "metadata", "versioned_index",
            "structured_pdf", "optional_ocr", "optional_rerank",
        ],
    }


@app.post("/index")
async def index(request: IndexRequest, x_ea_knowledge_token: str | None = Header(default=None)):
    _authorize(x_ea_knowledge_token)
    kb_id = _kb_id(request.knowledge_base_id)
    lock = _locks.setdefault(kb_id, asyncio.Lock())
    async with lock:
        try:
            return await asyncio.to_thread(_build_index, request)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)[:1000]) from exc


@app.post("/index-status")
async def index_status(request: IndexStatusRequest, x_ea_knowledge_token: str | None = Header(default=None)):
    _authorize(x_ea_knowledge_token)
    return _index_status(request.knowledge_base_ids)


@app.post("/search")
async def search(request: SearchRequest, x_ea_knowledge_token: str | None = Header(default=None)):
    _authorize(x_ea_knowledge_token)
    try:
        return await asyncio.to_thread(_search_index, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:1000]) from exc


@app.post("/search-multi")
async def search_multi(request: MultiSearchRequest, x_ea_knowledge_token: str | None = Header(default=None)):
    _authorize(x_ea_knowledge_token)
    try:
        return await asyncio.to_thread(_search_indexes, request)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:1000]) from exc


@app.post("/citation")
async def citation(request: CitationRequest, x_ea_knowledge_token: str | None = Header(default=None)):
    _authorize(x_ea_knowledge_token)
    try:
        return await asyncio.to_thread(_citation_locator, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:1000]) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("KNOWLEDGE_SERVICE_PORT", "5191")), access_log=False)
