#!/usr/bin/env bash
set -euo pipefail

# Workforce Agent Platform setup script.
# Interactive:
#   bash setup.sh
# Non-interactive:
#   bash setup.sh --auto --host 1.2.3.4 --db-mode mysql-auto

ENV_FILE=".env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTO=false
YES=false
OVERWRITE_ENV=false
SKIP_INSTALL=false
SKIP_DB_PUSH=false
PORT_VALUE="${WORKFORCE_AGENT_PORT:-${LINGXIA_PORT:-5180}}"
HOST_VALUE="${WORKFORCE_AGENT_HOST:-${LINGXIA_HOST:-}}"
DOMAIN_VALUE="${WORKFORCE_AGENT_DOMAIN:-${LINGXIA_DOMAIN:-}}"
FRONTEND_URL_VALUE="${WORKFORCE_AGENT_FRONTEND_URL:-${LINGXIA_FRONTEND_URL:-}}"
DB_MODE_VALUE="${WORKFORCE_AGENT_DB_MODE:-${LINGXIA_DB_MODE:-}}"
DB_HOST_VALUE="${WORKFORCE_AGENT_DB_HOST:-${LINGXIA_DB_HOST:-localhost}}"
DB_PORT_VALUE="${WORKFORCE_AGENT_DB_PORT:-${LINGXIA_DB_PORT:-3306}}"
DB_USER_VALUE="${WORKFORCE_AGENT_DB_USER:-${LINGXIA_DB_USER:-employee_agent}}"
DB_PASS_VALUE="${WORKFORCE_AGENT_DB_PASSWORD:-${LINGXIA_DB_PASSWORD:-}}"
DB_NAME_VALUE="${WORKFORCE_AGENT_DB_NAME:-${LINGXIA_DB_NAME:-employee_agent}}"
JIUWEN_RUNTIME_ENABLED_VALUE="${JIUWENSWARM_PROVISION_ENABLED:-${JIUWENCLAW_PROVISION_ENABLED:-}}"
JIUWENSWARM_HOME_VALUE="${JIUWENCLAW_HOME:-$HOME/.jiuwenswarm}"
JIUWENSWARM_PYTHON_VALUE="${JIUWENSWARM_PYTHON:-$HOME/.venvs/employee-agent-jiuwenswarm/bin/python}"

usage() {
  cat <<'EOF'
Usage: bash setup.sh [options]

Options:
  --auto                         Run without prompts.
  --yes                          Accept defaults for non-dangerous prompts.
  --overwrite-env                Replace existing .env.
  --port <port>                  App port, default 5180.
  --host <ip-or-host>            HTTP host, e.g. 203.0.113.10.
  --domain <domain>              HTTPS domain, e.g. ai.company.com.
  --frontend-url <url>           Full frontend URL. Overrides --host/--domain.
  --db-mode <mode>               compose | existing | mysql-auto. Default: compose interactive, mysql-auto auto.
  --db-host <host>               Existing MySQL host.
  --db-port <port>               Existing MySQL port.
  --db-user <user>               Existing MySQL user.
  --db-password <password>       Existing MySQL password.
  --db-name <name>               Existing MySQL database.
  --skip-install                 Do not install pnpm dependencies.
  --skip-db-push                 Do not run database migrations.
  -h, --help                     Show this help.

Environment variables mirror the options with WORKFORCE_AGENT_ prefix, for example:
  WORKFORCE_AGENT_HOST=1.2.3.4 WORKFORCE_AGENT_DB_MODE=mysql-auto bash setup.sh --auto
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto) AUTO=true; shift ;;
    --yes|-y) YES=true; shift ;;
    --overwrite-env) OVERWRITE_ENV=true; shift ;;
    --port) PORT_VALUE="${2:?missing --port value}"; shift 2 ;;
    --host) HOST_VALUE="${2:?missing --host value}"; shift 2 ;;
    --domain) DOMAIN_VALUE="${2:?missing --domain value}"; shift 2 ;;
    --frontend-url) FRONTEND_URL_VALUE="${2:?missing --frontend-url value}"; shift 2 ;;
    --db-mode) DB_MODE_VALUE="${2:?missing --db-mode value}"; shift 2 ;;
    --db-host) DB_HOST_VALUE="${2:?missing --db-host value}"; shift 2 ;;
    --db-port) DB_PORT_VALUE="${2:?missing --db-port value}"; shift 2 ;;
    --db-user) DB_USER_VALUE="${2:?missing --db-user value}"; shift 2 ;;
    --db-password) DB_PASS_VALUE="${2:?missing --db-password value}"; shift 2 ;;
    --db-name) DB_NAME_VALUE="${2:?missing --db-name value}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=true; shift ;;
    --skip-db-push) SKIP_DB_PUSH=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

