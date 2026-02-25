#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[tfclaw-docker] %s\n' "$*"
}

fail() {
  printf '[tfclaw-docker] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  fail "Please run as root in the container."
fi

ACTION="${1:-start}"

INSTALL_DIR="${TFCLAW_INSTALL_DIR:-/opt/token-free-claw}"
STATE_DIR="${TFCLAW_STATE_DIR:-/opt/tfclaw-state}"
REPO_URL="${TFCLAW_REPO_URL:-https://github.com/yxzwang/TFClaw.git}"
REPO_REF="${TFCLAW_REPO_REF:-main}"
SERVER_HOST="${TFCLAW_SERVER_HOST:-0.0.0.0}"
SERVER_PORT="${TFCLAW_SERVER_PORT:-8787}"
WS_PATH="${TFCLAW_WS_PATH:-/}"
ENABLE_TUNNEL="${TFCLAW_ENABLE_CLOUDFLARE_TUNNEL:-1}"
TOKEN_INPUT="${TFCLAW_TOKEN:-}"
ARCH="$(dpkg --print-architecture)"

SERVER_LOG="${TFCLAW_SERVER_LOG:-/var/log/tfclaw-server.log}"
TUNNEL_LOG="${TFCLAW_TUNNEL_LOG:-/var/log/tfclaw-cloudflared.log}"
RUNTIME_ENV="$STATE_DIR/runtime.env"

TFCLAW_RUNTIME_TOKEN=""
TFCLAW_RUNTIME_RELAY_URL=""

install_packages() {
  log "Installing base packages ..."
  apt-get update
  apt-get install -y ca-certificates curl git jq gnupg openssl procps
}

install_nodejs() {
  if command -v node >/dev/null 2>&1; then
    local node_major
    node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "$node_major" -ge 20 ]]; then
      log "Node.js $(node -v) already installed."
      return
    fi
  fi

  log "Installing Node.js 20.x ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

install_cloudflared() {
  if [[ "$ENABLE_TUNNEL" != "1" ]]; then
    log "Cloudflare tunnel disabled (TFCLAW_ENABLE_CLOUDFLARE_TUNNEL=$ENABLE_TUNNEL)."
    return
  fi

  if command -v cloudflared >/dev/null 2>&1; then
    log "cloudflared already installed."
    return
  fi

  local file
  case "$ARCH" in
    amd64) file="cloudflared-linux-amd64.deb" ;;
    arm64) file="cloudflared-linux-arm64.deb" ;;
    *) fail "Unsupported architecture '$ARCH'. Use amd64 or arm64." ;;
  esac

  log "Installing cloudflared ($ARCH) ..."
  local tmp_deb
  tmp_deb="$(mktemp /tmp/cloudflared.XXXXXX.deb)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${file}" -o "$tmp_deb"
  dpkg -i "$tmp_deb" || apt-get install -f -y
  rm -f "$tmp_deb"
}

prepare_source() {
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -f "$INSTALL_DIR/package.json" ]]; then
    log "Using existing source at $INSTALL_DIR"
    return
  fi

  log "Cloning $REPO_URL ($REPO_REF) into $INSTALL_DIR ..."
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
}

build_server() {
  log "Installing npm dependencies ..."
  cd "$INSTALL_DIR"
  npm ci

  log "Building protocol and server ..."
  npm run build --workspace @tfclaw/protocol
  npm run build --workspace @tfclaw/server
}

ensure_state() {
  mkdir -p "$STATE_DIR" "$(dirname "$SERVER_LOG")" "$(dirname "$TUNNEL_LOG")"
  touch "$SERVER_LOG"
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    touch "$TUNNEL_LOG"
  fi
}

load_previous_runtime() {
  if [[ -f "$RUNTIME_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$RUNTIME_ENV"
  fi
}

resolve_token() {
  load_previous_runtime

  if [[ -n "$TOKEN_INPUT" ]]; then
    TFCLAW_RUNTIME_TOKEN="$TOKEN_INPUT"
  elif [[ -n "${TFCLAW_TOKEN:-}" ]]; then
    TFCLAW_RUNTIME_TOKEN="$TFCLAW_TOKEN"
  else
    TFCLAW_RUNTIME_TOKEN="$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  fi

  if [[ "${#TFCLAW_RUNTIME_TOKEN}" -lt 24 ]]; then
    fail "TFCLAW_TOKEN is too short. Use at least 24 chars (recommended 32+)."
  fi
}

stop_processes() {
  local pids=()
  local maybe_pids=(
    "${TFCLAW_SERVER_PID:-}"
    "${TFCLAW_TUNNEL_PID:-}"
  )

  for pid in "${maybe_pids[@]}"; do
    if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]]; then
      if kill -0 "$pid" >/dev/null 2>&1; then
        pids+=("$pid")
      fi
    fi
  done

  if [[ "${#pids[@]}" -gt 0 ]]; then
    log "Stopping tracked processes: ${pids[*]}"
    kill "${pids[@]}" >/dev/null 2>&1 || true
    sleep 1
  fi

  pkill -f 'apps/server/dist/index.js' >/dev/null 2>&1 || true
  pkill -f 'cloudflared tunnel --no-autoupdate --url http://127.0.0.1:' >/dev/null 2>&1 || true
}

is_pid_running() {
  local pid="${1:-}"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  kill -0 "$pid" >/dev/null 2>&1
}

is_server_running() {
  if is_pid_running "${TFCLAW_SERVER_PID:-}"; then
    return 0
  fi
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f 'apps/server/dist/index.js' >/dev/null 2>&1
    return $?
  fi
  return 1
}

