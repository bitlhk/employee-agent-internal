#!/usr/bin/env python3
"""Run a repeatable retrieval baseline against one indexed EA knowledge base."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import statistics
import sys
import time
from urllib import request as urllib_request


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--knowledge-base-id", required=True, action="append", help="May be repeated or contain comma-separated IDs")
    parser.add_argument("--dataset", default="examples/knowledge-evaluation-baseline.json")
    parser.add_argument("--service-url", default="http://127.0.0.1:5191")
    parser.add_argument("--token-file", default="data/knowledge/.service-token")
    parser.add_argument("--top-k", type=int, default=6)
    parser.add_argument("--min-hit-rate", type=float, default=0.0)
    parser.add_argument("--min-page-hit-rate", type=float, default=0.0)
    parser.add_argument("--max-p95-ms", type=float, default=0.0)
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


def search(args: argparse.Namespace, token: str, query: str) -> tuple[list[dict], float]:
    base_ids = knowledge_base_ids(args)
    if len(base_ids) == 1:
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
            "mode": "forced",
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
    return list(payload.get("results") or []), (time.perf_counter() - started) * 1000


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * ratio) - 1))
    return ordered[index]


def _case_row(case: dict, results: list[dict], latency_ms: float) -> dict:
    actual_documents = [str(result.get("document_name") or "") for result in results]
    actual_pages = [int(result["page"]) for result in results if result.get("page") is not None]
    expected_documents = set(map(str, case.get("expectedDocuments") or []))
    expected_pages = {int(page) for page in case.get("expectedPages") or []}
    expected_positions = [str(value).strip().lower() for value in case.get("expectedPositions") or [] if str(value).strip()]
    match_mode = str(case.get("matchMode") or "any").lower()

    matched_documents = expected_documents.intersection(actual_documents)
    matched_pages = expected_pages.intersection(actual_pages)
    actual_positions = [str(result.get("position") or "").lower() for result in results]
    matched_positions = [expected for expected in expected_positions if any(expected in actual for actual in actual_positions)]
    document_hit = not expected_documents or (
        matched_documents == expected_documents if match_mode == "all" else bool(matched_documents)
    )
    page_hit = not expected_pages or (
        matched_pages == expected_pages if match_mode == "all" else bool(matched_pages)
    )
    position_hit = not expected_positions or (
        len(matched_positions) == len(expected_positions) if match_mode == "all" else bool(matched_positions)
    )
    expected_rank_targets = expected_documents or set(actual_documents[:1])
    rank = next((index for index, name in enumerate(actual_documents, start=1) if name in expected_rank_targets), 0)
    return {
        "id": case.get("id"),
        "query": case.get("query"),
        "tags": list(map(str, case.get("tags") or [])),
        "hit": bool(document_hit and page_hit and position_hit),
        "rank": rank or None,
        "latencyMs": round(latency_ms, 1),
        "expectedDocuments": sorted(expected_documents),
        "actualDocuments": actual_documents,
        "documentRecall": round(len(matched_documents) / len(expected_documents), 4) if expected_documents else 1.0,
        "expectedPages": sorted(expected_pages),
        "actualPages": actual_pages,
        "pageRecall": round(len(matched_pages) / len(expected_pages), 4) if expected_pages else None,
        "expectedPositions": expected_positions,
        "actualPositions": [str(result.get("position") or "") for result in results],
    }


def build_summary(dataset: dict, base_ids: list[str], evaluated: list[tuple[dict, list[dict], float]]) -> dict:
    rows = [_case_row(case, results, latency) for case, results, latency in evaluated]
    latencies = [latency for _case, _results, latency in evaluated]
    reciprocal_ranks = [1 / row["rank"] if row["rank"] else 0.0 for row in rows]
    page_rows = [row for row in rows if row["expectedPages"]]
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
        "documentRecall": round(statistics.fmean(row["documentRecall"] for row in rows), 4) if rows else 0.0,
        "mrr": round(statistics.fmean(reciprocal_ranks), 4) if reciprocal_ranks else 0.0,
        "latencyP50Ms": round(statistics.median(latencies), 1) if latencies else 0.0,
        "latencyP95Ms": round(_percentile(latencies, 0.95), 1),
        "tags": tags,
        "results": rows,
    }


def markdown_report(summary: dict) -> str:
    page_hit = summary.get("pageHitRate")
    lines = [
        f"# {summary.get('dataset') or '知识检索评测'}",
        "",
        "| 指标 | 结果 |",
        "|---|---:|",
        f"| 用例数 | {summary.get('cases', 0)} |",
        f"| 命中率 | {float(summary.get('hitRate') or 0):.1%} |",
        f"| 文档召回率 | {float(summary.get('documentRecall') or 0):.1%} |",
        f"| 页码命中率 | {float(page_hit):.1%} |" if page_hit is not None else "| 页码命中率 | 未设置页码基准 |",
        f"| MRR | {float(summary.get('mrr') or 0):.4f} |",
        f"| 延迟 P50 | {summary.get('latencyP50Ms', 0)} ms |",
        f"| 延迟 P95 | {summary.get('latencyP95Ms', 0)} ms |",
        "",
        "## 用例结果",
        "",
        "| 用例 | 命中 | 排名 | 延迟 | 实际文档 / 页码 |",
        "|---|---|---:|---:|---|",
    ]
    for row in summary.get("results") or []:
        actual = "、".join(row.get("actualDocuments") or [])
        pages = ", ".join(map(str, row.get("actualPages") or []))
        lines.append(f"| {row.get('id')} | {'是' if row.get('hit') else '否'} | {row.get('rank') or '-'} | {row.get('latencyMs')} ms | {actual}{f' · P{pages}' if pages else ''} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    args = arguments()
    dataset = json.loads(Path(args.dataset).read_text("utf-8"))
    token = Path(args.token_file).read_text("utf-8").strip()
    evaluated = []
    for case in dataset.get("cases") or []:
        results, latency_ms = search(args, token, str(case.get("query") or ""))
        evaluated.append((case, results, latency_ms))
    summary = build_summary(dataset, knowledge_base_ids(args), evaluated)
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
    if args.min_page_hit_rate and summary["pageHitRate"] is not None:
        failed = failed or summary["pageHitRate"] < args.min_page_hit_rate
    if args.max_p95_ms:
        failed = failed or summary["latencyP95Ms"] > args.max_p95_ms
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