echo ""
echo "  岗位智能体平台 — 初始化配置"
echo "  ─────────────────────────────────"
echo ""

gen_secret() { openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64; }
gen_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p; }

pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    echo "pnpm not found. Install it with: corepack enable && corepack prepare pnpm@10.34.4 --activate" >&2
    return 127
  fi
}

ask() {
  local prompt="$1"
  local default="$2"
  local answer=""
  if [[ "$AUTO" == "true" ]]; then
    echo "$default"
    return
  fi
  read -rp "$prompt" answer
  echo "${answer:-$default}"
}

ask_secret() {
  local prompt="$1"
  local default="$2"
  local answer=""
  if [[ "$AUTO" == "true" ]]; then
    echo "$default"
    return
  fi
  read -rsp "$prompt" answer
  echo "" >&2
  echo "${answer:-$default}"
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

detect_ip() {
  if [[ -n "$HOST_VALUE" ]]; then
    echo "$HOST_VALUE"
    return
  fi
  local detected=""
  detected=$(detect_public_ipv4)
  if [[ -z "$detected" ]]; then
    echo "Warning: public IPv4 detection failed; using localhost. Pass --host to configure an external URL." >&2
  fi
  echo "${detected:-localhost}"
}

mysql_root_exec() {
  if [[ "$(id -u)" -eq 0 ]]; then
    mysql "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo mysql "$@"
  else
    mysql "$@"
  fi
}

mysql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

SKIP_ENV=false
if [[ -f "$ENV_FILE" && "$OVERWRITE_ENV" != "true" ]]; then
  if [[ "$AUTO" == "true" || "$YES" == "true" ]]; then
    echo "检测到已有 .env，保持不覆盖。可用 --overwrite-env 强制重写。"
    SKIP_ENV=true
  else
    echo "检测到已有 .env 文件。"
    overwrite=$(ask "覆盖？(y/N) " "N")
    if [[ "$overwrite" != "y" && "$overwrite" != "Y" ]]; then
      echo "跳过 .env 生成，继续后续步骤..."
      SKIP_ENV=true
    fi
  fi
fi

if [[ "$SKIP_ENV" != "true" ]]; then
  echo "Step 1/3: 配置环境变量"
  echo ""

  PORT_VALUE=$(ask "  应用端口 [$PORT_VALUE]: " "$PORT_VALUE")

  ACCESS_MODE="1"
  if [[ -n "$FRONTEND_URL_VALUE" ]]; then
    ACCESS_MODE="custom"
  elif [[ -n "$DOMAIN_VALUE" ]]; then
    ACCESS_MODE="3"
  elif [[ -n "$HOST_VALUE" || "$AUTO" == "true" ]]; then
    ACCESS_MODE="2"
  elif [[ "$AUTO" != "true" ]]; then
    echo ""
    echo "  访问方式:"
    echo "    1. 本机访问 (localhost)"
    echo "    2. IP 访问"
    echo "    3. 域名访问"
    ACCESS_MODE=$(ask "  选择 [1]: " "1")
  fi

  case "$ACCESS_MODE" in
    custom)
      FRONTEND_URL="$FRONTEND_URL_VALUE"
      CORS_ORIGIN="$FRONTEND_URL_VALUE"
      COOKIE_DOMAIN=""
      DEMO_DOMAIN=""
      ;;
    2)
      LAN_IP=$(detect_ip)
      if [[ "$AUTO" != "true" && -z "$HOST_VALUE" ]]; then
        LAN_IP=$(ask "  IP [$LAN_IP]: " "$LAN_IP")
      fi
      FRONTEND_URL="http://${LAN_IP}:${PORT_VALUE}"
      CORS_ORIGIN="$FRONTEND_URL"
      COOKIE_DOMAIN=""
      DEMO_DOMAIN=""
      ;;
    3)
      if [[ -z "$DOMAIN_VALUE" ]]; then
        DOMAIN_VALUE=$(ask "  域名 (如 ai.company.com): " "")
      fi
      FRONTEND_URL="https://${DOMAIN_VALUE}"
      CORS_ORIGIN="$FRONTEND_URL"
      COOKIE_DOMAIN=".${DOMAIN_VALUE}"
      DEMO_DOMAIN="demo.${DOMAIN_VALUE}"
      ;;
    *)
      FRONTEND_URL="http://localhost:${PORT_VALUE}"
      CORS_ORIGIN="$FRONTEND_URL"
      COOKIE_DOMAIN=""
      DEMO_DOMAIN=""
      ;;
  esac

  echo ""
  if [[ -z "$DB_MODE_VALUE" ]]; then
    if [[ "$AUTO" == "true" ]]; then
      DB_MODE_VALUE="mysql-auto"
    else
      echo "  数据库:"
      echo "    1. Docker Compose 自带 MySQL"
      echo "    2. 使用已有的 MySQL"
      echo "    3. 本机 MySQL 自动创建数据库和用户"
      db_choice=$(ask "  选择 [1]: " "1")
      case "$db_choice" in
        2) DB_MODE_VALUE="existing" ;;
        3) DB_MODE_VALUE="mysql-auto" ;;
        *) DB_MODE_VALUE="compose" ;;
      esac
    fi
  fi

  MYSQL_ROOT_PASSWORD=""
  case "$DB_MODE_VALUE" in
    existing)
      DB_HOST_VALUE=$(ask "  MySQL 地址 [$DB_HOST_VALUE]: " "$DB_HOST_VALUE")
      DB_PORT_VALUE=$(ask "  MySQL 端口 [$DB_PORT_VALUE]: " "$DB_PORT_VALUE")
      DB_USER_VALUE=$(ask "  MySQL 用户 [$DB_USER_VALUE]: " "$DB_USER_VALUE")
      DB_PASS_VALUE=$(ask_secret "  MySQL 密码: " "$DB_PASS_VALUE")
      DB_NAME_VALUE=$(ask "  数据库名 [$DB_NAME_VALUE]: " "$DB_NAME_VALUE")
      DATABASE_URL="mysql://${DB_USER_VALUE}:${DB_PASS_VALUE}@${DB_HOST_VALUE}:${DB_PORT_VALUE}/${DB_NAME_VALUE}"
      ;;
    mysql-auto)
      DB_PASS_VALUE="${DB_PASS_VALUE:-$(gen_hex 16)}"
      DATABASE_URL="mysql://${DB_USER_VALUE}:${DB_PASS_VALUE}@localhost:${DB_PORT_VALUE}/${DB_NAME_VALUE}"
      if command -v mysql >/dev/null 2>&1; then
        echo "  正在准备本机 MySQL 数据库和用户..."
        if mysql_root_exec <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME_VALUE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER_VALUE}'@'localhost' IDENTIFIED BY '$(mysql_quote "$DB_PASS_VALUE")';
