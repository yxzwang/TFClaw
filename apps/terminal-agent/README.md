# @tfclaw/terminal-agent

Terminal runtime node that connects to TFClaw relay server.
Uses `tmux` for terminal lifecycle and rendering.
Supports capture source listing and selected-source screenshot.
On Windows, supports screen and window source listing/capture.

## Prerequisite

- `tmux` must be available to the configured command.
  On Linux/macOS default is direct `tmux`.
  On Windows default is `wsl.exe -e tmux`.

## Environment

- `TFCLAW_TOKEN` (required)
- `TFCLAW_RELAY_URL` (default `ws://127.0.0.1:8787`)
- `TFCLAW_AGENT_ID` (default `${hostname}-${pid}`)
- `TFCLAW_START_TERMINALS` (default `1`)
- `TFCLAW_DEFAULT_CWD` (default current working directory)
- `TFCLAW_MAX_LOCAL_BUFFER` (default `12000`)
- `TFCLAW_TMUX_COMMAND` (default `tmux`, Windows default `wsl.exe`)
- `TFCLAW_TMUX_BASE_ARGS` (default empty, Windows default `-e tmux`)
- `TFCLAW_TMUX_SESSION` (default derived from token + hostname)
- `TFCLAW_TMUX_CAPTURE_LINES` (default `300`)
- `TFCLAW_TMUX_POLL_MS` (default `250`)
- `TFCLAW_TMUX_MAX_DELTA_CHARS` (default `4000`)
- `TFCLAW_TMUX_BOOTSTRAP_WINDOW` (default `__tfclaw_bootstrap__`)
- `TFCLAW_TMUX_RESET_ON_BOOT` (default `1`, recreate session on startup)
- `TFCLAW_TMUX_PERSIST_SESSION_ON_SHUTDOWN` (default `0`)
- `TFCLAW_FILE_TRANSFER_ROOT` (default `${TFCLAW_DEFAULT_CWD}/tfclaw-files`)
- `TFCLAW_FILE_TRANSFER_CHUNK_BYTES` (default `65536`)
- `TFCLAW_FILE_TRANSFER_MAX_BYTES` (default `52428800`)
- `TFCLAW_FILE_UPLOAD_TIMEOUT_MS` (default `600000`)

File transfer path behavior:
- If `file.upload.start` / `file.download` carries `sessionKey` and the corresponding tmux target exists, relative paths and default upload destination follow that target pane current path.
- Otherwise it falls back to `TFCLAW_FILE_TRANSFER_ROOT`.

When `TFCLAW_TMUX_COMMAND` is `wsl.exe`, Windows paths like `C:\work\repo` are auto-converted to `/mnt/c/work/repo` for tmux `-c`.

## Run

```bash
TFCLAW_TOKEN=demo-token npm run dev --workspace @tfclaw/terminal-agent
```
