#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="start"
if [[ "${1:-}" == "--dev" ]]; then
  MODE="dev"
fi

TFCLAW_TOKEN="${TFCLAW_TOKEN:-demo-token}"
TFCLAW_RELAY_URL="${TFCLAW_RELAY_URL:-ws://127.0.0.1:8787}"
TFCLAW_CONFIG_PATH="${TFCLAW_CONFIG_PATH:-$ROOT_DIR/config.json}"
RUNTIME_TFCLAW_CONFIG_PATH="$TFCLAW_CONFIG_PATH"
GENERATED_CONFIG_PATH=""

PIDS=()

package_needs_build() {
  local package_dir="$1"
  local marker_file="$package_dir/dist/index.js"

  if [[ ! -f "$marker_file" ]]; then
    return 0
  fi

  if [[ -f "$package_dir/tsconfig.json" && "$package_dir/tsconfig.json" -nt "$marker_file" ]]; then
    return 0
  fi
  if [[ -f "$package_dir/package.json" && "$package_dir/package.json" -nt "$marker_file" ]]; then
    return 0
  fi

  local newer_source
  newer_source="$(find "$package_dir/src" -type f -newer "$marker_file" -print -quit 2>/dev/null || true)"
  if [[ -n "$newer_source" ]]; then
    return 0
  fi

  return 1
}

ensure_package_built() {
  local package_name="$1"
  local package_dir="$2"
  shift 2

  if package_needs_build "$package_dir"; then
    echo "[start-stack] building ${package_name} ..."
    "$@"
  else
    echo "[start-stack] ${package_name} is up to date, skip build."
  fi
}

extract_port_from_url() {
  local input_url="$1"
  node -e 'const u = new URL(process.argv[1]); console.log(u.port || (u.protocol === "wss:" ? "443" : "80"));' "$input_url"
}

rewrite_url_port() {
  local input_url="$1"
  local target_port="$2"
  node -e 'const u = new URL(process.argv[1]); u.port = process.argv[2]; console.log(u.toString());' "$input_url" "$target_port"
}

pick_available_port() {
  local start_port="$1"
  node -e '
    const net = require("node:net");
    const start = Number.parseInt(process.argv[1], 10) || 8787;
    const host = "127.0.0.1";
    const tryPort = (port) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => tryPort(port + 1));
      server.listen({ host, port }, () => {
        const address = server.address();
        const nextPort = typeof address === "object" && address ? address.port : port;
        server.close(() => process.stdout.write(String(nextPort)));
      });
    };
    tryPort(start);
  ' "$start_port"
}

render_runtime_config() {
  local input_config="$1"
  local output_config="$2"
  local relay_url="$3"
  local relay_token="$4"
  node -e '
    const fs = require("node:fs");
    const [inputPath, outputPath, relayUrl, relayToken] = process.argv.slice(1);
    const raw = fs.readFileSync(inputPath, "utf8");
    const parsed = JSON.parse(raw);
    const config = parsed && typeof parsed === "object" ? parsed : {};
    const relay = config.relay && typeof config.relay === "object" ? config.relay : {};
    relay.url = relayUrl;
    relay.token = relayToken;
    config.relay = relay;
    fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  ' "$input_config" "$output_config" "$relay_url" "$relay_token"
}

RELAY_PORT="$(extract_port_from_url "$TFCLAW_RELAY_URL")"
AVAILABLE_RELAY_PORT="$(pick_available_port "$RELAY_PORT")"
if [[ "$AVAILABLE_RELAY_PORT" != "$RELAY_PORT" ]]; then
  TFCLAW_RELAY_URL="$(rewrite_url_port "$TFCLAW_RELAY_URL" "$AVAILABLE_RELAY_PORT")"
  RELAY_PORT="$AVAILABLE_RELAY_PORT"
  echo "[start-stack] relay port ${RELAY_PORT} selected (original port was busy)."
fi

