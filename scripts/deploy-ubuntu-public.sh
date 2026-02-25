#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Please run as root: sudo bash $0" >&2
  exit 1
fi

log() {
  printf '[tfclaw-deploy] %s\n' "$*"
}

fail() {
  printf '[tfclaw-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

INSTALL_DIR="${TFCLAW_INSTALL_DIR:-/opt/token-free-claw}"
REPO_URL="${TFCLAW_REPO_URL:-https://github.com/yxzwang/TFClaw.git}"
REPO_REF="${TFCLAW_REPO_REF:-main}"
SERVER_HOST="${TFCLAW_SERVER_HOST:-127.0.0.1}"
SERVER_PORT="${TFCLAW_SERVER_PORT:-8787}"
WS_PATH="${TFCLAW_WS_PATH:-/}"
ENABLE_TUNNEL="${TFCLAW_ENABLE_CLOUDFLARE_TUNNEL:-1}"
TOKEN="${TFCLAW_TOKEN:-}"
ARCH="$(dpkg --print-architecture)"

SERVER_SERVICE_NAME="tfclaw-server"
TUNNEL_SERVICE_NAME="tfclaw-cloudflared"
ENV_FILE="/etc/tfclaw/server.env"

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemd is required. In WSL, enable systemd first."
  fi
  if ! systemctl list-unit-files >/dev/null 2>&1; then
    fail "systemd is not active. In WSL, set /etc/wsl.conf with '[boot] systemd=true', run 'wsl --shutdown' on Windows, then reopen Ubuntu."
  fi
}

install_packages() {
  log "Installing base packages ..."
  apt-get update
  apt-get install -y ca-certificates curl git jq gnupg openssl
}

install_nodejs() {
  if command -v node >/dev/null 2>&1; then
    local node_major
    node_major="$(node -p "process.versions.node.split('.')[0]")"
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
    log "Cloudflare Tunnel disabled (TFCLAW_ENABLE_CLOUDFLARE_TUNNEL=$ENABLE_TUNNEL)."
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
  if [[ -d "$INSTALL_DIR/.git" || -f "$INSTALL_DIR/package.json" ]]; then
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

configure_runtime() {
  if ! id tfclaw >/dev/null 2>&1; then
    log "Creating service user 'tfclaw' ..."
    useradd --system --home /var/lib/tfclaw --create-home --shell /usr/sbin/nologin tfclaw
  fi

  chown -R tfclaw:tfclaw "$INSTALL_DIR"
  mkdir -p /etc/tfclaw
  chmod 750 /etc/tfclaw

  if [[ -z "$TOKEN" ]]; then
    TOKEN="$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  fi
  if [[ "${#TOKEN}" -lt 24 ]]; then
    fail "TFCLAW_TOKEN is too short. Use at least 24 chars (recommended 32+)."
  fi

  cat >"$ENV_FILE" <<EOF
PORT=$SERVER_PORT
RELAY_HOST=$SERVER_HOST
RELAY_WS_PATH=$WS_PATH
RELAY_ENFORCE_STRONG_TOKEN=true
RELAY_ALLOWED_TOKENS=$TOKEN
RELAY_MAX_MESSAGE_BYTES=262144
RELAY_MAX_CONNECTIONS=200
RELAY_MAX_CONNECTIONS_PER_IP=30
RELAY_MAX_SESSIONS=50
RELAY_MAX_CLIENTS_PER_SESSION=8
RELAY_MESSAGE_RATE_WINDOW_MS=10000
RELAY_MAX_MESSAGES_PER_WINDOW=200
RELAY_UPGRADE_RATE_WINDOW_MS=60000
RELAY_MAX_UPGRADES_PER_WINDOW_PER_IP=120
RELAY_HEARTBEAT_INTERVAL_MS=25000
RELAY_IDLE_TIMEOUT_MS=150000
NODE_ENV=production
EOF

  chmod 640 "$ENV_FILE"
  chown root:tfclaw "$ENV_FILE"
}

install_server_service() {
  cat >/etc/systemd/system/${SERVER_SERVICE_NAME}.service <<EOF
[Unit]
Description=TFClaw Relay Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tfclaw
Group=tfclaw
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/var/lib/tfclaw
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${SERVER_SERVICE_NAME}.service"
  systemctl --no-pager --full status "${SERVER_SERVICE_NAME}.service" | sed -n '1,10p'
}

install_tunnel_service() {
  if [[ "$ENABLE_TUNNEL" != "1" ]]; then
    return
  fi

  cat >/etc/systemd/system/${TUNNEL_SERVICE_NAME}.service <<EOF
[Unit]
Description=TFClaw Cloudflare Quick Tunnel
After=network-online.target ${SERVER_SERVICE_NAME}.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$SERVER_PORT
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${TUNNEL_SERVICE_NAME}.service"
}

discover_tunnel_url() {
  local tunnel_url=""
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    for _ in {1..30}; do
      tunnel_url="$(
        journalctl -u "${TUNNEL_SERVICE_NAME}.service" -n 120 --no-pager 2>/dev/null \
          | grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' \
          | tail -n 1 || true
      )"
      [[ -n "$tunnel_url" ]] && break
      sleep 2
    done
  fi
  echo "$tunnel_url"
}

main() {
  require_systemd
  install_packages
  install_nodejs
  install_cloudflared
  prepare_source
  build_server
  configure_runtime
  install_server_service
  install_tunnel_service

  local tunnel_url relay_url
  tunnel_url="$(discover_tunnel_url)"
  relay_url="ws://$SERVER_HOST:$SERVER_PORT"
  if [[ -n "$tunnel_url" ]]; then
    relay_url="wss://${tunnel_url#https://}"
  fi

  log "Deployment complete."
  echo
  echo "TFCLAW_TOKEN=$TOKEN"
  echo "TFCLAW_RELAY_URL=$relay_url"
  if [[ -n "$tunnel_url" ]]; then
    echo "Cloudflare URL: $tunnel_url"
    echo "Note: Quick Tunnel URL may change after restart. For stable URL, use a named tunnel + domain."
  else
    echo "Cloudflare URL: (not enabled or not yet ready)"
  fi
  echo
  echo "Useful commands:"
  echo "  systemctl status ${SERVER_SERVICE_NAME}.service"
  echo "  journalctl -u ${SERVER_SERVICE_NAME}.service -f"
  if [[ "$ENABLE_TUNNEL" == "1" ]]; then
    echo "  systemctl status ${TUNNEL_SERVICE_NAME}.service"
    echo "  journalctl -u ${TUNNEL_SERVICE_NAME}.service -f"
  fi
}

main "$@"