is_tunnel_running() {
  if is_pid_running "${TFCLAW_TUNNEL_PID:-}"; then
    return 0
  fi
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f 'cloudflared tunnel --no-autoupdate --url http://127.0.0.1:' >/dev/null 2>&1
    return $?
  fi
  return 1
}

discover_tunnel_url() {
  local url=""
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    for _ in {1..30}; do
      url="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -n 1 || true)"
      [[ -n "$url" ]] && break
      sleep 2
    done
  fi
  echo "$url"
}

start_server() {
  log "Starting tfclaw server ..."
  nohup env \
    RELAY_PORT="$SERVER_PORT" \
    RELAY_HOST="$SERVER_HOST" \
    RELAY_WS_PATH="$WS_PATH" \
    RELAY_ENFORCE_STRONG_TOKEN=true \
    RELAY_ALLOWED_TOKENS="$TFCLAW_RUNTIME_TOKEN" \
    RELAY_MAX_MESSAGE_BYTES=262144 \
    RELAY_MAX_CONNECTIONS=200 \
    RELAY_MAX_CONNECTIONS_PER_IP=30 \
    RELAY_MAX_SESSIONS=50 \
    RELAY_MAX_CLIENTS_PER_SESSION=8 \
    RELAY_MESSAGE_RATE_WINDOW_MS=10000 \
    RELAY_MAX_MESSAGES_PER_WINDOW=200 \
    RELAY_UPGRADE_RATE_WINDOW_MS=60000 \
    RELAY_MAX_UPGRADES_PER_WINDOW_PER_IP=120 \
    RELAY_HEARTBEAT_INTERVAL_MS=25000 \
    RELAY_IDLE_TIMEOUT_MS=150000 \
    NODE_ENV=production \
    node apps/server/dist/index.js >>"$SERVER_LOG" 2>&1 &
  TFCLAW_SERVER_PID="$!"
}

start_tunnel() {
  TFCLAW_TUNNEL_PID=""
  if [[ "$ENABLE_TUNNEL" != "1" ]]; then
    TFCLAW_RUNTIME_RELAY_URL="ws://127.0.0.1:$SERVER_PORT"
    return
  fi

  log "Starting cloudflared quick tunnel ..."
  nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$SERVER_PORT" >>"$TUNNEL_LOG" 2>&1 &
  TFCLAW_TUNNEL_PID="$!"

  local tunnel_url
  tunnel_url="$(discover_tunnel_url)"
  if [[ -n "$tunnel_url" ]]; then
    TFCLAW_RUNTIME_RELAY_URL="wss://${tunnel_url#https://}"
  else
    TFCLAW_RUNTIME_RELAY_URL=""
  fi
}

assert_server_started() {
  sleep 1
  if is_server_running; then
    return
  fi

  echo
  echo "Server failed to stay running. Recent log output:"
  tail -n 120 "$SERVER_LOG" || true
  fail "Server startup check failed."
}

write_runtime_env() {
  cat >"$RUNTIME_ENV" <<EOF
TFCLAW_TOKEN=$TFCLAW_RUNTIME_TOKEN
TFCLAW_RELAY_URL=$TFCLAW_RUNTIME_RELAY_URL
TFCLAW_SERVER_PID=${TFCLAW_SERVER_PID:-}
TFCLAW_TUNNEL_PID=${TFCLAW_TUNNEL_PID:-}
TFCLAW_SERVER_LOG=$SERVER_LOG
TFCLAW_TUNNEL_LOG=$TUNNEL_LOG
EOF
}

show_status() {
  load_previous_runtime
  echo "runtime_file=$RUNTIME_ENV"
  echo "server_running=$(is_server_running && echo yes || echo no)"
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    echo "tunnel_running=$(is_tunnel_running && echo yes || echo no)"
  else
    echo "tunnel_running=disabled"
  fi
  if [[ -f "$RUNTIME_ENV" ]]; then
    echo "TFCLAW_TOKEN=${TFCLAW_TOKEN:-}"
    echo "TFCLAW_RELAY_URL=${TFCLAW_RELAY_URL:-}"
  fi
}

show_result() {
  echo
  echo "TFCLAW_TOKEN=$TFCLAW_RUNTIME_TOKEN"
  if [[ -n "$TFCLAW_RUNTIME_RELAY_URL" ]]; then
    echo "TFCLAW_RELAY_URL=$TFCLAW_RUNTIME_RELAY_URL"
  else
    echo "TFCLAW_RELAY_URL=(pending, check: tail -f $TUNNEL_LOG)"
  fi
  echo "runtime_file=$RUNTIME_ENV"
  echo "server_log=$SERVER_LOG"
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    echo "tunnel_log=$TUNNEL_LOG"
  fi
  echo
  echo "Tip: run '$0 status' to inspect runtime state."
}

start_flow() {
  install_packages
  install_nodejs
  install_cloudflared
  prepare_source
  build_server
  ensure_state
  resolve_token
  stop_processes
  start_server
  assert_server_started
  start_tunnel
  write_runtime_env
  show_result
}

logs_flow() {
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    tail -n 120 -f "$SERVER_LOG" "$TUNNEL_LOG"
  else
    tail -n 120 -f "$SERVER_LOG"
  fi
}

case "$ACTION" in
  start)
    start_flow
    ;;
  stop)
    load_previous_runtime
    stop_processes
    log "Stopped."
    ;;
  status)
    show_status
    ;;
  logs)
    logs_flow
    ;;
  *)
    fail "Unknown action '$ACTION'. Use: start | stop | status | logs"
    ;;
esac
