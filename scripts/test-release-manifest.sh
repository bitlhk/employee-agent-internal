#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
output="$(mktemp)"
trap 'rm -f "$output"' EXIT

(
  cd "$APP_ROOT"
  node scripts/generate-release-manifest.mjs \
    --output "$output" \
    --release-id release-test \
    --source-commit 0123456789abcdef \
    --created-at 2026-01-01T00:00:00Z
)

MANIFEST_PATH="$output" node --input-type=module <<'EOF'
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(process.env.MANIFEST_PATH, "utf8"));
const packageText = await readFile("package.json", "utf8");
const lockfileText = await readFile("pnpm-lock.yaml", "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");

if (manifest.schema !== 2) throw new Error("unexpected manifest schema");
if (manifest.releaseId !== "release-test") throw new Error("release ID missing");
if (manifest.sourceCommit !== "0123456789abcdef") throw new Error("source commit missing");
if (manifest.packageJsonSha256 !== digest(packageText)) throw new Error("package hash mismatch");
if (manifest.lockfileSha256 !== digest(lockfileText)) throw new Error("lockfile hash mismatch");
if (!manifest.dependencies?.express) throw new Error("production dependencies missing");
if (!manifest.devDependencies?.vitest) throw new Error("development dependencies missing");
EOF

echo "release dependency manifest test passed"