ALTER USER '${DB_USER_VALUE}'@'localhost' IDENTIFIED BY '$(mysql_quote "$DB_PASS_VALUE")';
GRANT ALL PRIVILEGES ON \`${DB_NAME_VALUE}\`.* TO '${DB_USER_VALUE}'@'localhost';
FLUSH PRIVILEGES;
SQL
        then
          echo "  MySQL 数据库已准备。"
        else
          echo "  MySQL 自动创建失败。请确认 mysql-server 已安装，并手工创建 DATABASE_URL 对应账号。" >&2
          exit 1
        fi
      else
        echo "  mysql 命令不存在，无法使用 mysql-auto 模式。" >&2
        exit 1
      fi
      ;;
    compose)
      MYSQL_ROOT_PASSWORD=$(gen_hex 12)
      DB_PASS_VALUE="${DB_PASS_VALUE:-$(gen_hex 16)}"
      DATABASE_URL="mysql://${DB_USER_VALUE}:${DB_PASS_VALUE}@db:3306/${DB_NAME_VALUE}"
      echo "  Docker Compose MySQL 密码已自动生成。"
      ;;
    *)
      echo "Unsupported --db-mode: $DB_MODE_VALUE" >&2
      exit 2
      ;;
  esac

  JWT_SECRET=$(gen_secret)
  TENANT_SECRET=$(gen_hex 32)
  INTERNAL_API_KEY=$(gen_hex 32)
  CREDENTIAL_ENCRYPTION_KEY=$(gen_hex 32)
  if [[ -z "$JIUWEN_RUNTIME_ENABLED_VALUE" ]]; then
    if [[ -f "$HOME/.jiuwenswarm/config/config.yaml" || -f "$HOME/.jiuwenclaw/config/config.yaml" ]]; then
      JIUWEN_RUNTIME_ENABLED_VALUE=true
    else
      JIUWEN_RUNTIME_ENABLED_VALUE=false
    fi
  fi

  {
    echo "# ── 岗位智能体平台配置（由 setup.sh 生成）──"
    echo "PORT=$PORT_VALUE"
    echo "APP_BIND_IP=127.0.0.1"
    echo ""
    echo "# 访问"
    echo "FRONTEND_URL=$FRONTEND_URL"
    echo "CORS_ORIGIN=$CORS_ORIGIN"
    echo "COOKIE_DOMAIN=$COOKIE_DOMAIN"
    echo ""
    echo "# 数据库"
    echo "DATABASE_URL=$DATABASE_URL"
    [[ -n "$MYSQL_ROOT_PASSWORD" ]] && echo "MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD"
    if [[ "$DB_MODE_VALUE" == "compose" ]]; then
      echo "MYSQL_DATABASE=$DB_NAME_VALUE"
      echo "MYSQL_USER=$DB_USER_VALUE"
      echo "MYSQL_PASSWORD=$DB_PASS_VALUE"
    fi
    echo ""
    echo "# 认证与安全"
    echo "JWT_SECRET=$JWT_SECRET"
    echo "TENANT_SECRET=$TENANT_SECRET"
    echo "INTERNAL_API_KEY=$INTERNAL_API_KEY"
    echo "CREDENTIAL_ENCRYPTION_KEY=$CREDENTIAL_ENCRYPTION_KEY"
    echo "EMAIL_VERIFICATION_REQUIRED=false"
    echo ""
    echo "# Agent Runtime: JiuwenSwarm first; no implicit OpenClaw fallback"
    echo "JIUWENSWARM_PROVISION_ENABLED=$JIUWEN_RUNTIME_ENABLED_VALUE"
    echo "JIUWENCLAW_RUNTIME_ENABLED=$JIUWEN_RUNTIME_ENABLED_VALUE"
    echo "JIUWENCLAW_CHAT_TRANSPORT=gateway"
    echo "JIUWENCLAW_HOME=$JIUWENSWARM_HOME_VALUE"
    echo "JIUWENSWARM_DATA_DIR=$JIUWENSWARM_HOME_VALUE"
    echo "JIUWENSWARM_CONFIG_PATH=$JIUWENSWARM_HOME_VALUE/config/config.yaml"
    echo "JIUWENSWARM_PYTHON=$JIUWENSWARM_PYTHON_VALUE"
    echo "JIUWENCLAW_AGENTSERVER_WS_URL=ws://127.0.0.1:18092"
    echo "JIUWENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:19000/ws"
    echo "CLAW_PROVISION_MODE=mock"
    echo "CLAW_CHAT_MODE=mock"
    echo "WORKFORCE_AGENT_INTERNAL_BASE_URL=http://127.0.0.1:$PORT_VALUE"
    echo ""
    echo "# 岗位智能体平台路由"
    [[ -n "$DEMO_DOMAIN" ]] && echo "LINGGAN_CLAW_BASE_DOMAIN=$DEMO_DOMAIN"
    [[ -n "$DEMO_DOMAIN" ]] && echo "DEMO_ROUTE_DOMAIN=$DEMO_DOMAIN"
    [[ -n "$COOKIE_DOMAIN" ]] && echo "LINGGAN_CLAW_ENTRY_SCHEME=https" || echo "LINGGAN_CLAW_ENTRY_SCHEME=http"
    echo ""
    echo "# 业务 Agent 预置默认关闭，新环境可在后台自行配置"
    echo "ENABLE_BUILTIN_BUSINESS_AGENT_PRESETS=false"
    echo ""
    echo "# 实验工作台默认关闭"
    echo "TASK_WORKBENCH_LAB_ENABLED=false"
    echo "TASK_WORKBENCH_LAB_ALLOW_USER_IDS="
    echo "TASK_WORKBENCH_LAB_MAX_AGENTS=3"
    echo ""
    echo "# 平台记忆（需要 DEEPSEEK_API_KEY）"
    echo "MEMORY_ENABLED=true"
    echo "MEMORY_EXTRACT_INTERVAL=5"
    echo "# DEEPSEEK_API_KEY="
    echo ""
    echo "# 沙箱"
    echo "SANDBOX_IMAGE=python:3.11-slim"
    echo "SANDBOX_MEMORY=256m"
    echo "SANDBOX_CPUS=0.5"
    echo "SANDBOX_PIDS_LIMIT=50"
    echo "SANDBOX_TMPFS_SIZE=50m"
    echo "SANDBOX_EXEC_TIMEOUT_MS=10000"
    echo "SANDBOX_MAX_OUTPUT_BYTES=65536"
    echo "SANDBOX_MAX_GLOBAL=5"
    echo "SANDBOX_MAX_PER_USER=2"
  } > "$ENV_FILE"

  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo ""
  echo "  .env 已生成。"
fi

echo ""
echo "Step 2/3: 安装依赖"
if [[ "$SKIP_INSTALL" == "true" ]]; then
  echo "  已跳过依赖安装。"
else
  if pnpm_cmd install --frozen-lockfile --reporter="${PNPM_REPORTER:-append-only}" 2>/dev/null || pnpm_cmd install --reporter="${PNPM_REPORTER:-append-only}"; then
    echo "  依赖已安装。"
  else
    echo "  依赖安装失败，请检查 Node.js / pnpm。"
    exit 1
  fi
fi

if [[ ! -f "ecosystem.config.cjs" && -f "ecosystem.config.cjs.example" ]]; then
  cp ecosystem.config.cjs.example ecosystem.config.cjs
  echo "  已生成 PM2 配置 ecosystem.config.cjs"
fi
if [[ ! -f "ecosystem.jiuwenswarm.config.cjs" && -f "ecosystem.jiuwenswarm.config.cjs.example" ]]; then
  cp ecosystem.jiuwenswarm.config.cjs.example ecosystem.jiuwenswarm.config.cjs
  echo "  已生成 JiuwenSwarm PM2 配置 ecosystem.jiuwenswarm.config.cjs"
fi

echo ""
echo "Step 3/3: 数据库迁移"
DB_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
if [[ "$SKIP_DB_PUSH" == "true" ]]; then
  echo "  已跳过数据库迁移。"
elif [[ "$DB_URL" == *"@db:"* ]]; then
  echo "  Docker Compose 数据库，请先: docker compose up -d db"
  echo "  然后运行: pnpm db:push"
else
  if pnpm_cmd exec drizzle-kit push --force; then
    echo "  数据库迁移完成。"
  else
    echo "  迁移失败，请检查 DATABASE_URL。" >&2
    exit 1
  fi
fi

echo ""
echo "  ─────────────────────────────────"
echo "  岗位智能体平台初始化完成！"
echo "  ─────────────────────────────────"
echo ""
echo "  启动方式："
echo "    pnpm build && pnpm start"
echo "    pm2 start ecosystem.config.cjs"
echo ""
echo "  配置的前端 URL: $(grep '^FRONTEND_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo 'http://localhost:5180')"
echo "  本机监听: http://127.0.0.1:${PORT_VALUE}（对外访问请配置 HTTPS 反向代理）"
echo "  创建首个管理员:"
echo "    pnpm tsx scripts/init-admin.ts --email=admin@example.com --password='请换成强密码' --name='Admin'"
echo ""
