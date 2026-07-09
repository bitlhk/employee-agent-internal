#!/usr/bin/env bash
set -euo pipefail

# Bootstrap installer for Workforce Agent Platform.
# Intended usage:
#   curl -fsSL https://raw.githubusercontent.com/bitlhk/employee-agent/main/scripts/bootstrap-install.sh | bash
# During the transition, the legacy linggan-claw URL remains accepted as a fallback.

DEFAULT_REPO_URL="https://github.com/bitlhk/employee-agent.git"
LEGACY_REPO_URL="${EMPLOYEE_AGENT_LEGACY_REPO_URL:-https://github.com/bitlhk/linggan-claw.git}"
REPO_URL="${EMPLOYEE_AGENT_REPO_URL:-${LINGXIA_REPO_URL:-$DEFAULT_REPO_URL}}"
BRANCH="${EMPLOYEE_AGENT_BRANCH:-${LINGXIA_BRANCH:-main}}"
DEFAULT_INSTALL_DIR="$HOME/employee-agent"
if [[ -z "${EMPLOYEE_AGENT_INSTALL_DIR:-}" && -z "${LINGXIA_INSTALL_DIR:-}" && -d "$HOME/linggan-claw/.git" && ! -e "$DEFAULT_INSTALL_DIR" ]]; then
  DEFAULT_INSTALL_DIR="$HOME/linggan-claw"
fi
INSTALL_DIR="${EMPLOYEE_AGENT_INSTALL_DIR:-${LINGXIA_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}}"
REPO_EXPLICIT=false
PORT="${WORKFORCE_AGENT_PORT:-${LINGXIA_PORT:-5180}}"
HOST="${WORKFORCE_AGENT_HOST:-${LINGXIA_HOST:-}}"
DB_MODE="${WORKFORCE_AGENT_DB_MODE:-${LINGXIA_DB_MODE:-mysql-auto}}"
START_SERVICE=true
INSTALL_MYSQL=true
INSTALL_DOCKER=true
DRY_RUN=false
OVERWRITE_ENV=false
CREATE_ADMIN=true
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@linggan.local}"
ADMIN_NAME="${ADMIN_NAME:-Admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_PASSWORD_DISPLAY=""
ADMIN_PASSWORD_FILE="${ADMIN_PASSWORD_FILE:-$INSTALL_DIR/.bootstrap-admin-password}"

usage() {
  cat <<'EOF'
Usage: bash bootstrap-install.sh [options]

Options:
  --repo <url>             Git repository URL.
  --branch <name>          Git branch, default main.
  --dir <path>             Install directory, default $HOME/employee-agent for new installs.
  --port <port>            App port, default 5180.
  --host <ip-or-host>      Public host/IP for FRONTEND_URL. Auto-detected by default.
  --db-mode <mode>         mysql-auto | existing | compose. Default mysql-auto.
  --skip-mysql             Do not install mysql-server.
  --skip-docker            Do not install docker.io for the optional sandbox.
  --skip-start             Do not build/start PM2 service.
  --skip-admin             Do not create the default admin account.
  --overwrite-env          Regenerate .env if it already exists.
  --dry-run                Print actions without changing the system.
  -h, --help               Show this help.

Examples:
  bash bootstrap-install.sh
  bash bootstrap-install.sh --host 203.0.113.10 --dir "$HOME/employee-agent"
  bash bootstrap-install.sh --db-mode existing --skip-mysql
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:?missing --repo value}"; REPO_EXPLICIT=true; shift 2 ;;
    --branch) BRANCH="${2:?missing --branch value}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?missing --dir value}"; shift 2 ;;
    --port) PORT="${2:?missing --port value}"; shift 2 ;;
    --host) HOST="${2:?missing --host value}"; shift 2 ;;
    --db-mode) DB_MODE="${2:?missing --db-mode value}"; shift 2 ;;
    --skip-mysql) INSTALL_MYSQL=false; shift ;;
    --skip-docker) INSTALL_DOCKER=false; shift ;;
    --skip-start) START_SERVICE=false; shift ;;
    --skip-admin) CREATE_ADMIN=false; shift ;;
    --overwrite-env) OVERWRITE_ENV=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

log() { printf "\n==> %s\n" "$*"; }
run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf "[dry-run] %q" "$1"
    shift || true
    for arg in "$@"; do printf " %q" "$arg"; done
    printf "\n"
  else
    "$@"
  fi
}

