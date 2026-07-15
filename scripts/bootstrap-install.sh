#!/usr/bin/env bash
set -euo pipefail

# Bootstrap installer for Workforce Agent Platform.
# Intended usage:
#   git clone --depth 1 https://atomgit.com/linggan_ai/employee-agent.git /tmp/employee-agent-installer
#   bash /tmp/employee-agent-installer/scripts/bootstrap-install.sh
INSTALLER_VERSION="2026.07.15.1"
INSTALL_ID="${EMPLOYEE_AGENT_INSTALL_ID:-}"
TELEMETRY_ENDPOINT="${EMPLOYEE_AGENT_INSTALL_TELEMETRY_ENDPOINT:-}"
TELEMETRY_SOURCE="${EMPLOYEE_AGENT_INSTALL_SOURCE:-bootstrap}"
TELEMETRY_ENABLED="${EMPLOYEE_AGENT_TELEMETRY:-1}"
INSTALL_STAGE="preflight"
INSTALL_STARTED_AT=0
DEFAULT_REPO_URL="https://atomgit.com/linggan_ai/employee-agent.git"
REPO_URL="${EMPLOYEE_AGENT_REPO_URL:-${LINGXIA_REPO_URL:-$DEFAULT_REPO_URL}}"
BRANCH="${EMPLOYEE_AGENT_BRANCH:-${LINGXIA_BRANCH:-main}}"
DEFAULT_INSTALL_DIR="$HOME/employee-agent"
INSTALL_DIR="${EMPLOYEE_AGENT_INSTALL_DIR:-${LINGXIA_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}}"
PORT="${WORKFORCE_AGENT_PORT:-${LINGXIA_PORT:-5180}}"
HOST="${WORKFORCE_AGENT_HOST:-${LINGXIA_HOST:-}}"
RESOLVED_HOST=""
DB_MODE="${WORKFORCE_AGENT_DB_MODE:-${LINGXIA_DB_MODE:-mysql-auto}}"
MIRROR_MODE="${EMPLOYEE_AGENT_MIRROR:-auto}"
ACTIVE_MIRROR="official"
APT_SOURCE_ARGS=()
APT_SOURCE_FILE=""
START_SERVICE=true
INSTALL_MYSQL=true
INSTALL_DOCKER=true
INSTALL_JIUWENSWARM=true
DRY_RUN=false
OVERWRITE_ENV=false
CREATE_ADMIN=true
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@employee-agent.local}"
ADMIN_NAME="${ADMIN_NAME:-Admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_PASSWORD_DISPLAY=""
ADMIN_PASSWORD_FILE="${ADMIN_PASSWORD_FILE:-$INSTALL_DIR/.bootstrap-admin-password}"
JIUWENSWARM_REPO="${JIUWENSWARM_REPO:-https://atomgit.com/linggan_ai/jiuwenswarm.git}"
JIUWENSWARM_REF="${JIUWENSWARM_REF:-ea-runtime-0.2.3.1}"
JIUWENSWARM_VERSION="${JIUWENSWARM_VERSION:-0.2.3+ea.1}"
JIUWENSWARM_HOME="${JIUWENCLAW_HOME:-$HOME/.jiuwenswarm}"
JIUWENSWARM_VENV="${JIUWENSWARM_VENV:-$HOME/.venvs/employee-agent-jiuwenswarm}"
JIUWENSWARM_WHEEL_URL="${JIUWENSWARM_WHEEL_URL:-}"
JIUWENSWARM_WHEEL_SHA256="${JIUWENSWARM_WHEEL_SHA256:-}"

