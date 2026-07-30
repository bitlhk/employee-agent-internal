#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

source_dir="$root/backups"
snapshot="$source_dir/20260730-030000"
fake_bin="$root/bin"
log_file="$root/commands.log"
key_file="$root/sync-key"
mkdir -p "$snapshot" "$fake_bin"
printf 'created_at=2026-07-30T03:00:00Z\n' > "$snapshot/MANIFEST"
printf 'encrypted-database\n' > "$snapshot/mysql.sql.gz.enc"
printf 'encrypted-files\n' > "$snapshot/application-data.tar.gz.enc"
(
  cd "$snapshot"
  sha256sum MANIFEST mysql.sql.gz.enc application-data.tar.gz.enc > SHA256SUMS
)
printf 'test-key\n' > "$key_file"
chmod 600 "$key_file"

cat > "$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >> "$BACKUP_SYNC_TEST_LOG"
EOF
cat > "$fake_bin/rsync" <<'EOF'
#!/usr/bin/env bash
printf 'rsync %s\n' "$*" >> "$BACKUP_SYNC_TEST_LOG"
EOF
chmod +x "$fake_bin/ssh" "$fake_bin/rsync"

PATH="$fake_bin:$PATH" \
BACKUP_SYNC_TEST_LOG="$log_file" \
BACKUP_SYNC_SOURCE_DIR="$source_dir" \
BACKUP_SYNC_REMOTE_HOST="recovery.example" \
BACKUP_SYNC_REMOTE_USER="ea-backup" \
BACKUP_SYNC_REMOTE_DIR="/opt/backups/employee-agent" \
BACKUP_SYNC_REMOTE_KEY="$key_file" \
  "$SCRIPT_DIR/sync-latest-backup.sh"

grep -F "ea-backup@recovery.example" "$log_file" >/dev/null
grep -F "/opt/backups/employee-agent/20260730-030000" "$log_file" >/dev/null
grep -F "rsync " "$log_file" >/dev/null

printf 'corrupted\n' >> "$snapshot/mysql.sql.gz.enc"
if PATH="$fake_bin:$PATH" \
  BACKUP_SYNC_TEST_LOG="$log_file" \
  BACKUP_SYNC_SOURCE_DIR="$source_dir" \
  BACKUP_SYNC_REMOTE_HOST="recovery.example" \
  BACKUP_SYNC_REMOTE_KEY="$key_file" \
  "$SCRIPT_DIR/sync-latest-backup.sh" >/dev/null 2>&1; then
  echo "corrupted backup unexpectedly passed checksum validation" >&2
  exit 1
fi

echo "backup sync test passed"