run_with_log() {
  local label="$1"
  local log_file="$2"
  shift 2
  if [[ "$DRY_RUN" == "true" ]]; then
    printf "[dry-run] %q" "$1"
    shift || true
    for arg in "$@"; do printf " %q" "$arg"; done
    printf "\n"
    return
  fi
  echo "  $label..."
  if "$@" >"$log_file" 2>&1; then
    echo "  $label complete. Log: $log_file"
  else
    echo "  $label failed. Last log lines:" >&2
    tail -80 "$log_file" >&2 || true
    return 1
  fi
}

sudo_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This installer needs sudo for system packages or protected install paths." >&2
    return 1
  fi
}

detect_host() {
  if [[ -n "$HOST" ]]; then
    echo "$HOST"
    return
  fi
  local detected=""
  detected=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)
  if [[ -z "$detected" ]]; then
    detected=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  fi
  echo "${detected:-localhost}"
}

need_cmd() {
  ! command -v "$1" >/dev/null 2>&1
}

gen_admin_password() {
  openssl rand -base64 18 2>/dev/null | tr -d '/+=' | cut -c1-18
}

ensure_base_packages() {
  if [[ -f /etc/debian_version ]]; then
    log "Installing base packages"
    run sudo_cmd apt-get update
    run sudo_cmd apt-get install -y git curl ca-certificates openssl python3 build-essential
    if [[ "$INSTALL_MYSQL" == "true" && "$DB_MODE" == "mysql-auto" ]]; then
      run sudo_cmd apt-get install -y mysql-server
    fi
    if [[ "$INSTALL_DOCKER" == "true" ]]; then
      run sudo_cmd apt-get install -y docker.io
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] sudo_cmd systemctl enable --now docker"
      else
        sudo_cmd systemctl enable --now docker || true
      fi
    fi
  else
    log "Non-Debian system detected; please ensure git/curl/openssl/python3 are installed"
  fi
}

ensure_node() {
  local major=""
  if command -v node >/dev/null 2>&1; then
    major=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
  fi
  if [[ -n "$major" && "$major" -ge 22 ]]; then
    log "Node.js $(node -v) detected"
    return
  fi
  if [[ ! -f /etc/debian_version ]]; then
    echo "Node.js 22+ is required. Please install it manually." >&2
    exit 1
  fi
  log "Installing Node.js 22"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  fi
  run sudo_cmd apt-get install -y nodejs
}

ensure_node_tools() {
  log "Preparing pnpm and pm2"
  run sudo_cmd corepack enable
  run sudo_cmd corepack prepare pnpm@10.4.1 --activate
  if need_cmd pm2; then
    run sudo_cmd npm install -g pm2
  fi
}

clone_repo() {
  local target="$1"
  if git clone --branch "$BRANCH" "$REPO_URL" "$target"; then
    return 0
  fi
  if [[ "$REPO_EXPLICIT" != "true" && "$REPO_URL" != "$LEGACY_REPO_URL" ]]; then
    echo "Primary repository unavailable; falling back to legacy repository: $LEGACY_REPO_URL" >&2
    git clone --branch "$BRANCH" "$LEGACY_REPO_URL" "$target"
    return 0
  fi
  return 1
}