usage() {
  cat <<'EOF'
Usage: bash bootstrap-install.sh [options]

Options:
  --repo <url>             Git repository URL.
  --branch <name>          Git branch, default main.
  --dir <path>             Install directory, default $HOME/employee-agent for new installs.
  --port <port>            App port, default 5180.
  --host <ip-or-host>      Public host/IP for FRONTEND_URL. The app still binds to loopback by default.
  --db-mode <mode>         mysql-auto | existing | compose. Default mysql-auto.
  --mirror <mode>          auto | cn | official. Default auto; official disables installer mirrors.
  --skip-mysql             Do not install mysql-server.
  --skip-docker            Do not install docker.io for the optional sandbox.
  --skip-jiuwenswarm       Install EA without the bundled JiuwenSwarm runtime.
  --jiuwenswarm-ref <ref>  JiuwenSwarm EA runtime tag or commit.
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
    --repo) REPO_URL="${2:?missing --repo value}"; shift 2 ;;
    --branch) BRANCH="${2:?missing --branch value}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?missing --dir value}"; shift 2 ;;
    --port) PORT="${2:?missing --port value}"; shift 2 ;;
    --host) HOST="${2:?missing --host value}"; shift 2 ;;
    --db-mode) DB_MODE="${2:?missing --db-mode value}"; shift 2 ;;
    --mirror) MIRROR_MODE="${2:?missing --mirror value}"; shift 2 ;;
    --skip-mysql) INSTALL_MYSQL=false; shift ;;
    --skip-docker) INSTALL_DOCKER=false; shift ;;
    --skip-jiuwenswarm) INSTALL_JIUWENSWARM=false; shift ;;
    --jiuwenswarm-ref) JIUWENSWARM_REF="${2:?missing --jiuwenswarm-ref value}"; shift 2 ;;
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

is_public_ipv4() {
  printf '%s\n' "$1" | awk -F. '
    NF != 4 { exit 1 }
    {
      for (i = 1; i <= 4; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
      }
      if ($1 == 0 || $1 == 10 || $1 == 127 || $1 >= 224) exit 1
      if ($1 == 100 && $2 >= 64 && $2 <= 127) exit 1
      if ($1 == 169 && $2 == 254) exit 1
      if ($1 == 172 && $2 >= 16 && $2 <= 31) exit 1
      if ($1 == 192 && $2 == 168) exit 1
      if ($1 == 198 && ($2 == 18 || $2 == 19)) exit 1
      if ($1 == 192 && $2 == 0 && ($3 == 0 || $3 == 2)) exit 1
      if ($1 == 198 && $2 == 51 && $3 == 100) exit 1
      if ($1 == 203 && $2 == 0 && $3 == 113) exit 1
    }
  '
}

detect_public_ipv4() {
  local endpoint="" detected=""
  for endpoint in \
    "http://169.254.169.254/latest/meta-data/public-ipv4" \
    "http://100.100.100.200/latest/meta-data/eipv4" \
    "https://ip.3322.net" \
    "https://api.ipify.org" \
    "https://4.ipw.cn"; do
    detected=$(curl -4 -fsS --noproxy '*' --connect-timeout 2 --max-time 4 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ -n "$detected" ]] && is_public_ipv4 "$detected"; then
      echo "$detected"
      return
    fi
  done
}

detect_host() {
  if [[ -n "$HOST" ]]; then
    echo "$HOST"
    return
  fi
  local detected=""
  detected=$(detect_public_ipv4)
  if [[ -z "$detected" ]]; then
    echo "Warning: public IPv4 detection failed; using localhost. Pass --host to configure an external URL." >&2
  fi
  echo "${detected:-localhost}"
}

need_cmd() {
  ! command -v "$1" >/dev/null 2>&1
}

has_cn_apt_source() {
  grep -RqsE "(huaweicloud|mirrors\.(aliyun|tuna|ustc)|mirrors\.cloud\.tencent|mirrors\.163\.com|mirror\.sjtu)" \
    /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null
}

probe_download_time() {
  curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 -w "%{time_total}" "$1" 2>/dev/null
}

prepare_cn_apt_source() {
  [[ -r /etc/os-release ]] || return
  local distro_id="" codename="" arch="" mirror_url="https://repo.huaweicloud.com/ubuntu"
  distro_id=$(source /etc/os-release && printf "%s" "${ID:-}")
  codename=$(source /etc/os-release && printf "%s" "${VERSION_CODENAME:-}")
  [[ "$distro_id" == "ubuntu" && -n "$codename" ]] || return
  [[ -r /usr/share/keyrings/ubuntu-archive-keyring.gpg ]] || return
  arch=$(dpkg --print-architecture 2>/dev/null || true)
  if [[ "$arch" != "amd64" && "$arch" != "i386" ]]; then
    mirror_url="https://repo.huaweicloud.com/ubuntu-ports"
  fi

  APT_SOURCE_FILE=$(mktemp --suffix=.sources /tmp/employee-agent-ubuntu-mirror.XXXXXX)
  cat >"$APT_SOURCE_FILE" <<EOF
Types: deb
URIs: $mirror_url
Suites: $codename ${codename}-updates ${codename}-backports ${codename}-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  APT_SOURCE_ARGS=(
    -o "Dir::Etc::sourcelist=$APT_SOURCE_FILE"
    -o "Dir::Etc::sourceparts=-"
    -o APT::Get::List-Cleanup=0
  )
}

