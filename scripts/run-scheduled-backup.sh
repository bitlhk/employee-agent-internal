#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${EMPLOYEE_AGENT_BACKUP_CONFIG_DIR:=/root/.config/employee-agent}"

profile=--core
if [[ "$(date +%u)" == "7" ]]; then
  profile=--full
fi

EMPLOYEE_AGENT_BACKUP_CONFIG_DIR="$EMPLOYEE_AGENT_BACKUP_CONFIG_DIR" \
  "$APP_ROOT/scripts/backup-production.sh" "$profile"
EMPLOYEE_AGENT_BACKUP_CONFIG_DIR="$EMPLOYEE_AGENT_BACKUP_CONFIG_DIR" \
  "$APP_ROOT/scripts/validate-production-backup.sh" latest