checkout_repo() {
  log "Checking out Workforce Agent Platform"
  local parent owner
  parent=$(dirname "$INSTALL_DIR")
  owner="${SUDO_USER:-${USER:-$(id -un)}}"
  run sudo_cmd mkdir -p "$parent"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    run git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    run git -C "$INSTALL_DIR" checkout "$BRANCH"
    run git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
  elif [[ -e "$INSTALL_DIR" ]]; then
    if [[ -z "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]]; then
      run sudo_cmd chown "$owner":"$owner" "$INSTALL_DIR"
      run clone_repo "$INSTALL_DIR"
    else
      echo "$INSTALL_DIR exists but is not an empty directory or a git repository." >&2
      exit 1
    fi
  else
    run sudo_cmd mkdir -p "$INSTALL_DIR"
    run sudo_cmd chown "$owner":"$owner" "$INSTALL_DIR"
    run clone_repo "$INSTALL_DIR"
  fi
}

run_setup() {
  log "Running Workforce Agent Platform setup"
  local host_arg
  host_arg=$(detect_host)
  local setup_args=(
    "--auto"
    "--yes"
    "--port" "$PORT"
    "--host" "$host_arg"
    "--db-mode" "$DB_MODE"
  )
  if [[ "$OVERWRITE_ENV" == "true" ]]; then
    setup_args+=("--overwrite-env")
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    printf "[dry-run] cd %q && bash ./setup.sh" "$INSTALL_DIR"
    for arg in "${setup_args[@]}"; do printf " %q" "$arg"; done
    printf "\n"
  else
    (cd "$INSTALL_DIR" && bash ./setup.sh "${setup_args[@]}")
  fi
}

start_app() {
  if [[ "$START_SERVICE" != "true" ]]; then
    log "Skipping build and PM2 start"
    return
  fi
  log "Building and starting Workforce Agent Platform"
  if [[ -z "${PM2_APP_NAME:-}" ]] && command -v pm2 >/dev/null 2>&1; then
    if pm2 describe linggan-claw >/dev/null 2>&1 && ! pm2 describe employee-agent >/dev/null 2>&1; then
      export PM2_APP_NAME="linggan-claw"
      log "Existing PM2 app linggan-claw detected; reusing it for this upgrade"
    fi
  fi
  run_with_log "Type check" "/tmp/employee-agent-check.log" bash -lc "cd '$INSTALL_DIR' && corepack pnpm check"
  run_with_log "Build" "/tmp/employee-agent-build.log" bash -lc "cd '$INSTALL_DIR' && corepack pnpm build"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] would start PM2 with ecosystem.config.cjs after setup generates it"
  elif [[ -f "$INSTALL_DIR/ecosystem.config.cjs" ]]; then
    run bash -lc "cd '$INSTALL_DIR' && pm2 start ecosystem.config.cjs --update-env || pm2 restart ecosystem.config.cjs --update-env"
    run pm2 save
  else
    echo "ecosystem.config.cjs was not generated." >&2
    exit 1
  fi
}

create_default_admin() {
  if [[ "$CREATE_ADMIN" != "true" ]]; then
    log "Skipping admin creation"
    return
  fi
  local generated_password=false
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(gen_admin_password)"
    generated_password=true
  fi
  if [[ "$generated_password" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      ADMIN_PASSWORD_DISPLAY="(would be generated; not printed in dry-run)"
    else
      ADMIN_PASSWORD_DISPLAY="(generated; stored in $ADMIN_PASSWORD_FILE with mode 600)"
      install -m 600 /dev/null "$ADMIN_PASSWORD_FILE"
      printf "%s\n" "$ADMIN_PASSWORD" > "$ADMIN_PASSWORD_FILE"
    fi
  else
    ADMIN_PASSWORD_DISPLAY="(provided via ADMIN_PASSWORD; not printed)"
  fi
  log "Creating default admin"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf "[dry-run] cd %q && ADMIN_EMAIL=%q ADMIN_PASSWORD=<redacted> corepack pnpm tsx scripts/init-admin.ts --email=%q --password=<redacted> --name=%q --skip-if-exists\n" \
      "$INSTALL_DIR" "$ADMIN_EMAIL" "$ADMIN_EMAIL" "$ADMIN_NAME"
  else
    local output
    output="$(cd "$INSTALL_DIR" && corepack pnpm tsx scripts/init-admin.ts \
      --email="$ADMIN_EMAIL" \
      --password="$ADMIN_PASSWORD" \
      --name="$ADMIN_NAME" \
      --skip-if-exists)"
    echo "$output"
    if [[ "$output" == *"existing admin kept"* ]]; then
      ADMIN_PASSWORD_DISPLAY="(existing password kept; not changed)"
      if [[ "$generated_password" == "true" ]]; then
        rm -f "$ADMIN_PASSWORD_FILE"
      fi
    fi
  fi
}

print_summary() {
  local url="http://$(detect_host):${PORT}"
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    url=$(grep '^FRONTEND_URL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "$url")
  fi
  cat <<EOF

─────────────────────────────────
Workforce Agent Platform bootstrap completed.
─────────────────────────────────

Install dir:
  $INSTALL_DIR

Open:
  $url

Default admin:
  Email:    ${ADMIN_EMAIL}
  Password: ${ADMIN_PASSWORD_DISPLAY:-"(not created or skipped)"}

Change this password immediately after first login.

Health checks:
  curl http://127.0.0.1:${PORT}/health
  curl http://127.0.0.1:${PORT}/api/brand

EOF
}

main() {
  log "Workforce Agent Platform bootstrap installer"
  ensure_base_packages
  ensure_node
  ensure_node_tools
  checkout_repo
  run_setup
  create_default_admin
  start_app
  print_summary
}

main
