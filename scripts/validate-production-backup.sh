#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONFIG_DIR="${EMPLOYEE_AGENT_BACKUP_CONFIG_DIR:-/root/.config/employee-agent}"
CONFIG_FILE="$CONFIG_DIR/backup.env"
ENCRYPTION_KEY_FILE="$CONFIG_DIR/backup-encryption.key"

[[ -r "$CONFIG_FILE" ]] && source "$CONFIG_FILE"
: "${BACKUP_DIR:=/root/backups/employee-agent}"
: "${BACKUP_REQUIRED_ARCHIVES:=mysql application-data skill-store jiuwenswarm-state platform-config}"
: "${BACKUP_VALIDATION_STATUS_FILE:=$BACKUP_DIR/.last-validated-success}"

case " $BACKUP_REQUIRED_ARCHIVES " in
  *" mysql "*) ;;
  *) BACKUP_REQUIRED_ARCHIVES="mysql $BACKUP_REQUIRED_ARCHIVES" ;;
esac

snapshot="${1:-latest}"
if [[ "$snapshot" == "latest" ]]; then
  snapshot=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20??????-??????' -print 2>/dev/null \
    | LC_ALL=C sort \
    | tail -n 1)
fi

[[ -n "$snapshot" && -d "$snapshot" ]] || { echo "backup snapshot not found" >&2; exit 1; }
[[ -r "$snapshot/MANIFEST" ]] || { echo "missing MANIFEST: $snapshot" >&2; exit 1; }
[[ -r "$snapshot/SHA256SUMS" ]] || { echo "missing SHA256SUMS: $snapshot" >&2; exit 1; }
[[ -r "$ENCRYPTION_KEY_FILE" ]] || { echo "missing encryption key: $ENCRYPTION_KEY_FILE" >&2; exit 1; }

declare -A archives=(
  [mysql]="mysql.sql.gz.enc"
  [application-data]="application-data.tar.gz.enc"
  [skill-store]="skill-store.tar.gz.enc"
  [jiuwenswarm-state]="jiuwenswarm-state.tar.gz.enc"
  [platform-config]="platform-config.tar.gz.enc"
)

for name in $BACKUP_REQUIRED_ARCHIVES; do
  file="${archives[$name]:-}"
  [[ -n "$file" ]] || { echo "unknown required archive: $name" >&2; exit 1; }
  [[ -s "$snapshot/$file" ]] || { echo "missing required archive: $file" >&2; exit 1; }
done

(
  cd "$snapshot"
  sha256sum -c SHA256SUMS
)

decrypt() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$ENCRYPTION_KEY_FILE" -in "$1"
}

shopt -s nullglob
encrypted_files=("$snapshot"/*.enc)
[[ ${#encrypted_files[@]} -gt 0 ]] || { echo "backup contains no encrypted archives" >&2; exit 1; }

for encrypted in "${encrypted_files[@]}"; do
  case "$(basename "$encrypted")" in
    mysql.sql.gz.enc)
      decrypt "$encrypted" | gzip -t
      ;;
    *.tar.gz.enc)
      decrypt "$encrypted" | tar -tzf - >/dev/null
      ;;
    *)
      echo "unsupported backup archive: $encrypted" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$(dirname "$BACKUP_VALIDATION_STATUS_FILE")"
validation_status_tmp="${BACKUP_VALIDATION_STATUS_FILE}.tmp.$$"
date --iso-8601=seconds > "$validation_status_tmp"
chmod 600 "$validation_status_tmp"
mv -f "$validation_status_tmp" "$BACKUP_VALIDATION_STATUS_FILE"
echo "backup validation passed: $snapshot"
