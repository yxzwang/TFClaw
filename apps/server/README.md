# @tfclaw/server

WebSocket relay server for Token-Free-Claw.

## Environment

Core:

- `RELAY_HOST` (default `0.0.0.0`)
- `RELAY_PORT` (default `8787`)
- `RELAY_WS_PATH` (default `/`)
- `MAX_SNAPSHOT_CHARS` (default `12000`)

Security / limits:

- `RELAY_MAX_MESSAGE_BYTES` (default `262144`)
- `RELAY_MAX_CONNECTIONS` (default `500`)
- `RELAY_MAX_CONNECTIONS_PER_IP` (default `40`)
- `RELAY_MAX_SESSIONS` (default `500`)
- `RELAY_MAX_CLIENTS_PER_SESSION` (default `80`)
- `RELAY_MESSAGE_RATE_WINDOW_MS` (default `10000`)
- `RELAY_MAX_MESSAGES_PER_WINDOW` (default `240`)
- `RELAY_UPGRADE_RATE_WINDOW_MS` (default `10000`)
- `RELAY_MAX_UPGRADES_PER_WINDOW_PER_IP` (default `120`)
- `RELAY_HEARTBEAT_INTERVAL_MS` (default `20000`)
- `RELAY_IDLE_TIMEOUT_MS` (default `120000`)
- `RELAY_TOKEN_MIN_LENGTH` (default `8`)
- `RELAY_TOKEN_MAX_LENGTH` (default `128`)
- `RELAY_ENFORCE_STRONG_TOKEN` (default `false`)
- `RELAY_ALLOWED_ORIGINS` (optional comma-separated origin allowlist)
- `RELAY_ALLOWED_TOKENS` (optional comma-separated token allowlist)

## Run

```bash
npm run dev --workspace @tfclaw/server
```

WebSocket endpoint:

- `ws://HOST:PORT/PATH?role=agent&token=YOUR_TOKEN`
- `ws://HOST:PORT/PATH?role=client&token=YOUR_TOKEN`

`PATH` is controlled by `RELAY_WS_PATH`.

Health endpoint:

- `GET /health`

## Public deployment checklist

1. Put relay behind HTTPS reverse proxy (`wss://`) and only expose `443`.
2. Restrict firewall: only proxy can reach relay service port.
3. Use long random tokens (at least 32 chars), rotate periodically.
4. Enable `RELAY_ALLOWED_TOKENS` and `RELAY_ENFORCE_STRONG_TOKEN=true`.
5. Set strict `RELAY_ALLOWED_ORIGINS` if you have browser-based clients.
6. Keep process manager + restart policy (`systemd`, Docker, pm2) and log monitoring enabled.
