#!/bin/bash
# monitor-health.sh — 岗位智能体平台健康监控
# cron: */5 * * * *
# 支持 Telegram / 钉钉 / 飞书

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/../logs"
LOG_FILE="${LOG_DIR}/monitor.log"
STATE_FILE="/tmp/workforce-agent-monitor-state"
mkdir -p "$LOG_DIR"
touch "$STATE_FILE"

# 加载配置
for f in "${SCRIPT_DIR}/../monitor.env" "${SCRIPT_DIR}/../.monitor.env"; do
  [ -f "$f" ] && while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    export "$line"
  done < "$f"
done

send_notify() {
  local emoji="$1" label="$2" msg="$3"
  local ts=$(date '+%Y-%m-%d %H:%M:%S')
  local full="${emoji} 岗位智能体平台 [${ts}] ${label}\n${msg}"
  echo -e "[${label}] ${ts} ${msg}" >> "$LOG_FILE"

  [ -n "${MONITOR_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${MONITOR_TELEGRAM_CHAT_ID:-}" ] &&     curl -s -X POST "https://api.telegram.org/bot${MONITOR_TELEGRAM_BOT_TOKEN}/sendMessage"       -d "chat_id=${MONITOR_TELEGRAM_CHAT_ID}" -d "text=$(echo -e "$full")"       --max-time 10 >/dev/null 2>&1 || true

  [ -n "${MONITOR_DINGTALK_WEBHOOK:-}" ] &&     curl -s -X POST "$MONITOR_DINGTALK_WEBHOOK" -H 'Content-Type: application/json'       -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$(echo -e "$full")\"}}"      --max-time 10 >/dev/null 2>&1 || true

  [ -n "${MONITOR_FEISHU_WEBHOOK:-}" ] &&     curl -s -X POST "$MONITOR_FEISHU_WEBHOOK" -H 'Content-Type: application/json'       -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$(echo -e "$full")\"}}"      --max-time 10 >/dev/null 2>&1 || true
}

check_http() {
  local name="$1" url="$2"
  local code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo "000")
  local key="fail_${name// /_}"

  if [ "$code" = "200" ] || [ "$code" = "204" ]; then
    if grep -q "$key" "$STATE_FILE" 2>/dev/null; then
      sed -i "/$key/d" "$STATE_FILE"
      send_notify "✅" "RECOVER" "${name} 已恢复"
    fi
    return 0
  else
    if ! grep -q "$key" "$STATE_FILE" 2>/dev/null; then
      echo "$key" >> "$STATE_FILE"
      send_notify "🚨" "ALERT" "${name} 不可用 (HTTP ${code})"
    fi
    return 1
  fi
}

check_process() {
  local name="$1" pattern="$2"
  local key="fail_${name// /_}"

  if pgrep -f "$pattern" >/dev/null 2>&1; then
    if grep -q "$key" "$STATE_FILE" 2>/dev/null; then
      sed -i "/$key/d" "$STATE_FILE"
      send_notify "✅" "RECOVER" "${name} 进程已恢复"
    fi
    return 0
  else
    if ! grep -q "$key" "$STATE_FILE" 2>/dev/null; then
      echo "$key" >> "$STATE_FILE"
      send_notify "🚨" "ALERT" "${name} 进程不存在"
    fi
    return 1
  fi
}

check_port() {
  local name="$1" port="$2"
  local key="fail_${name// /_}"

  if ss -tlnp | grep -q ":${port} " 2>/dev/null; then
    if grep -q "$key" "$STATE_FILE" 2>/dev/null; then
      sed -i "/$key/d" "$STATE_FILE"
      send_notify "✅" "RECOVER" "${name} 端口已恢复"
    fi
    return 0
  else
    if ! grep -q "$key" "$STATE_FILE" 2>/dev/null; then
      echo "$key" >> "$STATE_FILE"
      send_notify "🚨" "ALERT" "${name} 端口 ${port} 未监听"
    fi
    return 1
  fi
}

# ── 执行检查 ──
echo "--- $(date '+%Y-%m-%d %H:%M:%S') ---" >> "$LOG_FILE"
F=0

check_port  "岗位智能体平台"       5180 || ((F++))
check_http  "OpenClaw-GW"   "http://127.0.0.1:18789/health" || ((F++))
check_http  "Business-MCP"   "http://127.0.0.1:8188/api/v1/auth/status" || ((F++))
check_port  "business-mcp"   8188 || ((F++))

echo "Failures: $F" >> "$LOG_FILE"
