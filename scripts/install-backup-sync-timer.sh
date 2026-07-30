#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" == "0" ]] || { echo "run as root" >&2; exit 1; }

SYNC_SCRIPT="${BACKUP_SYNC_SCRIPT:-/usr/local/sbin/employee-agent-sync-latest-backup}"
SYNC_CONFIG="${BACKUP_SYNC_CONFIG:-/root/.config/employee-agent/backup-sync.env}"
SERVICE_FILE="/etc/systemd/system/employee-agent-backup-sync.service"
TIMER_FILE="/etc/systemd/system/employee-agent-backup-sync.timer"

[[ -x "$SYNC_SCRIPT" ]] || { echo "backup sync script is missing: $SYNC_SCRIPT" >&2; exit 1; }
[[ -r "$SYNC_CONFIG" ]] || { echo "backup sync config is missing: $SYNC_CONFIG" >&2; exit 1; }

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Sync latest Employee Agent backup to the recovery host
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$SYNC_CONFIG
ExecStart=$SYNC_SCRIPT
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=30m
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Sync Employee Agent backup to the recovery host daily

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=20m
Persistent=true
Unit=employee-agent-backup-sync.service

[Install]
WantedBy=timers.target
EOF

chmod 0644 "$SERVICE_FILE" "$TIMER_FILE"
systemctl daemon-reload
systemctl enable --now employee-agent-backup-sync.timer
systemctl list-timers employee-agent-backup-sync.timer --no-pager
