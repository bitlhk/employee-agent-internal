#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" == "0" ]] || { echo "run as root" >&2; exit 1; }
[[ "${RESTORE_DRILL_RECOVERY_HOST:-}" == "1" ]] || {
  echo "refusing to schedule restore drills without RESTORE_DRILL_RECOVERY_HOST=1" >&2
  echo "install this timer on the isolated recovery host, not the production application host" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${RESTORE_DRILL_APP_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
APP_ROOT="$(readlink -f "$APP_ROOT")"
CONFIG_DIR="${EMPLOYEE_AGENT_BACKUP_CONFIG_DIR:-/root/.config/employee-agent}"
DRILL_ROOT="${RESTORE_DRILL_ROOT:-/var/lib/employee-agent-restore-drills}"
SERVICE_FILE="/etc/systemd/system/employee-agent-restore-drill.service"
TIMER_FILE="/etc/systemd/system/employee-agent-restore-drill.timer"

[[ -x "$APP_ROOT/scripts/run-restore-drill.sh" ]] || {
  echo "restore runner is missing: $APP_ROOT/scripts/run-restore-drill.sh" >&2
  exit 1
}
[[ -r "$CONFIG_DIR/backup-encryption.key" ]] || {
  echo "backup encryption key is missing: $CONFIG_DIR/backup-encryption.key" >&2
  exit 1
}
install -d -o root -g root -m 0700 "$DRILL_ROOT"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Employee Agent isolated restore drill
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_ROOT
Environment=EMPLOYEE_AGENT_BACKUP_CONFIG_DIR=$CONFIG_DIR
Environment=RESTORE_DRILL_ROOT=$DRILL_ROOT
Environment=BACKUP_VALIDATION_STATUS_FILE=$DRILL_ROOT/.last-backup-validation-success
ExecStart=$APP_ROOT/scripts/run-restore-drill.sh latest
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=4h
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DRILL_ROOT /run /tmp
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Run the Employee Agent restore drill monthly

[Timer]
OnCalendar=*-*-01 06:30:00
RandomizedDelaySec=2h
Persistent=true
Unit=employee-agent-restore-drill.service

[Install]
WantedBy=timers.target
EOF

chmod 0644 "$SERVICE_FILE" "$TIMER_FILE"
systemctl daemon-reload
systemctl enable --now employee-agent-restore-drill.timer
systemctl list-timers employee-agent-restore-drill.timer --no-pager
