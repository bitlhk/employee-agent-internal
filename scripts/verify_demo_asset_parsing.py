#!/usr/bin/env python3
"""Verify that every generated demo asset is readable by the production parser."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    app_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(app_root / "server" / "knowledge"))
    from parsing import read_segments

    asset_root = Path(args.asset_root).resolve()
    manifest = json.loads(Path(args.manifest).read_text("utf-8"))
    results = []
    failures = []
    for item in manifest["assets"]:
        relative_path = item["relativePath"]
        target = (asset_root / relative_path).resolve()
        try:
            target.relative_to(asset_root)
            segments = read_segments(target)
            characters = sum(len(segment.text) for segment in segments)
            if not segments or characters <= 0:
                raise ValueError("parser returned no usable text")
            results.append({
                "relativePath": relative_path,
                "format": item["format"],
                "segments": len(segments),
                "characters": characters,
            })
        except Exception as error:  # The JSON report is consumed by the TypeScript verifier.
            failures.append({"relativePath": relative_path, "error": str(error)})

    print(json.dumps({
        "ok": not failures,
        "parsed": len(results),
        "failures": failures,
        "totalSegments": sum(item["segments"] for item in results),
        "totalCharacters": sum(item["characters"] for item in results),
    }, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
