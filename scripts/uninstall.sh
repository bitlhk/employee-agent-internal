#!/usr/bin/env bash
set -euo pipefail

# Internal cleanup helper for disposable installation-test hosts.
# This file is excluded from the public release tree.

INSTALL_DIR="${EMPLOYEE_AGENT_INSTALL_DIR:-$HOME/employee-agent}"
JIUWENSWARM_HOME="${JIUWENCLAW_HOME:-$HOME/.jiuwenswarm}"
JIUWENSWARM_VENV="${JIUWENSWARM_VENV:-$HOME/.venvs/employee-agent-jiuwenswarm}"
KEEP_DB=false
KEEP_RUNTIME=false
DRY_RUN=false
ASSUME_YES=false
DB_NAME=""
DB_USER=""
DB_HOST=""

usage() {
  cat <<'EOF'
Usage: bash scripts/uninstall.sh [options]

Internal cleanup helper for disposable one-click installation test hosts.

Options:
  --dir <path>       Install directory. Default: $HOME/employee-agent
  --keep-db          Keep the application database and database user.
  --keep-runtime     Keep JiuwenSwarm home and Python virtual environment.
  --dry-run          Print cleanup actions without changing the host.
  --yes              Skip the REMOVE confirmation prompt.
  -h, --help         Show this help.

The script intentionally keeps shared system packages such as Node.js, PM2,
MySQL, Docker, Python and Git.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?missing --dir value}"; shift 2 ;;
    --keep-db) KEEP_DB=true; shift ;;
    --keep-runtime) KEEP_RUNTIME=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

canonical_path() {
  realpath -m -- "$1"
}