cleanup_installer_temp_files() {
  [[ -z "$APT_SOURCE_FILE" ]] || rm -f -- "$APT_SOURCE_FILE"
}

telemetry_token() {
  local value="$1" fallback="$2"
  value=$(printf "%s" "$value" | tr -cd 'A-Za-z0-9._:-' | cut -c1-64)
  printf "%s" "${value:-$fallback}"
}

ensure_install_id() {
  if [[ "$INSTALL_ID" =~ ^[A-Za-z0-9_-]{16,64}$ ]]; then return; fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    INSTALL_ID=$(tr -d '[:space:]' </proc/sys/kernel/random/uuid)
  elif command -v openssl >/dev/null 2>&1; then
    INSTALL_ID=$(openssl rand -hex 16)
  else
    INSTALL_ID="install-$(date +%s)-$$-${RANDOM:-0}"
  fi
}

telemetry_event() {
  local event_type="$1" duration_ms=0 os_type="unknown" arch="unknown" mirror="unknown" payload=""
  [[ "$DRY_RUN" != "true" && "$TELEMETRY_ENABLED" != "0" ]] || return 0
  [[ -n "$TELEMETRY_ENDPOINT" && -n "$INSTALL_ID" ]] || return 0
  case "$TELEMETRY_ENDPOINT" in
    https://*|http://127.0.0.1:*|http://localhost:*) ;;
    *) return 0 ;;
  esac
  command -v curl >/dev/null 2>&1 || return 0

  if [[ -r /etc/os-release ]]; then
    os_type=$(source /etc/os-release && printf "%s" "${ID:-unknown}")
  fi
  arch=$(uname -m 2>/dev/null || printf "unknown")
  if [[ "$INSTALL_STARTED_AT" -gt 0 ]]; then
    duration_ms=$(( ($(date +%s) - INSTALL_STARTED_AT) * 1000 ))
    [[ "$duration_ms" -le 86400000 ]] || duration_ms=86400000
  fi
  if [[ "$event_type" == "started" ]]; then mirror="$MIRROR_MODE"; else mirror="$ACTIVE_MIRROR"; fi

  payload=$(printf '{"installId":"%s","eventType":"%s","stage":"%s","source":"%s","installerVersion":"%s","osType":"%s","arch":"%s","mirror":"%s","durationMs":%d}' \
    "$(telemetry_token "$INSTALL_ID" unknown-install-id)" \
    "$(telemetry_token "$event_type" unknown)" \
    "$(telemetry_token "$INSTALL_STAGE" unknown)" \
    "$(telemetry_token "$TELEMETRY_SOURCE" bootstrap)" \
    "$(telemetry_token "$INSTALLER_VERSION" unknown)" \
    "$(telemetry_token "$os_type" unknown)" \
    "$(telemetry_token "$arch" unknown)" \
    "$(telemetry_token "$mirror" unknown)" \
    "$duration_ms")
  curl -fsS --connect-timeout 1 --max-time 2 \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    "$TELEMETRY_ENDPOINT" >/dev/null 2>&1 || true
}

finish_install() {
  local rc="$1"
  trap - EXIT
  cleanup_installer_temp_files
  if [[ "$rc" -eq 0 ]]; then
    INSTALL_STAGE="complete"
    telemetry_event "succeeded"
  else
    telemetry_event "failed"
  fi
  exit "$rc"
}

