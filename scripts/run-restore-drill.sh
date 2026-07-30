#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${RESTORE_DRILL_APP_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
APP_ROOT="$(readlink -f "$APP_ROOT")"
CONFIG_DIR="${EMPLOYEE_AGENT_BACKUP_CONFIG_DIR:-/root/.config/employee-agent}"
CONFIG_FILE="$CONFIG_DIR/backup.env"
ENCRYPTION_KEY_FILE="$CONFIG_DIR/backup-encryption.key"
DRILL_ROOT="${RESTORE_DRILL_ROOT:-/var/lib/employee-agent-restore-drills}"
MYSQL_IMAGE="${RESTORE_DRILL_MYSQL_IMAGE:-mysql:8.0.41}"
MYSQL_MEMORY="${RESTORE_DRILL_MYSQL_MEMORY:-3g}"
MYSQL_CPUS="${RESTORE_DRILL_MYSQL_CPUS:-2}"
MYSQL_TMPFS_SIZE="${RESTORE_DRILL_MYSQL_TMPFS_SIZE:-4g}"
KEEP_DATA="${RESTORE_DRILL_KEEP_DATA:-false}"
snapshot="${1:-latest}"

[[ -r "$CONFIG_FILE" ]] && source "$CONFIG_FILE"
: "${BACKUP_DIR:=/root/backups/employee-agent}"
: "${DB_NAME:=employee_agent}"

if [[ "$snapshot" == "latest" ]]; then
  snapshot="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20??????-??????' -print 2>/dev/null \
    | LC_ALL=C sort \
    | tail -n 1)"
fi
[[ -n "$snapshot" && -d "$snapshot" ]] || { echo "restore snapshot not found" >&2; exit 1; }
snapshot="$(readlink -f "$snapshot")"
[[ -r "$ENCRYPTION_KEY_FILE" ]] || { echo "missing encryption key: $ENCRYPTION_KEY_FILE" >&2; exit 1; }

for command_name in docker openssl gzip tar sha256sum python3; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "$command_name is required" >&2; exit 1; }
done

drill_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_root="$DRILL_ROOT/$drill_id"
decrypted_root="$run_root/decrypted"
restore_root="$run_root/restored"
report_path="$run_root/REPORT"
status_file="${RESTORE_DRILL_STATUS_FILE:-$DRILL_ROOT/.last-success-report}"
container_name="employee-agent-restore-drill-${drill_id,,}"
container_name="${container_name//[^a-z0-9_.-]/-}"
started_epoch="$(date +%s)"
result="failed"

mkdir -p "$decrypted_root" "$restore_root"
chmod 700 "$DRILL_ROOT" "$run_root" "$decrypted_root" "$restore_root"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [[ "$KEEP_DATA" != "true" ]]; then
    rm -rf "$decrypted_root" "$restore_root"
  fi
}
trap cleanup EXIT

decrypt_file() {
  local source="$1"
  local target="$2"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass "file:$ENCRYPTION_KEY_FILE" \
    -in "$source" \
    -out "$target"
}

assert_safe_archive() {
  local archive="$1"
  python3 - "$archive" <<'PY'
import pathlib
import sys
import tarfile

archive = sys.argv[1]

def safe_relative(value: str) -> bool:
    path = pathlib.PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts

with tarfile.open(archive, "r:gz") as handle:
    for member in handle.getmembers():
        if not safe_relative(member.name):
            raise SystemExit(f"unsafe archive path: {member.name}")
        if member.issym() or member.islnk():
            target = pathlib.PurePosixPath(member.linkname)
            if target.is_absolute():
                raise SystemExit(f"unsafe archive link: {member.name} -> {member.linkname}")
            resolved = pathlib.PurePosixPath(member.name).parent.joinpath(target)
            if ".." in resolved.parts:
                raise SystemExit(f"unsafe archive link: {member.name} -> {member.linkname}")
PY
}

restore_archive() {
  local encrypted_name="$1"
  local destination="$2"
  local archive="$decrypted_root/${encrypted_name%.enc}"
  [[ -s "$snapshot/$encrypted_name" ]] || { echo "missing restore archive: $encrypted_name" >&2; return 1; }
  decrypt_file "$snapshot/$encrypted_name" "$archive"
  gzip -t "$archive"
  assert_safe_archive "$archive"
  mkdir -p "$destination"
  tar -xzf "$archive" -C "$destination" --no-same-owner
}

EMPLOYEE_AGENT_BACKUP_CONFIG_DIR="$CONFIG_DIR" \
  "$APP_ROOT/scripts/validate-production-backup.sh" "$snapshot"

restore_archive application-data.tar.gz.enc "$restore_root/application"
restore_archive skill-store.tar.gz.enc "$restore_root/skills"
restore_archive jiuwenswarm-state.tar.gz.enc "$restore_root/jiuwenswarm"
restore_archive platform-config.tar.gz.enc "$restore_root/config"

