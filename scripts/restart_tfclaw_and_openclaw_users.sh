#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TFCLAW_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="${TFCLAW_CONFIG_PATH:-${TFCLAW_ROOT}/config.json}"
MAP_PATH="${TFCLAW_OPENCLAW_MAP_PATH:-${TFCLAW_ROOT}/.runtime/openclaw_bridge/feishu-user-map.json}"
GATEWAY_SESSION="${TFCLAW_GATEWAY_SESSION:-tfclaw-gateway}"
TMUX_SESSION_PREFIX="${TFCLAW_OPENCLAW_TMUX_SESSION_PREFIX:-tfoc-}"

resolve_from_tfclaw_root() {
  local raw="$1"
  if [[ "$raw" = /* ]]; then
    printf '%s\n' "$raw"
  else
    printf '%s\n' "${TFCLAW_ROOT}/${raw}"
  fi
}

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
}

need_cmd jq
need_cmd tmux
need_cmd runuser
need_cmd node

if [[ "$(id -u)" -ne 0 ]]; then
  echo "please run as root (required to switch linux users)." >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "config not found: $CONFIG_PATH" >&2
  exit 1
fi

OPENCLAW_ROOT_RAW="$(jq -r '.openclawBridge.openclawRoot // empty' "$CONFIG_PATH")"
if [[ -z "$OPENCLAW_ROOT_RAW" ]]; then
  OPENCLAW_ROOT_RAW="../openclaw"
fi
OPENCLAW_ROOT="$(resolve_from_tfclaw_root "$OPENCLAW_ROOT_RAW")"
OPENCLAW_ROOT="$(readlink -f "$OPENCLAW_ROOT" 2>/dev/null || echo "$OPENCLAW_ROOT")"
if [[ ! -d "$OPENCLAW_ROOT" ]]; then
  echo "openclaw root not found: $OPENCLAW_ROOT" >&2
  exit 1
fi

SHARED_SKILLS_DIR_RAW="$(jq -r '.openclawBridge.sharedSkillsDir // empty' "$CONFIG_PATH")"
if [[ -z "$SHARED_SKILLS_DIR_RAW" ]]; then
  SHARED_SKILLS_DIR_RAW="${OPENCLAW_ROOT}/skills"
fi
SHARED_SKILLS_DIR="$(resolve_from_tfclaw_root "$SHARED_SKILLS_DIR_RAW")"
SHARED_SKILLS_DIR="$(readlink -f "$SHARED_SKILLS_DIR" 2>/dev/null || echo "$SHARED_SKILLS_DIR")"

NODE_PATH="$(jq -r '.openclawBridge.nodePath // empty' "$CONFIG_PATH")"
if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH="$(command -v node)"
fi
if [[ ! -x "$NODE_PATH" ]]; then
  echo "node executable not found: $NODE_PATH" >&2
  exit 1
fi

OPENCLAW_ENTRY="${OPENCLAW_ROOT}/openclaw.mjs"
if [[ ! -f "$OPENCLAW_ENTRY" ]]; then
  echo "openclaw entry not found: $OPENCLAW_ENTRY" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$MAP_PATH")"
if [[ ! -f "$MAP_PATH" ]]; then
  printf '{\n  "version": 1,\n  "users": {}\n}\n' > "$MAP_PATH"
  chmod 600 "$MAP_PATH"
fi

echo "[1/3] restarting tfclaw gateway session: $GATEWAY_SESSION"
pkill -f "apps/feishu-gateway/src/index.ts" >/dev/null 2>&1 || true
if tmux has-session -t "$GATEWAY_SESSION" 2>/dev/null; then
  tmux kill-session -t "$GATEWAY_SESSION"
fi
TMUX= TMUX_PANE= tmux new-session -d -s "$GATEWAY_SESSION" \
  "bash -lc 'cd \"$TFCLAW_ROOT\" && npm exec tsx watch apps/feishu-gateway/src/index.ts'"

mapfile -t USERS < <(jq -r '.users // {} | to_entries[]? | [.value.linuxUser, (.value.gatewayPort|tostring), .value.gatewayToken] | @tsv' "$MAP_PATH")

echo "[2/3] restarting mapped openclaw users"
if [[ "${#USERS[@]}" -eq 0 ]]; then
  echo "no mapped users found in $MAP_PATH"
else
  for row in "${USERS[@]}"; do
    IFS=$'\t' read -r user port token <<<"$row"
    [[ -n "$user" && -n "$port" && -n "$token" ]] || continue

    passwd_line="$(getent passwd "$user" || true)"
    if [[ -z "$passwd_line" ]]; then
      echo "skip $user: linux user not found"
      continue
    fi
    home_dir="$(awk -F: '{print $6}' <<<"$passwd_line")"
    if [[ -z "$home_dir" ]]; then
      echo "skip $user: home dir missing"
      continue
    fi

    # Permission self-heal for migrated homes.
    mkdir -p "$home_dir/.tfclaw-openclaw/workspace" "$home_dir/.openclaw" "$home_dir/skills"
    chown -R "$user:$user" "$home_dir"
    chmod 711 "$(dirname "$home_dir")" || true
    chmod 700 "$home_dir" || true
    chmod 700 "$home_dir/.openclaw" "$home_dir/.tfclaw-openclaw" "$home_dir/.tfclaw-openclaw/workspace" "$home_dir/skills" || true

    shell_wrapper_dir="${home_dir}/.tfclaw-openclaw/bin"
    shell_wrapper_path="${shell_wrapper_dir}/tfclaw-jail-shell.sh"
    mkdir -p "$shell_wrapper_dir"
cat > "$shell_wrapper_path" <<'TFCLAW_JAIL_SHELL'
#!/usr/bin/env bash
set -euo pipefail

REAL_SHELL="${TFCLAW_EXEC_REAL_SHELL:-/bin/bash}"
WORKSPACE="${TFCLAW_EXEC_WORKSPACE:-${PWD}}"
USER_HOME="${TFCLAW_EXEC_HOME:-${HOME:-$WORKSPACE}}"
USER_NAME="${USER:-$(id -un 2>/dev/null || echo user)}"
PATH_DEFAULT="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

if [[ "${1:-}" != "-c" || $# -lt 2 ]]; then
  exec "$REAL_SHELL" "$@"
fi

CMD="$2"
WORKSPACE="$(readlink -f "$WORKSPACE" 2>/dev/null || realpath "$WORKSPACE" 2>/dev/null || echo "$WORKSPACE")"
USER_HOME="$(readlink -f "$USER_HOME" 2>/dev/null || realpath "$USER_HOME" 2>/dev/null || echo "$USER_HOME")"
if [[ ! -d "$WORKSPACE" ]]; then
  exec "$REAL_SHELL" -c "$CMD"
fi
if [[ ! -d "$USER_HOME" ]]; then
  USER_HOME="$WORKSPACE"
fi

cd "$WORKSPACE"
export PATH="$PATH_DEFAULT"
export HOME="$USER_HOME"
export USER="$USER_NAME"
export LOGNAME="$USER_NAME"
export SHELL="$REAL_SHELL"
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-C.UTF-8}"
exec "$REAL_SHELL" -lc "$CMD"
TFCLAW_JAIL_SHELL
    chown "$user:$user" "$shell_wrapper_path"
    chmod 700 "$shell_wrapper_path"

    config_path="${home_dir}/.tfclaw-openclaw/openclaw.json"
    if [[ ! -f "$config_path" ]]; then
      echo "skip $user: config missing at $config_path"
      continue
    fi
    skills_dir="${home_dir}/skills"

    # Ensure per-user skills directory is always included and exec policy is usable per user.
    tmp_cfg="${config_path}.tmp.$$"
    jq --arg shared_skills_dir "$SHARED_SKILLS_DIR" --arg skills_dir "$skills_dir" '
      .skills = (.skills // {}) |
      .skills.load = (.skills.load // {}) |
      .skills.load.extraDirs = [ $shared_skills_dir, $skills_dir ] |
      .tools = (.tools // {}) |
      .tools.exec = (.tools.exec // {}) |
      .tools.exec.host = "gateway" |
      .tools.exec.security = "full" |
      .tools.exec.ask = "off" |
      .tools.exec.applyPatch = (.tools.exec.applyPatch // {}) |
      .tools.exec.applyPatch.workspaceOnly = true |
      .tools.fs = (.tools.fs // {}) |
      .tools.fs.workspaceOnly = true
    ' "$config_path" > "$tmp_cfg"
    mv "$tmp_cfg" "$config_path"
    chown "$user:$user" "$config_path"
    chmod 600 "$config_path"

    approvals_path="${home_dir}/.openclaw/exec-approvals.json"
    approvals_token="$(jq -r '.socket.token // empty' "$approvals_path" 2>/dev/null || true)"
    if [[ -z "$approvals_token" ]]; then
      approvals_token="$(tr -d '-' </proc/sys/kernel/random/uuid)"
    fi
    tmp_approvals="${approvals_path}.tmp.$$"
    if [[ -f "$approvals_path" ]]; then
      if ! jq \
        --arg socket_path "${home_dir}/.openclaw/exec-approvals.sock" \
        --arg token "$approvals_token" \
        '
          .version = 1 |
          .socket = { path: $socket_path, token: $token } |
          .defaults = ((.defaults // {}) + { security: "full", ask: "off", askFallback: "full" }) |
          .agents = (.agents // {}) |
          .agents.main = ((.agents.main // {}) + { security: "full", ask: "off", askFallback: "full" })
        ' "$approvals_path" > "$tmp_approvals"; then
        jq \
          --arg socket_path "${home_dir}/.openclaw/exec-approvals.sock" \
          --arg token "$approvals_token" \
          '
            .version = 1 |
            .socket = { path: $socket_path, token: $token } |
            .defaults = { security: "full", ask: "off", askFallback: "full" } |
            .agents = { main: { security: "full", ask: "off", askFallback: "full" } }
          ' <<< '{}' > "$tmp_approvals"
      fi
    else
      jq \
        --arg socket_path "${home_dir}/.openclaw/exec-approvals.sock" \
        --arg token "$approvals_token" \
        '
          .version = 1 |
          .socket = { path: $socket_path, token: $token } |
          .defaults = { security: "full", ask: "off", askFallback: "full" } |
          .agents = { main: { security: "full", ask: "off", askFallback: "full" } }
        ' <<< '{}' > "$tmp_approvals"
    fi
    mv "$tmp_approvals" "$approvals_path"
    chown "$user:$user" "$approvals_path"
    chmod 600 "$approvals_path"

    session_name="${TMUX_SESSION_PREFIX}${user}"
    start_cmd="unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy npm_config_proxy npm_config_https_proxy npm_config_http_proxy npm_config_noproxy TMUX TMUX_PANE && umask 077 && cd '$OPENCLAW_ROOT' && HOME='$home_dir' USER='$user' LOGNAME='$user' SHELL='$shell_wrapper_path' TFCLAW_EXEC_WORKSPACE='$home_dir/.tfclaw-openclaw/workspace' TFCLAW_EXEC_HOME='$home_dir' TFCLAW_EXEC_REAL_SHELL='/bin/bash' OPENCLAW_HOME='$home_dir' CLAWHUB_WORKDIR='$home_dir' OPENCLAW_CONFIG_PATH='$config_path' OPENCLAW_GATEWAY_TOKEN='$token' exec '$NODE_PATH' '$OPENCLAW_ENTRY' gateway --allow-unconfigured --port $port --bind loopback --auth token --token '$token'"

    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux has-session -t "$session_name" 2>/dev/null \
      && env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux kill-session -t "$session_name" \
      || true

    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux new-session -d -s "$session_name" bash -lc "$start_cmd"
    echo "restarted $session_name (port $port)"
  done
fi

echo "[3/3] health check"
sleep 3
TMUX= TMUX_PANE= tmux capture-pane -p -t "$GATEWAY_SESSION":0.0 | tail -n 25

if command -v python3 >/dev/null 2>&1; then
  python3 - <<PY
import json, socket, time
path = "${MAP_PATH}"
try:
    data = json.load(open(path, "r", encoding="utf-8"))
except Exception as exc:
    print(f"map parse failed: {exc}")
    raise SystemExit(0)
for _, item in (data.get("users") or {}).items():
    user = str(item.get("linuxUser", "")).strip()
    port = int(item.get("gatewayPort", 0) or 0)
    if not user or port <= 0:
        continue
    ok = False
    deadline = time.time() + 30.0
    while time.time() < deadline:
        s = socket.socket()
        s.settimeout(1.0)
        try:
            s.connect(("127.0.0.1", port))
            ok = True
            break
        except Exception:
            time.sleep(0.6)
        finally:
            s.close()
    print(f"{user}: {port} {'open' if ok else 'closed'}")
PY
fi

echo "done"