configure_download_mirrors() {
  export NO_UPDATE_NOTIFIER="${NO_UPDATE_NOTIFIER:-1}"
  export npm_config_fetch_retries="${npm_config_fetch_retries:-5}"
  export npm_config_fetch_retry_factor="${npm_config_fetch_retry_factor:-2}"
  export npm_config_fetch_retry_mintimeout="${npm_config_fetch_retry_mintimeout:-10000}"
  export npm_config_fetch_retry_maxtimeout="${npm_config_fetch_retry_maxtimeout:-60000}"
  export npm_config_fetch_timeout="${npm_config_fetch_timeout:-120000}"

  case "$MIRROR_MODE" in
    cn|official) ACTIVE_MIRROR="$MIRROR_MODE" ;;
    auto)
      if has_cn_apt_source; then
        ACTIVE_MIRROR="cn"
      else
        local official_time="" mirror_time=""
        official_time=$(probe_download_time "https://registry.npmjs.org/pnpm/latest" || true)
        mirror_time=$(probe_download_time "https://registry.npmmirror.com/pnpm/latest" || true)
        if [[ -n "$mirror_time" ]] && {
          [[ -z "$official_time" ]] ||
          awk -v official="$official_time" -v mirror="$mirror_time" \
            'BEGIN { exit !(official >= 0.8 && mirror * 1.8 < official) }'
        }; then
          ACTIVE_MIRROR="cn"
        fi
      fi
      ;;
    *)
      echo "Invalid --mirror value: $MIRROR_MODE (expected auto, cn, or official)" >&2
      exit 2
      ;;
  esac

  if [[ "$ACTIVE_MIRROR" == "cn" ]]; then
    case "${npm_config_registry:-}" in
      ""|https://registry.npmjs.org|https://registry.npmjs.org/)
        export npm_config_registry="https://registry.npmmirror.com"
        ;;
    esac
    case "${COREPACK_NPM_REGISTRY:-}" in
      ""|https://registry.npmjs.org|https://registry.npmjs.org/)
        export COREPACK_NPM_REGISTRY="https://registry.npmmirror.com"
        ;;
    esac
    case "${PIP_INDEX_URL:-}" in
      ""|https://pypi.org/simple|https://pypi.org/simple/)
        export PIP_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
        ;;
    esac
    export npm_config_network_concurrency="${npm_config_network_concurrency:-8}"
    prepare_cn_apt_source
  fi
  log "Download mirror profile: $ACTIVE_MIRROR"
}

gen_admin_password() {
  openssl rand -base64 18 2>/dev/null | tr -d '/+=' | cut -c1-18
}

ensure_base_packages() {
  if [[ -f /etc/debian_version ]]; then
    log "Installing base packages"
    run_with_log "Refresh APT package index" "/tmp/employee-agent-apt-update.log" \
      sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get "${APT_SOURCE_ARGS[@]}" -o Dpkg::Use-Pty=0 update
    run_with_log "Install base packages" "/tmp/employee-agent-apt-base.log" \
      sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get "${APT_SOURCE_ARGS[@]}" -o Dpkg::Use-Pty=0 install -y \
      git curl ca-certificates openssl python3 python3-venv python3-pip build-essential
    if [[ "$INSTALL_MYSQL" == "true" && "$DB_MODE" == "mysql-auto" ]]; then
      run_with_log "Install MySQL" "/tmp/employee-agent-apt-mysql.log" \
        sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get "${APT_SOURCE_ARGS[@]}" -o Dpkg::Use-Pty=0 install -y mysql-server
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] sudo_cmd systemctl enable --now mysql"
      else
        sudo_cmd systemctl enable --now mysql
      fi
    fi
    if [[ "$INSTALL_DOCKER" == "true" ]]; then
      run_with_log "Install Docker" "/tmp/employee-agent-apt-docker.log" \
        sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get "${APT_SOURCE_ARGS[@]}" -o Dpkg::Use-Pty=0 install -y docker.io
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] sudo_cmd systemctl enable --now docker"
      else
        sudo_cmd systemctl enable --now docker || true
        if [[ "$(id -u)" -ne 0 ]]; then
          sudo_cmd usermod -aG docker "${USER:-$(id -un)}"
        fi
      fi
    fi
  else
    log "Non-Debian system detected; please ensure git/curl/openssl/python3 are installed"
  fi
}