mysql_archive="$decrypted_root/mysql.sql.gz"
decrypt_file "$snapshot/mysql.sql.gz.enc" "$mysql_archive"
gzip -t "$mysql_archive"

mysql_password="$(openssl rand -hex 24)"
docker run -d \
  --name "$container_name" \
  --network none \
  --memory "$MYSQL_MEMORY" \
  --cpus "$MYSQL_CPUS" \
  --tmpfs "/var/lib/mysql:rw,size=$MYSQL_TMPFS_SIZE,mode=0700" \
  -e "MYSQL_ROOT_PASSWORD=$mysql_password" \
  -e "MYSQL_DATABASE=$DB_NAME" \
  "$MYSQL_IMAGE" \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_unicode_ci >/dev/null

mysql_ready=false
for _ in $(seq 1 90); do
  if docker exec "$container_name" \
    env "MYSQL_PWD=$mysql_password" mysql -N -B -uroot -e "SELECT 1;" >/dev/null 2>&1; then
    mysql_ready=true
    break
  fi
  sleep 1
done
[[ "$mysql_ready" == "true" ]] || { echo "restore MySQL did not become ready" >&2; exit 1; }

gzip -dc "$mysql_archive" \
  | docker exec -e "MYSQL_PWD=$mysql_password" -i "$container_name" \
      mysql --binary-mode=1 -uroot "$DB_NAME"

mysql_query() {
  docker exec -e "MYSQL_PWD=$mysql_password" "$container_name" \
    mysql -N -B -uroot "$DB_NAME" -e "$1"
}

table_count="$(mysql_query "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE';")"
trigger_count="$(mysql_query "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'audit_%';")"
users_count="$(mysql_query "SELECT COUNT(*) FROM users;")"
adoptions_count="$(mysql_query "SELECT COUNT(*) FROM claw_adoptions;")"
skills_count="$(mysql_query "SELECT COUNT(*) FROM skill_marketplace;")"
knowledge_bases_count="$(mysql_query "SELECT COUNT(*) FROM knowledge_bases;")"
knowledge_documents_count="$(mysql_query "SELECT COUNT(*) FROM knowledge_documents;")"
audit_view_count="$(mysql_query "SELECT COUNT(*) FROM audit_worm_trigger_status;")"

(( table_count > 0 ))
(( users_count >= 0 ))
(( adoptions_count >= 0 ))
(( skills_count >= 0 ))
(( knowledge_bases_count >= 0 ))
(( knowledge_documents_count >= 0 ))
[[ "$trigger_count" == "$audit_view_count" ]]

application_files="$(find "$restore_root/application" -type f | wc -l)"
skill_files="$(find "$restore_root/skills" -type f | wc -l)"
jiuwen_files="$(find "$restore_root/jiuwenswarm" -type f | wc -l)"
config_files="$(find "$restore_root/config" -type f | wc -l)"
completed_epoch="$(date +%s)"
rto_seconds=$((completed_epoch - started_epoch))

created_at="$(sed -n 's/^created_at=//p' "$snapshot/MANIFEST" | head -n 1)"
source_commit="$(sed -n 's/^source_commit=//p' "$snapshot/MANIFEST" | head -n 1)"
database_profile="$(sed -n 's/^database_profile=//p' "$snapshot/MANIFEST" | head -n 1)"
snapshot_epoch="$(date -d "$created_at" +%s 2>/dev/null || printf '%s' "$started_epoch")"
rpo_seconds=$((started_epoch - snapshot_epoch))
(( rpo_seconds < 0 )) && rpo_seconds=0
result="passed"

cat > "$report_path" <<EOF
result=$result
drill_id=$drill_id
snapshot=$(basename "$snapshot")
snapshot_created_at=$created_at
source_commit=$source_commit
database_profile=$database_profile
mysql_image=$MYSQL_IMAGE
mysql_memory=$MYSQL_MEMORY
mysql_cpus=$MYSQL_CPUS
rpo_seconds=$rpo_seconds
rto_seconds=$rto_seconds
table_count=$table_count
audit_trigger_count=$trigger_count
users_count=$users_count
adoptions_count=$adoptions_count
skill_marketplace_count=$skills_count
knowledge_bases_count=$knowledge_bases_count
knowledge_documents_count=$knowledge_documents_count
application_file_count=$application_files
skill_file_count=$skill_files
jiuwenswarm_file_count=$jiuwen_files
config_file_count=$config_files
data_retained=$KEEP_DATA
EOF
chmod 600 "$report_path"
status_tmp="${status_file}.tmp.$$"
mkdir -p "$(dirname "$status_file")"
cp "$report_path" "$status_tmp"
chmod 600 "$status_tmp"
mv -f "$status_tmp" "$status_file"

echo "restore drill passed"
echo "report=$report_path"
echo "rpo_seconds=$rpo_seconds rto_seconds=$rto_seconds tables=$table_count"
