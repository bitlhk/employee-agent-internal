#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONFIG_DIR="${EMPLOYEE_AGENT_BACKUP_CONFIG_DIR:-/root/.config/employee-agent}"
CONFIG_FILE="$CONFIG_DIR/backup.env"
DB_CNF="$CONFIG_DIR/backup.cnf"
ENCRYPTION_KEY_FILE="$CONFIG_DIR/backup-encryption.key"

[[ -r "$CONFIG_FILE" ]] && source "$CONFIG_FILE"
: "${APP_DIR:=/root/employee-agent}"
: "${DB_NAME:=employee_agent}"
: "${BACKUP_DIR:=/root/backups/employee-agent}"
: "${KEEP_DAYS:=30}"
: "${JIUWENSWARM_HOME:=$HOME/.jiuwenswarm}"
: "${SKILL_STORE:=$HOME/skill-store}"
: "${INCLUDE_KNOWLEDGE_INDEXES:=false}"
: "${REMOTE_HOST:=}"
: "${REMOTE_USER:=ea-backup}"
: "${REMOTE_DIR:=/opt/backups/employee-agent}"
: "${REMOTE_KEY:=$CONFIG_DIR/offsite-backup-key}"

DATE="$(date +%Y%m%d-%H%M%S)"
DAY_OF_WEEK="$(date +%u)"
SNAPSHOT_DIR="$BACKUP_DIR/$DATE"

inventory() {
  for target in "$APP_DIR/data" "$SKILL_STORE" "$JIUWENSWARM_HOME"; do
    if [[ -e "$target" ]]; then
      du -sh "$target"
    else
      printf 'missing\t%s\n' "$target"
    fi
  done
}

if [[ "${1:-}" == "--inventory" ]]; then
  inventory
  exit 0
fi

[[ -r "$DB_CNF" ]] || { echo "missing $DB_CNF" >&2; exit 1; }
[[ -r "$ENCRYPTION_KEY_FILE" ]] || { echo "missing $ENCRYPTION_KEY_FILE" >&2; exit 1; }
mkdir -p "$SNAPSHOT_DIR"
chmod 700 "$BACKUP_DIR" "$SNAPSHOT_DIR"

encrypt_stream() {
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$ENCRYPTION_KEY_FILE"
}

write_atomic() {
  local target="$1"
  local temporary="${target}.tmp.$$"
  cat > "$temporary"
  [[ -s "$temporary" ]] || { rm -f "$temporary"; echo "empty backup output: $target" >&2; return 1; }
  chmod 600 "$temporary"
  mv -f "$temporary" "$target"
}

archive_application_data() {
  [[ -d "$APP_DIR/data" ]] || return 0
  local excludes=(
    --exclude='data/**/*.log'
    --exclude='data/**/tmp'
    --exclude='data/**/cache'
    --exclude='data/**/__pycache__'
  )
  if [[ "$INCLUDE_KNOWLEDGE_INDEXES" != "true" ]]; then
    excludes+=(--exclude='data/knowledge/indexes')
  fi
  tar -C "$APP_DIR" "${excludes[@]}" -czf - data \
    | encrypt_stream \
    | write_atomic "$SNAPSHOT_DIR/application-data.tar.gz.enc"
}

archive_skill_store() {
  [[ -d "$SKILL_STORE" ]] || return 0
  tar -C "$(dirname "$SKILL_STORE")" -czf - "$(basename "$SKILL_STORE")" \
    | encrypt_stream \
    | write_atomic "$SNAPSHOT_DIR/skill-store.tar.gz.enc"
}

archive_jiuwenswarm() {
  [[ -d "$JIUWENSWARM_HOME" ]] || return 0
  local runtime_parent runtime_name
  runtime_parent="$(dirname "$JIUWENSWARM_HOME")"
  runtime_name="$(basename "$JIUWENSWARM_HOME")"
  tar -C "$runtime_parent" \
    --exclude="$runtime_name/logs" \
    --exclude="$runtime_name/**/.logs" \
    --exclude="$runtime_name/**/__pycache__" \
    --exclude="$runtime_name/**/node_modules" \
    --exclude="$runtime_name/**/.venv" \
    --exclude="$runtime_name/run" \
    --exclude="$runtime_name/auto-harness/temp" \
    -czf - "$runtime_name" \
    | encrypt_stream \
    | write_atomic "$SNAPSHOT_DIR/jiuwenswarm-state.tar.gz.enc"
}

archive_configuration() {
  local config_files=()
  for candidate in .env ecosystem.config.cjs ecosystem.jiuwenswarm.config.cjs ecosystem.knowledge.config.cjs; do
    [[ -f "$APP_DIR/$candidate" ]] && config_files+=("$candidate")
  done
  [[ ${#config_files[@]} -gt 0 ]] || return 0
  tar -C "$APP_DIR" -czf - "${config_files[@]}" \
    | encrypt_stream \
    | write_atomic "$SNAPSHOT_DIR/platform-config.tar.gz.enc"
}

echo "[$(date --iso-8601=seconds)] backup started"

mysqldump --defaults-extra-file="$DB_CNF" \
  --single-transaction --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF --triggers "$DB_NAME" \
  | gzip -9 \
  | encrypt_stream \
  | write_atomic "$SNAPSHOT_DIR/mysql.sql.gz.enc"

archive_application_data
archive_skill_store
archive_jiuwenswarm
archive_configuration

(
  cd "$SNAPSHOT_DIR"
  sha256sum ./*.enc > SHA256SUMS
  chmod 600 SHA256SUMS
)

cat > "$SNAPSHOT_DIR/MANIFEST" <<EOF
created_at=$(date --iso-8601=seconds)
source_host=$(hostname -f 2>/dev/null || hostname)
database=$DB_NAME
application_data=$APP_DIR/data
skill_store=$SKILL_STORE
jiuwenswarm_home=$JIUWENSWARM_HOME
knowledge_indexes_included=$INCLUDE_KNOWLEDGE_INDEXES
EOF
chmod 600 "$SNAPSHOT_DIR/MANIFEST"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf -- {} +
date --iso-8601=seconds > "$BACKUP_DIR/.last-local-success"

if [[ "$DAY_OF_WEEK" == "7" && -n "$REMOTE_HOST" ]]; then
  [[ -r "$REMOTE_KEY" ]] || { echo "missing $REMOTE_KEY" >&2; exit 1; }
  ssh -i "$REMOTE_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
  rsync -az --timeout=180 -e "ssh -i $REMOTE_KEY -o BatchMode=yes -o StrictHostKeyChecking=yes" \
    "$SNAPSHOT_DIR/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/$DATE/"
  date --iso-8601=seconds > "$BACKUP_DIR/.last-offsite-success"
fi

echo "[$(date --iso-8601=seconds)] backup completed: $SNAPSHOT_DIR"
