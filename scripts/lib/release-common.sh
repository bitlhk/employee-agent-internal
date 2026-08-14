#!/usr/bin/env bash

release_die() {
  echo "[RELEASE] $*" >&2
  exit 1
}

release_log() {
  echo "==> $*"
}

release_realpath() {
  [[ -e "$1" || -L "$1" ]] || return 0
  readlink -f "$1" 2>/dev/null || true
}

release_require_command() {
  command -v "$1" >/dev/null 2>&1 || release_die "$1 is required"
}

release_validate_id() {
  [[ "$1" =~ ^[A-Za-z0-9._-]{1,96}$ ]] || release_die "invalid release id: $1"
}

release_atomic_link() {
  local target="$1"
  local link_path="$2"
  local temporary="${link_path}.next.$$"

  [[ ! -d "$link_path" || -L "$link_path" ]] || release_die "$link_path must be a symlink or absent"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link_path"
}

release_pm2_reload() {
  local app_root="$1"
  local app_name="${PM2_APP_NAME:-employee-agent}"
  local knowledge_name="${PM2_KNOWLEDGE_APP_NAME:-employee-agent-knowledge}"
  local alert_name="${PM2_ALERT_APP_NAME:-employee-agent-alerts}"
  local target_root pid actual_cwd
  target_root="$(release_realpath "$app_root")"

  release_pm2_reset_if_stale() {
    local process_name="$1"
    pid="$(pm2 pid "$process_name" 2>/dev/null | tail -n 1)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ && -e "/proc/$pid/cwd" ]]; then
      actual_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      if [[ "$actual_cwd" != "$target_root" ]]; then
        pm2 delete "$process_name" >/dev/null
      fi
    fi
  }

  if [[ -f "$app_root/ecosystem.knowledge.config.cjs" ]]; then
    release_pm2_reset_if_stale "$knowledge_name"
    APP_ROOT="$app_root" PM2_KNOWLEDGE_APP_NAME="$knowledge_name" \
      pm2 startOrReload "$app_root/ecosystem.knowledge.config.cjs" --only "$knowledge_name" --update-env
  fi

  release_pm2_reset_if_stale "$app_name"
  APP_ROOT="$app_root" PM2_APP_NAME="$app_name" \
    pm2 startOrReload "$app_root/ecosystem.config.cjs" --only "$app_name" --update-env

  if [[ -f "$app_root/ops/monitoring/ecosystem.alert-dispatcher.config.cjs" ]] \
    && grep -Eq '^EA_ALERT_FEISHU_WEBHOOK_URL=https://open\.feishu\.cn/' "$app_root/.env" 2>/dev/null; then
    release_pm2_reset_if_stale "$alert_name"
    APP_ROOT="$app_root" PM2_ALERT_APP_NAME="$alert_name" \
      pm2 startOrReload "$app_root/ops/monitoring/ecosystem.alert-dispatcher.config.cjs" --only "$alert_name" --update-env
  elif pm2 describe "$alert_name" >/dev/null 2>&1; then
    pm2 delete "$alert_name" >/dev/null
  fi
}

release_verify() {
  local app_root="$1"
  APP_ROOT="$app_root" "$app_root/scripts/verify-production-release.sh"
}

release_record() {
  local deploy_root="$1"
  local action="$2"
  local release_id="$3"
  local result="$4"
  local previous_id="${5:-}"
  local log_file="$deploy_root/deployments.log"

  printf '{"time":"%s","action":"%s","release":"%s","previous":"%s","result":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action" "$release_id" "$previous_id" "$result" >> "$log_file"
}

release_record_break_glass() {
  local deploy_root="$1"
  local release_id="$2"
  local source_commit="$3"
  local actor="$4"
  local approver="$5"
  local ticket="$6"
  local reason="$7"
  local log_file="$deploy_root/deployments.log"

  node - "$log_file" "$release_id" "$source_commit" "$actor" "$approver" "$ticket" "$reason" <<'NODE'
const { appendFileSync } = require("node:fs");
const [logFile, release, sourceCommit, actor, approver, ticket, reason] = process.argv.slice(2);
appendFileSync(logFile, `${JSON.stringify({
  time: new Date().toISOString(),
  action: "break_glass",
  release,
  sourceCommit,
  actor,
  approver,
  ticket,
  reason,
  result: "approved",
})}\n`);
NODE
}

release_previous_target() {
  local deploy_root="$1"
  local current_target="$2"
  local candidate="" failed_target
  failed_target="$(release_realpath "$deploy_root/failed")"

  if [[ -L "$deploy_root/previous" ]]; then
    candidate="$(release_realpath "$deploy_root/previous")"
    if [[ -d "$candidate" && "$candidate" != "$current_target" ]]; then
      printf '%s' "$candidate"
      return
    fi
  fi

  find "$deploy_root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | awk -v current="$current_target" -v failed="$failed_target" '$2 != current && $2 != failed { print $2; exit }'
}

release_prune() {
  local deploy_root="$1"
  local keep="$2"
  local current_target previous_target
  current_target="$(release_realpath "$deploy_root/current")"
  previous_target="$(release_realpath "$deploy_root/previous")"

  mapfile -t releases < <(
    find "$deploy_root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn \
      | awk '{ print $2 }'
  )

  local retained=0 candidate
  for candidate in "${releases[@]}"; do
    if [[ "$candidate" == "$current_target" || "$candidate" == "$previous_target" ]]; then
      continue
    fi
    retained=$((retained + 1))
    if (( retained > keep )); then
      rm -rf --one-file-system "$candidate"
    fi
  done
}
