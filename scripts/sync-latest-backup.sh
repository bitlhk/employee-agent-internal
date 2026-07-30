#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${BACKUP_SYNC_SOURCE_DIR:?BACKUP_SYNC_SOURCE_DIR is required}"
: "${BACKUP_SYNC_REMOTE_HOST:?BACKUP_SYNC_REMOTE_HOST is required}"
: "${BACKUP_SYNC_REMOTE_USER:=ea-backup}"
: "${BACKUP_SYNC_REMOTE_DIR:=/opt/backups/employee-agent}"
: "${BACKUP_SYNC_REMOTE_KEY:?BACKUP_SYNC_REMOTE_KEY is required}"

for command_name in find sha256sum ssh rsync; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "$command_name is required" >&2
    exit 1
  }
done

[[ -d "$BACKUP_SYNC_SOURCE_DIR" ]] || {
  echo "backup source directory is missing" >&2
  exit 1
}
[[ -r "$BACKUP_SYNC_REMOTE_KEY" ]] || {
  echo "backup sync key is missing" >&2
  exit 1
}

snapshot="$(
  find "$BACKUP_SYNC_SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d -name '20??????-??????' -print \
    | LC_ALL=C sort \
    | tail -n 1
)"
[[ -n "$snapshot" && -d "$snapshot" ]] || {
  echo "no complete backup snapshot found" >&2
  exit 1
}
for required in MANIFEST SHA256SUMS mysql.sql.gz.enc; do
  [[ -s "$snapshot/$required" ]] || {
    echo "snapshot is incomplete: $required" >&2
    exit 1
  }
done

(
  cd "$snapshot"
  sha256sum -c SHA256SUMS >/dev/null
)

snapshot_name="$(basename "$snapshot")"
ssh_options=(
  -i "$BACKUP_SYNC_REMOTE_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
)
ssh "${ssh_options[@]}" "$BACKUP_SYNC_REMOTE_USER@$BACKUP_SYNC_REMOTE_HOST" \
  "mkdir -p '$BACKUP_SYNC_REMOTE_DIR/$snapshot_name'"
rsync -az --delete --timeout=300 \
  -e "ssh -i $BACKUP_SYNC_REMOTE_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes" \
  "$snapshot/" \
  "$BACKUP_SYNC_REMOTE_USER@$BACKUP_SYNC_REMOTE_HOST:$BACKUP_SYNC_REMOTE_DIR/$snapshot_name/"

echo "backup sync completed: $snapshot_name"