install_jiuwenswarm() {
  if [[ "$INSTALL_JIUWENSWARM" != "true" ]]; then
    log "Skipping JiuwenSwarm runtime installation"
    return
  fi

  log "Installing JiuwenSwarm runtime $JIUWENSWARM_VERSION"
  run python3 -m venv "$JIUWENSWARM_VENV"
  run_with_log "Upgrade Python packaging tools" "/tmp/jiuwenswarm-pip-bootstrap.log" \
    "$JIUWENSWARM_VENV/bin/python" -m pip install --upgrade pip setuptools wheel

  if [[ -n "$JIUWENSWARM_WHEEL_URL" ]]; then
    local wheel_path="/tmp/jiuwenswarm-${JIUWENSWARM_VERSION}.whl"
    run curl -fL --retry 3 -o "$wheel_path" "$JIUWENSWARM_WHEEL_URL"
    if [[ -z "$JIUWENSWARM_WHEEL_SHA256" ]]; then
      echo "JIUWENSWARM_WHEEL_SHA256 is required when installing from a wheel URL." >&2
      exit 1
    fi
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[dry-run] verify JiuwenSwarm wheel SHA-256"
    else
      printf "%s  %s\n" "$JIUWENSWARM_WHEEL_SHA256" "$wheel_path" | sha256sum -c -
    fi
    run_with_log "Install JiuwenSwarm wheel" "/tmp/jiuwenswarm-install.log" \
      "$JIUWENSWARM_VENV/bin/python" -m pip install --upgrade --force-reinstall "$wheel_path"
  else
    run_with_log "Install JiuwenSwarm from AtomGit" "/tmp/jiuwenswarm-install.log" \
      "$JIUWENSWARM_VENV/bin/python" -m pip install --upgrade --force-reinstall \
      "git+${JIUWENSWARM_REPO}@${JIUWENSWARM_REF}"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] verify installed JiuwenSwarm version: $JIUWENSWARM_VERSION"
  else
    JIUWENSWARM_EXPECTED_VERSION="$JIUWENSWARM_VERSION" \
      "$JIUWENSWARM_VENV/bin/python" - <<'PY'
import os

import jiuwenswarm

expected = os.environ["JIUWENSWARM_EXPECTED_VERSION"]
actual = jiuwenswarm.__version__
if actual != expected:
    raise SystemExit(
        f"JiuwenSwarm version mismatch: expected {expected}, installed {actual}"
    )
print(f"  JiuwenSwarm version verified: {actual}")
PY
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] initialize JiuwenSwarm workspace at $JIUWENSWARM_HOME"
  else
    mkdir -p "$JIUWENSWARM_HOME"
    HOME="$HOME" "$JIUWENSWARM_VENV/bin/jiuwenswarm-init" </dev/null
    chmod 700 "$JIUWENSWARM_HOME" "$JIUWENSWARM_HOME/config"
    chmod 600 "$JIUWENSWARM_HOME/config/config.yaml" "$JIUWENSWARM_HOME/config/.env"
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
  local nodesource_command="curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
  if [[ "$(id -u)" -ne 0 ]]; then
    nodesource_command="curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  fi
  run_with_log "Configure NodeSource repository" "/tmp/employee-agent-nodesource.log" \
    bash -o pipefail -c "$nodesource_command"
  run_with_log "Install Node.js 22" "/tmp/employee-agent-apt-node.log" \
    sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Use-Pty=0 install -y nodejs
}

ensure_node_tools() {
  log "Preparing pnpm and pm2"
  run sudo_cmd corepack enable
  run sudo_cmd corepack prepare pnpm@10.34.4 --activate
  if need_cmd pm2; then
    run_with_log "Install PM2" "/tmp/employee-agent-npm-pm2.log" sudo_cmd npm install -g pm2
  fi
}

clone_repo() {
  local target="$1"
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO_URL" "$target"
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
  host_arg="${RESOLVED_HOST:-$(detect_host)}"
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

configure_jiuwenswarm() {
  if [[ "$INSTALL_JIUWENSWARM" != "true" ]]; then return; fi
  log "Configuring JiuwenSwarm for Workforce Agent Platform"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] configure JiuwenSwarm workspace, Platform MCP, callback and isolation"
    return
  fi
  "$JIUWENSWARM_VENV/bin/python" "$INSTALL_DIR/scripts/configure-jiuwenswarm.py" \
    --config "$JIUWENSWARM_HOME/config/config.yaml" \
    --runtime-env "$JIUWENSWARM_HOME/config/.env" \
    --ea-env "$INSTALL_DIR/.env" \
    --port "$PORT"
}