if [[ -f "$TFCLAW_CONFIG_PATH" ]]; then
  GENERATED_CONFIG_PATH="$(mktemp "${TMPDIR:-/tmp}/tfclaw-config.XXXXXX.json")"
  render_runtime_config "$TFCLAW_CONFIG_PATH" "$GENERATED_CONFIG_PATH" "$TFCLAW_RELAY_URL" "$TFCLAW_TOKEN"
  RUNTIME_TFCLAW_CONFIG_PATH="$GENERATED_CONFIG_PATH"
else
  echo "[start-stack] config file not found at ${TFCLAW_CONFIG_PATH}, gateway will use it as-is."
fi

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  if [[ -n "${GENERATED_CONFIG_PATH:-}" && -f "$GENERATED_CONFIG_PATH" ]]; then
    rm -f "$GENERATED_CONFIG_PATH"
  fi
}

trap cleanup EXIT INT TERM

start_process() {
  local name="$1"
  shift
  echo "[start-stack] starting ${name} ..."
  "$@" &
  local pid=$!
  PIDS+=("$pid")
  echo "[start-stack] ${name} pid=${pid}"
}

if [[ "$MODE" == "start" ]]; then
  echo "[start-stack] build mode"
  ensure_package_built "@tfclaw/protocol" "$ROOT_DIR/packages/protocol" npm run build --workspace @tfclaw/protocol
  ensure_package_built "@tfclaw/server" "$ROOT_DIR/apps/server" npm run build --workspace @tfclaw/server
  ensure_package_built "@tfclaw/terminal-agent" "$ROOT_DIR/apps/terminal-agent" npm run build --workspace @tfclaw/terminal-agent
  ensure_package_built "@tfclaw/feishu-gateway" "$ROOT_DIR/apps/feishu-gateway" npm run build --workspace @tfclaw/feishu-gateway

  start_process "server" env RELAY_PORT="$RELAY_PORT" node apps/server/dist/index.js
  start_process "terminal-agent" env TFCLAW_TOKEN="$TFCLAW_TOKEN" TFCLAW_RELAY_URL="$TFCLAW_RELAY_URL" node apps/terminal-agent/dist/index.js
  start_process "gateway" env TFCLAW_CONFIG_PATH="$RUNTIME_TFCLAW_CONFIG_PATH" TFCLAW_TOKEN="$TFCLAW_TOKEN" TFCLAW_RELAY_URL="$TFCLAW_RELAY_URL" node apps/feishu-gateway/dist/index.js
else
  echo "[start-stack] dev mode"
  ensure_package_built "@tfclaw/protocol" "$ROOT_DIR/packages/protocol" npm run build --workspace @tfclaw/protocol

  start_process "server(dev)" env RELAY_PORT="$RELAY_PORT" npm run dev --workspace @tfclaw/server
  start_process "terminal-agent(dev)" env TFCLAW_TOKEN="$TFCLAW_TOKEN" TFCLAW_RELAY_URL="$TFCLAW_RELAY_URL" npm run dev --workspace @tfclaw/terminal-agent
  start_process "gateway(dev)" env TFCLAW_CONFIG_PATH="$RUNTIME_TFCLAW_CONFIG_PATH" TFCLAW_TOKEN="$TFCLAW_TOKEN" TFCLAW_RELAY_URL="$TFCLAW_RELAY_URL" npm run dev --workspace @tfclaw/feishu-gateway
fi

echo "[start-stack] relay=${TFCLAW_RELAY_URL}"
echo "[start-stack] token=${TFCLAW_TOKEN}"
echo "[start-stack] config=${TFCLAW_CONFIG_PATH}"
if [[ "$RUNTIME_TFCLAW_CONFIG_PATH" != "$TFCLAW_CONFIG_PATH" ]]; then
  echo "[start-stack] runtime-config=${RUNTIME_TFCLAW_CONFIG_PATH}"
fi
echo "[start-stack] all processes started. press Ctrl+C to stop."

wait -n "${PIDS[@]}"
