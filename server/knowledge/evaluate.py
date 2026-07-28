#!/usr/bin/env python3
"""Run a repeatable retrieval baseline against one indexed EA knowledge base."""

from __future__ import annotations

import argparse
import json
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


def main() -> int:
    args = arguments()
    dataset = json.loads(Path(args.dataset).read_text("utf-8"))
    token = Path(args.token_file).read_text("utf-8").strip()
    rows = []
    reciprocal_ranks = []
    latencies = []
    for case in dataset.get("cases") or []:
        results, latency_ms = search(args, token, str(case.get("query") or ""))
        actual = [str(result.get("document_name") or "") for result in results]
        expected = set(map(str, case.get("expectedDocuments") or []))
        rank = next((index for index, name in enumerate(actual, start=1) if name in expected), 0)
        reciprocal_ranks.append(1 / rank if rank else 0.0)
        latencies.append(latency_ms)
        rows.append({
            "id": case.get("id"),
            "hit": bool(rank),
            "rank": rank or None,
            "latencyMs": round(latency_ms, 1),
            "expected": sorted(expected),
            "actual": actual,
        })
    count = len(rows)
    hit_rate = sum(1 for row in rows if row["hit"]) / count if count else 0.0
    ordered_latency = sorted(latencies)
    p95_index = max(0, min(len(ordered_latency) - 1, round(len(ordered_latency) * 0.95) - 1)) if ordered_latency else 0
    summary = {
        "dataset": dataset.get("name"),
        "knowledgeBaseIds": knowledge_base_ids(args),
        "cases": count,
        "hitRate": round(hit_rate, 4),
        "mrr": round(statistics.fmean(reciprocal_ranks), 4) if reciprocal_ranks else 0.0,
        "latencyP50Ms": round(statistics.median(latencies), 1) if latencies else 0.0,
        "latencyP95Ms": round(ordered_latency[p95_index], 1) if ordered_latency else 0.0,
        "results": rows,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if hit_rate >= args.min_hit_rate else 2


if __name__ == "__main__":
    sys.exit(main())