start_app() {
  if [[ "$START_SERVICE" != "true" ]]; then
    log "Skipping build and PM2 start"
    return
  fi
  log "Building and starting Workforce Agent Platform"
  run_with_log "Type check" "/tmp/employee-agent-check.log" bash -lc "cd '$INSTALL_DIR' && corepack pnpm check"
  run_with_log "Build" "/tmp/employee-agent-build.log" bash -lc "cd '$INSTALL_DIR' && corepack pnpm build"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] would start PM2 with ecosystem.config.cjs after setup generates it"
  elif [[ -f "$INSTALL_DIR/ecosystem.config.cjs" ]]; then
    run bash -lc "cd '$INSTALL_DIR' && pm2 start ecosystem.config.cjs --update-env || pm2 restart ecosystem.config.cjs --update-env"
    if [[ "$INSTALL_JIUWENSWARM" == "true" ]]; then
      run bash -lc "cd '$INSTALL_DIR' && HOME='$HOME' JIUWENCLAW_HOME='$JIUWENSWARM_HOME' JIUWENSWARM_PYTHON='$JIUWENSWARM_VENV/bin/python' pm2 start ecosystem.jiuwenswarm.config.cjs --update-env || HOME='$HOME' JIUWENCLAW_HOME='$JIUWENSWARM_HOME' JIUWENSWARM_PYTHON='$JIUWENSWARM_VENV/bin/python' pm2 restart ecosystem.jiuwenswarm.config.cjs --update-env"
    fi
    run pm2 save
  else
    echo "ecosystem.config.cjs was not generated." >&2
    exit 1
  fi
}

enable_pm2_startup() {
  if [[ "$START_SERVICE" != "true" || "$DRY_RUN" == "true" ]]; then return; fi
  local owner home_dir
  owner="${SUDO_USER:-${USER:-$(id -un)}}"
  home_dir=$(getent passwd "$owner" | cut -d: -f6)
  [[ -n "$home_dir" ]] || home_dir="$HOME"
  log "Enabling PM2 startup service"
  sudo_cmd env "PATH=$PATH" pm2 startup systemd -u "$owner" --hp "$home_dir"
  pm2 save
}

wait_for_runtime() {
  if [[ "$START_SERVICE" != "true" || "$DRY_RUN" == "true" ]]; then return; fi
  log "Verifying services"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null
  if [[ "$INSTALL_JIUWENSWARM" == "true" ]]; then
    "$JIUWENSWARM_VENV/bin/python" - <<'PY'
import socket
import time

for port in (18092, 19000):
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                break
        except OSError:
            time.sleep(2)
    else:
        raise SystemExit(f"JiuwenSwarm port {port} did not become ready")
PY
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
  local url="http://${RESOLVED_HOST:-localhost}:${PORT}"
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    url=$(grep '^FRONTEND_URL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "$url")
  fi
  cat <<EOF

─────────────────────────────────
Workforce Agent Platform bootstrap completed.
─────────────────────────────────

Install dir:
  $INSTALL_DIR

Reverse proxy target:
  http://127.0.0.1:${PORT}

Configured public URL (requires HTTPS reverse proxy):
  $url

The application remains bound to 127.0.0.1. Expose it through an HTTPS reverse
proxy, or use an SSH tunnel for local testing.

Default admin:
  Email:    ${ADMIN_EMAIL}
  Password: ${ADMIN_PASSWORD_DISPLAY:-"(not created or skipped)"}

Change this password immediately after first login.

Health checks:
  curl http://127.0.0.1:${PORT}/health
  curl http://127.0.0.1:${PORT}/api/brand

JiuwenSwarm runtime:
  Version:  ${JIUWENSWARM_VERSION}
  Home:     ${JIUWENSWARM_HOME}
  Python:   ${JIUWENSWARM_VENV}/bin/python

EOF
}

main() {
  log "Workforce Agent Platform bootstrap installer"
  INSTALL_STARTED_AT=$(date +%s)
  ensure_install_id
  trap 'finish_install "$?"' EXIT
  telemetry_event "started"
  INSTALL_STAGE="mirror-selection"
  configure_download_mirrors
  INSTALL_STAGE="base-packages"
  ensure_base_packages
  INSTALL_STAGE="node-runtime"
  ensure_node
  INSTALL_STAGE="node-tools"
  ensure_node_tools
  INSTALL_STAGE="public-host"
  RESOLVED_HOST=$(detect_host)
  INSTALL_STAGE="source-checkout"
  checkout_repo
  INSTALL_STAGE="jiuwenswarm"
  install_jiuwenswarm
  INSTALL_STAGE="application-setup"
  run_setup
  INSTALL_STAGE="jiuwenswarm-config"
  configure_jiuwenswarm
  INSTALL_STAGE="admin-account"
  create_default_admin
  INSTALL_STAGE="application-build"
  start_app
  INSTALL_STAGE="startup-service"
  enable_pm2_startup
  INSTALL_STAGE="health-check"
  wait_for_runtime
  INSTALL_STAGE="summary"
  print_summary
}

main