assert_safe_home_path() {
  local label="$1"
  local path
  path=$(canonical_path "$2")
  case "$path" in
    "$HOME"/*) ;;
    *) echo "Refusing to remove $label outside HOME: $path" >&2; exit 1 ;;
  esac
  if [[ "$path" == "$HOME" || "$path" == "/" ]]; then
    echo "Refusing unsafe $label path: $path" >&2
    exit 1
  fi
  printf '%s\n' "$path"
}

INSTALL_DIR=$(assert_safe_home_path "install directory" "$INSTALL_DIR")
JIUWENSWARM_HOME=$(assert_safe_home_path "JiuwenSwarm home" "$JIUWENSWARM_HOME")
JIUWENSWARM_VENV=$(assert_safe_home_path "JiuwenSwarm virtual environment" "$JIUWENSWARM_VENV")

if [[ -e "$INSTALL_DIR" ]]; then
  if [[ ! -f "$INSTALL_DIR/package.json" ]] ||
     ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"employee-agent"' "$INSTALL_DIR/package.json"; then
    echo "Refusing to remove an unrecognized install directory: $INSTALL_DIR" >&2
    exit 1
  fi
fi

read_database_target() {
  local env_file="$INSTALL_DIR/.env"
  [[ -f "$env_file" ]] || return 0
  python3 - "$env_file" <<'PY'
import pathlib
import sys
from urllib.parse import unquote, urlparse

env_file = pathlib.Path(sys.argv[1])
database_url = ""
for raw_line in env_file.read_text(encoding="utf-8").splitlines():
    if raw_line.startswith("DATABASE_URL="):
        database_url = raw_line.split("=", 1)[1].strip()
        break

if not database_url:
    raise SystemExit(0)

parsed = urlparse(database_url)
if parsed.scheme not in {"mysql", "mysql2"}:
    raise SystemExit(0)

print(parsed.hostname or "")
print(unquote(parsed.username or ""))
print(unquote(parsed.path.lstrip("/")))
PY
}

mapfile -t DB_TARGET < <(read_database_target)
if [[ ${#DB_TARGET[@]} -ge 3 ]]; then
  DB_HOST="${DB_TARGET[0]}"
  DB_USER="${DB_TARGET[1]}"
  DB_NAME="${DB_TARGET[2]}"
fi

LOCAL_DB=false
if [[ "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "::1" ]]; then
  if [[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ && "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
    LOCAL_DB=true
  fi
fi

printf '\nEmployee Agent test uninstall plan\n'
printf '  Install directory:   %s\n' "$INSTALL_DIR"
printf '  PM2 applications:    employee-agent, jiuwenswarm-agentserver, jiuwenswarm-gateway\n'
if [[ "$KEEP_RUNTIME" == "true" ]]; then
  printf '  JiuwenSwarm runtime:  keep\n'
else
  printf '  JiuwenSwarm home:     %s\n' "$JIUWENSWARM_HOME"
  printf '  JiuwenSwarm venv:     %s\n' "$JIUWENSWARM_VENV"
fi
if [[ "$KEEP_DB" == "true" ]]; then
  printf '  Database:             keep\n'
elif [[ "$LOCAL_DB" == "true" ]]; then
  printf '  Local database:       %s (user %s@localhost)\n' "$DB_NAME" "$DB_USER"
elif [[ -n "$DB_HOST" ]]; then
  printf '  Database:             skip external or unsafe target %s\n' "$DB_HOST"
else
  printf '  Database:             no local target detected\n'
fi
printf '  System packages:      keep\n\n'

if [[ "$DRY_RUN" != "true" && "$ASSUME_YES" != "true" ]]; then
  read -r -p "Type REMOVE to continue: " answer
  if [[ "$answer" != "REMOVE" ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

pm2_app_cwd() {
  local name="$1"
  pm2 jlist 2>/dev/null | node -e '
    const fs = require("fs");
    const name = process.argv[1];
    const apps = JSON.parse(fs.readFileSync(0, "utf8") || "[]");
    const app = apps.find((item) => item.name === name);
    if (app?.pm2_env?.pm_cwd) process.stdout.write(app.pm2_env.pm_cwd);
  ' "$name"
}

PM2_CHANGED=false
remove_pm2_app() {
  local name="$1"
  local expected_cwd="$2"
  local actual_cwd=""
  command -v pm2 >/dev/null 2>&1 || return 0
  command -v node >/dev/null 2>&1 || return 0
  actual_cwd=$(pm2_app_cwd "$name")
  [[ -n "$actual_cwd" ]] || return 0
  actual_cwd=$(canonical_path "$actual_cwd")
  if [[ "$actual_cwd" != "$expected_cwd" ]]; then
    echo "Skipping PM2 app $name: cwd is $actual_cwd, expected $expected_cwd" >&2
    return 0
  fi
  run pm2 delete "$name"
  PM2_CHANGED=true
}

remove_pm2_app employee-agent "$INSTALL_DIR"
remove_pm2_app jiuwenswarm-agentserver "$JIUWENSWARM_HOME"
remove_pm2_app jiuwenswarm-gateway "$JIUWENSWARM_HOME"
if [[ "$PM2_CHANGED" == "true" ]]; then
  run pm2 save --force
fi

if [[ "$KEEP_DB" != "true" && "$LOCAL_DB" == "true" ]]; then
  sql="DROP DATABASE IF EXISTS \`${DB_NAME}\`; DROP USER IF EXISTS '${DB_USER}'@'localhost'; FLUSH PRIVILEGES;"
  if command -v mysql >/dev/null 2>&1; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[dry-run] drop local database $DB_NAME and user $DB_USER@localhost"
    elif [[ $(id -u) -eq 0 ]]; then
      mysql --protocol=socket -e "$sql"
    elif command -v sudo >/dev/null 2>&1; then
      sudo mysql --protocol=socket -e "$sql"
    else
      echo "Skipping database cleanup: root or sudo access is required." >&2
    fi
  else
    echo "Skipping database cleanup: mysql client is unavailable." >&2
  fi
fi

run rm -rf --one-file-system -- "$INSTALL_DIR"
if [[ "$KEEP_RUNTIME" != "true" ]]; then
  run rm -rf --one-file-system -- "$JIUWENSWARM_HOME"
  run rm -rf --one-file-system -- "$JIUWENSWARM_VENV"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  printf '\nDry run completed; no files, processes or databases were changed.\n'
else
  printf '\nEmployee Agent test installation removed.\n'
  printf 'Node.js, PM2, MySQL, Docker, Python, Git and the PM2 startup unit were kept.\n'
fi
