#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---fast}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LINGGAN_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
AGENT="${OPENCLAW_CONTRACT_AGENT:-trial_lgc-ofnmjm4joj}"
PM2_LOG_ROOT="${PM2_LOG_ROOT:-${HOME}/.pm2/logs}"

cd "$ROOT"

echo "== OpenClaw upgrade readiness =="
echo "time: $(date -Is)"
echo "root: $ROOT"
echo "mode: $MODE"
echo

echo "== OpenClaw baseline =="
if command -v openclaw >/dev/null 2>&1; then
  openclaw --version || true
  which openclaw || true
  readlink -f "$(which openclaw)" || true
else
  echo "openclaw: not found"
fi
echo

echo "== Workforce Agent Platform git state =="
git rev-parse --short HEAD 2>/dev/null || true
git status --short 2>/dev/null | head -80 || true
echo

if [[ "$MODE" == "--full" || "$MODE" == "--all" ]]; then
  echo "== Type/build checks =="
  pnpm run check
  echo
else
  echo "== Type/build checks =="
  echo "skipped in fast mode; run with --full before production upgrade"
  echo
fi

echo "== Runtime contract smoke =="
pnpm tsx scripts/check-openclaw-runtime-contract.ts
echo

if [[ "$MODE" == "--full" || "$MODE" == "--all" ]]; then
  echo "== Runtime contract full =="
  pnpm tsx scripts/check-openclaw-runtime-contract.ts --full --agent "$AGENT"
  echo

  echo "== Runtime contract HTTP fallback =="
  pnpm tsx scripts/check-openclaw-runtime-contract.ts --http --agent "$AGENT"
  echo
fi

echo "== Skill registry state =="
if command -v jq >/dev/null 2>&1 && [[ -f data/skill-registry.json ]]; then
  jq '[.[] | .state] | group_by(.) | map({state: .[0], count: length})' data/skill-registry.json || true
  echo "scan warnings:"
  jq '[.[] | select((.scan.warnings // []) | length > 0)] | length' data/skill-registry.json || true
else
  echo "skill registry summary unavailable"
fi
echo

echo "== Recent critical logs =="
mapfile -t LOG_FILES < <(
  find "$PM2_LOG_ROOT" -maxdepth 1 -type f \
    \( -name 'linggan-claw*.log' -o -name 'hi-agent*.log' -o -name 'agent-kernel*.log' \) \
    ! -name '*__*.log' \
    2>/dev/null | sort
)

if [[ "${#LOG_FILES[@]}" -gt 0 ]]; then
  tail -n 8000 "${LOG_FILES[@]}" 2>/dev/null \
    | grep -E 'CRON-LEGACY|CRON-RUNS-LEGACY|using legacy notify fallback|Unsupported channel|CRON-ORPHAN|CHAT-DEDUP|VERSION-DOWNGRADE|thinking|<think|recover.*failed|send failed|sync_failed|ERROR|Error' \
    | tail -80 || true
else
  echo "pm2 log files not found"
fi
echo

echo "== Decision reminder =="
echo "fast mode is enough for early evaluation only."
echo "production upgrade requires --full plus manual E2E checks from docs/runtime/UPGRADE_RUNBOOK.md."
echo
echo "Readiness check complete."
