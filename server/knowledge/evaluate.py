#!/usr/bin/env python3
"""Run a repeatable retrieval baseline against one indexed EA knowledge base."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
import time
from urllib import error as urllib_error
from urllib import request as urllib_request


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--knowledge-base-id", required=True, action="append", help="May be repeated or contain comma-separated IDs")
    parser.add_argument("--dataset", default="examples/knowledge-evaluation-baseline.json")
    parser.add_argument("--service-url", default="http://127.0.0.1:5191")
    parser.add_argument("--token-file", default="data/knowledge/.service-token")
    parser.add_argument("--top-k", type=int, default=6)
    parser.add_argument("--mode", choices=("auto", "forced"), default="forced")
    parser.add_argument("--strategy", choices=("hybrid", "bm25", "vector"), default="hybrid")
    parser.add_argument("--rerank", choices=("configured", "disabled"), default="configured")
    parser.add_argument("--case-id", action="append", default=[], help="Evaluate only these case IDs; may be repeated or comma-separated")
    parser.add_argument("--diagnostics", action="store_true", help="Include bounded provider stage traces and evidence coverage")
    parser.add_argument("--eligible-document-id", action="append", default=[], help="May be repeated or contain comma-separated IDs")
    parser.add_argument("--repeat", type=int, default=1, help="Measured requests per case")
    parser.add_argument("--warmup", type=int, default=0, help="Unmeasured warmup requests per case")
    parser.add_argument("--min-hit-rate", type=float, default=0.0)
    parser.add_argument("--min-document-recall", type=float, default=0.0)
    parser.add_argument("--min-page-hit-rate", type=float, default=0.0)
    parser.add_argument("--min-position-hit-rate", type=float, default=0.0)
    parser.add_argument("--min-version-accuracy", type=float, default=0.0)
    parser.add_argument("--min-mrr", type=float, default=0.0)
    parser.add_argument("--max-forbidden-source-rate", type=float, default=None)
    parser.add_argument("--max-p95-ms", type=float, default=0.0)
    parser.add_argument("--max-p99-ms", type=float, default=0.0)
    parser.add_argument("--max-error-rate", type=float, default=None)
    parser.add_argument("--max-empty-result-rate", type=float, default=None)
    parser.add_argument("--output", default="", help="Optional JSON report path")
    parser.add_argument("--markdown-output", default="", help="Optional Markdown report path")
    return parser.parse_args()


def knowledge_base_ids(args: argparse.Namespace) -> list[str]:
    return list(dict.fromkeys(
        item.strip()
        for value in args.knowledge_base_id
        for item in value.split(",")
        if item.strip()
    ))[:8]


def eligible_document_ids(args: argparse.Namespace) -> list[str] | None:
    values = list(dict.fromkeys(
        item.strip()
        for value in args.eligible_document_id
        for item in value.split(",")
        if item.strip()
    ))
    return values or None


def search(args: argparse.Namespace, token: str, query: str) -> tuple[list[dict], float, dict]:
    base_ids = knowledge_base_ids(args)
    eligible_ids = eligible_document_ids(args)
    if len(base_ids) == 1 and eligible_ids is None and not args.diagnostics:
        pathname = "/search"
        payload = {
            "knowledge_base_id": base_ids[0],
            "query": query,
            "top_k": max(1, min(args.top_k, 20)),
        }
    else:
        pathname = "/search-multi"
        payload = {
            "knowledge_base_ids": base_ids,
            "query": query,
            "top_k": max(1, min(args.top_k, 12)),
            "mode": args.mode,
            "retrieval_strategy": args.strategy,
            "rerank": args.rerank,
            "diagnostics": args.diagnostics,
            **({"eligible_document_ids": eligible_ids} if eligible_ids is not None else {}),
        }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib_request.Request(
        f"{args.service_url.rstrip('/')}{pathname}",
        data=body,
        headers={"Content-Type": "application/json", "X-EA-Knowledge-Token": token},
        method="POST",
    )
    started = time.perf_counter()
    with urllib_request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return (
        list(payload.get("results") or []),
        (time.perf_counter() - started) * 1000,
        {
            "triggered": bool(payload.get("triggered")),
            "retrieval": str(payload.get("retrieval") or "unknown"),
            "engine": str(payload.get("engine") or "unknown"),
            "metrics": dict(payload.get("metrics") or {}),
            "diagnostics": dict(payload.get("diagnostics") or {}),
        },
    )


def _fuse_planned_results(result_sets: list[list[dict]], total_limit: int) -> list[dict]:
    if len(result_sets) <= 1:
        return list(result_sets[0][:total_limit]) if result_sets else []
    fused: dict[str, dict] = {}
    for query_index, results in enumerate(result_sets):
        for rank_index, result in enumerate(results):
            key = f"{result.get('knowledge_base_id') or ''}:{result.get('parent_id') or result.get('chunk_id') or ''}"
            rank_score = (1.1 if query_index == 0 else 1.0) / (60 + rank_index + 1)
            current = fused.get(key)
            if current:
                current["score"] += rank_score
                if float(result.get("score") or 0) > float(current["result"].get("score") or 0):
                    current["result"] = result
            else:
                fused[key] = {"result": result, "score": rank_score}
    ordered_keys: list[str] = []
    selected: set[str] = set()
    expanded_keys = [
        [f"{item.get('knowledge_base_id') or ''}:{item.get('parent_id') or item.get('chunk_id') or ''}" for item in results]
        for results in result_sets[1:]
    ]
    for depth in range(2):
        query_order = expanded_keys if depth == 0 else list(reversed(expanded_keys))
        for keys in query_order:
            representative = next((key for key in keys[depth:] if key not in selected), None)
            if representative is None:
                continue
            selected.add(representative)
            ordered_keys.append(representative)
            if len(ordered_keys) >= total_limit:
                break
        if len(ordered_keys) >= total_limit:
            break
    for key, _value in sorted(fused.items(), key=lambda item: item[1]["score"], reverse=True):
        if key in selected:
            continue
        selected.add(key)
        ordered_keys.append(key)
    return [
        {**fused[key]["result"], "score": fused[key]["score"]}
        for key in ordered_keys[:total_limit]
        if key in fused
    ]


def search_case(args: argparse.Namespace, token: str, case: dict) -> tuple[list[dict], float, dict]:
    original = str(case.get("query") or "")
    queries = list(dict.fromkeys(
        str(value).strip() for value in case.get("retrievalQueries") or [original] if str(value).strip()
    ))[:5]
    if len(queries) == 1:
        return search(args, token, queries[0])
    started = time.perf_counter()
    responses: list[tuple[list[dict], float, dict] | None] = [None] * len(queries)
    errors: list[Exception] = []
    with ThreadPoolExecutor(max_workers=len(queries)) as executor:
        futures = {executor.submit(search, args, token, query): index for index, query in enumerate(queries)}
        for future in as_completed(futures):
            try:
                responses[futures[future]] = future.result()
            except Exception as exc:  # Preserve production all-settled behavior.
                errors.append(exc)
    successful = [response for response in responses if response is not None]
    if not successful:
        raise errors[0] if errors else RuntimeError("knowledge retrieval failed")
    result_sets = [response[0] if response is not None else [] for response in responses]
    results = _fuse_planned_results(result_sets, max(1, min(args.top_k, 12)))
    operations = [response[2] for response in successful]
    vector_distances = [
        float(operation.get("metrics", {}).get("vector_min_distance"))
        for operation in operations
        if operation.get("metrics", {}).get("vector_min_distance") is not None
    ]
    final_trace = [
        {
            "rank": rank,
            "score": item.get("score"),
            "knowledgeBaseId": item.get("knowledge_base_id"),
            "documentId": item.get("document_id"),
            "documentName": item.get("document_name"),
            "documentVersion": item.get("document_version"),
            "position": item.get("position"),
            "page": item.get("page"),
            "chunkId": item.get("chunk_id"),
            "parentId": item.get("parent_id"),
        }
        for rank, item in enumerate(results, start=1)
    ]
    return results, (time.perf_counter() - started) * 1000, {
        "triggered": bool(results),
        "retrieval": "+".join(sorted({str(operation.get("retrieval") or "unknown") for operation in operations})) + "+multi_query",
        "engine": "local",
        "metrics": {
            "knowledge_base_count": max((int(operation.get("metrics", {}).get("knowledge_base_count") or 0) for operation in operations), default=0),
            "bm25_max_score": max((float(operation.get("metrics", {}).get("bm25_max_score") or 0) for operation in operations), default=0),
            "vector_min_distance": min(vector_distances) if vector_distances else None,
            "reranker": next((str(operation.get("metrics", {}).get("reranker")) for operation in operations if operation.get("metrics", {}).get("reranker") == "applied"), "disabled"),
            "cache_hit": all(bool(operation.get("metrics", {}).get("cache_hit")) for operation in operations),
            "query_count": len(successful),
            "query_expansion": "applied",
        },
        "diagnostics": {
            "queries": [
                {"query": query, "operation": response[2] if response is not None else {"error": True}}
                for query, response in zip(queries, responses)
            ],
            "stages": {"final": final_trace},
        },
    }
def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * ratio) - 1))
    return ordered[index]


def _evidence_coverage(case: dict, items: list[dict]) -> dict:
    expected_documents = [str(value) for value in case.get("expectedDocuments") or []]
    expected_versions = [str(value) for value in case.get("expectedVersions") or []]
    expected_positions = [str(value).strip().lower() for value in case.get("expectedPositions") or [] if str(value).strip()]
    document_ranks = {
        expected: next((int(item.get("rank") or rank) for rank, item in enumerate(items, start=1)
                        if str(item.get("documentName") or item.get("document_name") or "") == expected), None)
        for expected in expected_documents
    }
    version_ranks = {
        expected: next((int(item.get("rank") or rank) for rank, item in enumerate(items, start=1)
                        if str(item.get("documentVersion") or item.get("document_version") or "") == expected
                        and (not expected_documents or str(item.get("documentName") or item.get("document_name") or "") in expected_documents)), None)
        for expected in expected_versions
    }
    position_ranks = {
        expected: next((int(item.get("rank") or rank) for rank, item in enumerate(items, start=1)
                        if expected in str(item.get("position") or "").lower()), None)
        for expected in expected_positions
    }
    matched_documents = [value for value, rank in document_ranks.items() if rank is not None]
    matched_versions = [value for value, rank in version_ranks.items() if rank is not None]
    matched_positions = [value for value, rank in position_ranks.items() if rank is not None]
    return {
        "documents": {
            "expected": expected_documents,
            "matched": matched_documents,
            "ranks": document_ranks,
            "coverage": round(len(matched_documents) / len(expected_documents), 4) if expected_documents else 1.0,
        },
        "versions": {
            "expected": expected_versions,
            "matched": matched_versions,
            "ranks": version_ranks,
            "coverage": round(len(matched_versions) / len(expected_versions), 4) if expected_versions else 1.0,
        },
        "positions": {
            "expected": expected_positions,
            "matched": matched_positions,
            "ranks": position_ranks,
            "coverage": round(len(matched_positions) / len(expected_positions), 4) if expected_positions else 1.0,
        },
    }


def _case_row(case: dict, results: list[dict], latency_ms: float, operation: dict | None = None) -> dict:
    operation = operation or {}
    actual_documents = [str(result.get("document_name") or "") for result in results]
    actual_versions = [str(result.get("document_version") or "") for result in results]
    actual_pages = [int(result["page"]) for result in results if result.get("page") is not None]
    expected_documents = set(map(str, case.get("expectedDocuments") or []))
    expected_versions = set(map(str, case.get("expectedVersions") or []))
    forbidden_documents = set(map(str, case.get("forbiddenDocuments") or []))
    expected_pages = {int(page) for page in case.get("expectedPages") or []}
    expected_positions = [str(value).strip().lower() for value in case.get("expectedPositions") or [] if str(value).strip()]
    match_mode = str(case.get("matchMode") or "any").lower()

    matched_documents = expected_documents.intersection(actual_documents)
    actual_expected_versions = [
        str(result.get("document_version") or "")
        for result in results
        if not expected_documents or str(result.get("document_name") or "") in expected_documents
    ]
    matched_versions = expected_versions.intersection(actual_expected_versions)
    forbidden_matches = forbidden_documents.intersection(actual_documents)
    matched_pages = expected_pages.intersection(actual_pages)
    actual_positions = [str(result.get("position") or "").lower() for result in results]
    matched_positions = [expected for expected in expected_positions if any(expected in actual for actual in actual_positions)]
    document_hit = not expected_documents or (
        matched_documents == expected_documents if match_mode == "all" else bool(matched_documents)
    )
    version_hit = not expected_versions or (
        matched_versions == expected_versions if match_mode == "all" else bool(matched_versions)
    )
    page_hit = not expected_pages or (
        matched_pages == expected_pages if match_mode == "all" else bool(matched_pages)
    )
    position_hit = not expected_positions or (
        len(matched_positions) == len(expected_positions) if match_mode == "all" else bool(matched_positions)
    )
    expected_rank_targets = expected_documents or set(actual_documents[:1])
    rank = next((index for index, name in enumerate(actual_documents, start=1) if name in expected_rank_targets), 0)
    stage_items = dict(operation.get("diagnostics", {}).get("stages") or {})
    return {
        "id": case.get("id") or case.get("caseId"),
        "query": case.get("query"),
        "tags": list(map(str, case.get("tags") or [])),
        "hit": bool(document_hit and version_hit and page_hit and position_hit and not forbidden_matches),
        "rank": rank or None,
        "latencyMs": round(latency_ms, 1),
        "expectedDocuments": sorted(expected_documents),
        "actualDocuments": actual_documents,
        "forbiddenDocuments": sorted(forbidden_documents),
        "forbiddenMatches": sorted(forbidden_matches),
        "documentRecall": round(len(matched_documents) / len(expected_documents), 4) if expected_documents else 1.0,
        "expectedVersions": sorted(expected_versions),
        "actualVersions": actual_versions,
        "versionHit": version_hit,
        "versionRecall": round(len(matched_versions) / len(expected_versions), 4) if expected_versions else None,
        "expectedPages": sorted(expected_pages),
        "actualPages": actual_pages,
        "pageRecall": round(len(matched_pages) / len(expected_pages), 4) if expected_pages else None,
        "expectedPositions": expected_positions,
        "actualPositions": [str(result.get("position") or "") for result in results],
        "positionHit": position_hit,
        "positionRecall": round(len(matched_positions) / len(expected_positions), 4) if expected_positions else None,
        "actualItems": [
            {
                "documentId": str(result.get("document_id") or ""),
                "documentName": str(result.get("document_name") or ""),
                "documentVersion": str(result.get("document_version") or ""),
                "position": str(result.get("position") or ""),
                "page": result.get("page"),
                "sourceDepartment": str(result.get("source_department") or ""),
                "classification": str(result.get("classification") or ""),
                "authority": str(result.get("authority") or ""),
                "score": result.get("score"),
                "indexVersion": str(result.get("index_version") or ""),
                "chunkId": str(result.get("chunk_id") or ""),
                "parentId": str(result.get("parent_id") or ""),
            }
            for result in results
        ],
        "operation": operation,
        "stageCoverage": {
            stage: _evidence_coverage(case, list(items or []))
            for stage, items in stage_items.items()
        },
    }


def build_summary(
    dataset: dict,
    base_ids: list[str],
    evaluated: list[tuple],
    operational_samples: list[dict] | None = None,
    eligible_ids: list[str] | None = None,
) -> dict:
    rows = [
        _case_row(item[0], item[1], item[2], item[3] if len(item) > 3 else None)
        for item in evaluated
    ]
    samples = operational_samples or [
        {
            "latencyMs": item[2],
            "empty": not item[1],
            "errorCode": None,
            "operation": item[3] if len(item) > 3 else {},
        }
        for item in evaluated
    ]
    latencies = [float(sample.get("latencyMs") or 0) for sample in samples]
    reciprocal_ranks = [1 / row["rank"] if row["rank"] else 0.0 for row in rows]
    page_rows = [row for row in rows if row["expectedPages"]]
    position_rows = [row for row in rows if row["expectedPositions"]]
    version_rows = [row for row in rows if row["expectedVersions"]]
    forbidden_rows = [row for row in rows if row["forbiddenDocuments"]]
    tags: dict[str, dict] = {}
    for tag in sorted({tag for row in rows for tag in row["tags"]}):
        tagged = [row for row in rows if tag in row["tags"]]
        tags[tag] = {
            "cases": len(tagged),
            "hitRate": round(sum(1 for row in tagged if row["hit"]) / len(tagged), 4),
            "latencyP95Ms": round(_percentile([row["latencyMs"] for row in tagged], 0.95), 1),
        }
    return {
        "version": 2,
        "dataset": dataset.get("name"),
        "knowledgeBaseIds": base_ids,
        "cases": len(rows),
        "hitRate": round(sum(1 for row in rows if row["hit"]) / len(rows), 4) if rows else 0.0,
        "pageHitRate": round(sum(1 for row in page_rows if row["pageRecall"] and row["pageRecall"] > 0) / len(page_rows), 4) if page_rows else None,
        "positionHitRate": round(sum(1 for row in position_rows if row["positionHit"]) / len(position_rows), 4) if position_rows else None,
        "versionAccuracy": round(sum(1 for row in version_rows if row["versionHit"]) / len(version_rows), 4) if version_rows else None,
        "forbiddenSourceRate": round(sum(1 for row in forbidden_rows if row["forbiddenMatches"]) / len(forbidden_rows), 4) if forbidden_rows else None,
        "documentRecall": round(statistics.fmean(row["documentRecall"] for row in rows), 4) if rows else 0.0,
        "mrr": round(statistics.fmean(reciprocal_ranks), 4) if reciprocal_ranks else 0.0,
        "latencyP50Ms": round(statistics.median(latencies), 1) if latencies else 0.0,
        "latencyP95Ms": round(_percentile(latencies, 0.95), 1),
        "latencyP99Ms": round(_percentile(latencies, 0.99), 1),
        "sampleCount": len(samples),
        "errorRate": round(sum(1 for sample in samples if sample.get("errorCode")) / len(samples), 4) if samples else 0.0,
        "emptyResultRate": round(sum(1 for sample in samples if sample.get("empty") and not sample.get("errorCode")) / len(samples), 4) if samples else 0.0,
        "errorCounts": {
            code: sum(1 for sample in samples if sample.get("errorCode") == code)
            for code in sorted({str(sample.get("errorCode")) for sample in samples if sample.get("errorCode")})
        },
        "retrievalModes": {
            mode: sum(1 for sample in samples if sample.get("operation", {}).get("retrieval") == mode)
            for mode in sorted({str(sample.get("operation", {}).get("retrieval")) for sample in samples if sample.get("operation", {}).get("retrieval")})
        },
        "rerankerStatuses": {
            status: sum(1 for sample in samples if sample.get("operation", {}).get("metrics", {}).get("reranker") == status)
            for status in sorted({str(sample.get("operation", {}).get("metrics", {}).get("reranker")) for sample in samples if sample.get("operation", {}).get("metrics", {}).get("reranker")})
        },
        "cacheHitRate": round(sum(1 for sample in samples if sample.get("operation", {}).get("metrics", {}).get("cache_hit")) / len(samples), 4) if samples else 0.0,
        "eligibility": {
            "pushdownApplied": eligible_ids is not None,
            "eligibleDocumentCount": len(eligible_ids) if eligible_ids is not None else None,
            "eligibleDocumentIdsFingerprint": hashlib.sha256("\n".join(sorted(eligible_ids or [])).encode("utf-8")).hexdigest() if eligible_ids is not None else None,
            "violations": sorted({
                item["documentId"]
                for row in rows
                for item in row["actualItems"]
                if eligible_ids is not None and item["documentId"] not in set(eligible_ids)
            }),
        },
        "tags": tags,
        "results": rows,
    }


def markdown_report(summary: dict) -> str:
    page_hit = summary.get("pageHitRate")
    version_accuracy = summary.get("versionAccuracy")
    forbidden_source_rate = summary.get("forbiddenSourceRate")
    position_hit_rate = summary.get("positionHitRate")
    lines = [
        f"# {summary.get('dataset') or '知识检索评测'}",
        "",
        "| 指标 | 结果 |",
        "|---|---:|",
        f"| 用例数 | {summary.get('cases', 0)} |",
        f"| 命中率 | {float(summary.get('hitRate') or 0):.1%} |",
        f"| 文档召回率 | {float(summary.get('documentRecall') or 0):.1%} |",
        f"| 页码命中率 | {float(page_hit):.1%} |" if page_hit is not None else "| 页码命中率 | 未设置页码基准 |",
        f"| 章节/位置命中率 | {float(position_hit_rate):.1%} |" if position_hit_rate is not None else "| 章节/位置命中率 | 未设置位置基准 |",
        f"| 版本准确率 | {float(version_accuracy):.1%} |" if version_accuracy is not None else "| 版本准确率 | 未设置版本基准 |",
        f"| 禁止来源率 | {float(forbidden_source_rate):.1%} |" if forbidden_source_rate is not None else "| 禁止来源率 | 未设置禁止来源基准 |",
        f"| MRR | {float(summary.get('mrr') or 0):.4f} |",
        f"| 延迟 P50 | {summary.get('latencyP50Ms', 0)} ms |",
        f"| 延迟 P95 | {summary.get('latencyP95Ms', 0)} ms |",
        f"| 延迟 P99 | {summary.get('latencyP99Ms', 0)} ms |",
        f"| 空结果率 | {float(summary.get('emptyResultRate') or 0):.1%} |",
        f"| 错误率 | {float(summary.get('errorRate') or 0):.1%} |",
        f"| Eligibility 违规 | {len(summary.get('eligibility', {}).get('violations') or [])} |",
        "",
        "## 用例结果",
        "",
        "| 用例 | 命中 | 排名 | 延迟 | 实际文档 / 页码 |",
        "|---|---|---:|---:|---|",
    ]
    for row in summary.get("results") or []:
        actual = "、".join(row.get("actualDocuments") or [])
        forbidden = "、".join(row.get("forbiddenMatches") or [])
        pages = ", ".join(map(str, row.get("actualPages") or []))
        detail = f"{actual}{f' · P{pages}' if pages else ''}{f' · 禁止来源：{forbidden}' if forbidden else ''}"
        lines.append(f"| {row.get('id')} | {'是' if row.get('hit') else '否'} | {row.get('rank') or '-'} | {row.get('latencyMs')} ms | {detail} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    args = arguments()
    dataset = json.loads(Path(args.dataset).read_text("utf-8"))
    token = Path(args.token_file).read_text("utf-8").strip()
    evaluated = []
    operational_samples = []
    cases = [
        case for case in dataset.get("cases") or []
        if not case.get("evaluationLayers") or "retrieval" in case.get("evaluationLayers")
    ]
    selected_case_ids = {
        item.strip()
        for value in args.case_id
        for item in value.split(",")
        if item.strip()
    }
    if selected_case_ids:
        cases = [case for case in cases if str(case.get("caseId") or case.get("id") or "") in selected_case_ids]
    for case in cases:
        query = str(case.get("query") or "")
        for _ in range(max(0, min(args.warmup, 10))):
            try:
                search_case(args, token, case)
            except (OSError, ValueError, TimeoutError, urllib_error.URLError):
                pass
        first = None
        for _ in range(max(1, min(args.repeat, 20))):
            started = time.perf_counter()
            try:
                results, latency_ms, operation = search_case(args, token, case)
                sample = {"latencyMs": latency_ms, "empty": not results, "errorCode": None, "operation": operation}
                if first is None:
                    first = (case, results, latency_ms, operation)
            except urllib_error.HTTPError as exc:
                latency_ms = (time.perf_counter() - started) * 1000
                sample = {"latencyMs": latency_ms, "empty": True, "errorCode": f"HTTP_{exc.code}", "operation": {}}
                if first is None:
                    first = (case, [], latency_ms, {"errorCode": sample["errorCode"]})
            except (OSError, ValueError, TimeoutError, urllib_error.URLError) as exc:
                latency_ms = (time.perf_counter() - started) * 1000
                error_code = type(exc).__name__.upper()
                sample = {"latencyMs": latency_ms, "empty": True, "errorCode": error_code, "operation": {}}
                if first is None:
                    first = (case, [], latency_ms, {"errorCode": error_code})
            operational_samples.append(sample)
        if first is not None:
            evaluated.append(first)
    eligible_ids = eligible_document_ids(args)
    summary = build_summary(dataset, knowledge_base_ids(args), evaluated, operational_samples, eligible_ids)
    rendered = json.dumps(summary, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered + "\n", "utf-8")
    if args.markdown_output:
        destination = Path(args.markdown_output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(markdown_report(summary), "utf-8")
    failed = summary["hitRate"] < args.min_hit_rate
    if args.min_document_recall:
        failed = failed or summary["documentRecall"] < args.min_document_recall
    if args.min_page_hit_rate and summary["pageHitRate"] is not None:
        failed = failed or summary["pageHitRate"] < args.min_page_hit_rate
    if args.min_position_hit_rate and summary["positionHitRate"] is not None:
        failed = failed or summary["positionHitRate"] < args.min_position_hit_rate
    if args.min_version_accuracy and summary["versionAccuracy"] is not None:
        failed = failed or summary["versionAccuracy"] < args.min_version_accuracy
    if args.min_mrr:
        failed = failed or summary["mrr"] < args.min_mrr
    if args.max_forbidden_source_rate is not None and summary["forbiddenSourceRate"] is not None:
        failed = failed or summary["forbiddenSourceRate"] > args.max_forbidden_source_rate
    if args.max_p95_ms:
        failed = failed or summary["latencyP95Ms"] > args.max_p95_ms
    if args.max_p99_ms:
        failed = failed or summary["latencyP99Ms"] > args.max_p99_ms
    if args.max_error_rate is not None:
        failed = failed or summary["errorRate"] > args.max_error_rate
    if args.max_empty_result_rate is not None:
        failed = failed or summary["emptyResultRate"] > args.max_empty_result_rate
    failed = failed or bool(summary.get("eligibility", {}).get("violations"))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
