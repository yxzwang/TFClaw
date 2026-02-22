# @tfclaw/server

WebSocket relay server for Token-Free-Claw.

## Environment

- `RELAY_HOST` (default `0.0.0.0`)
- `RELAY_PORT` (default `8787`)
- `MAX_SNAPSHOT_CHARS` (default `12000`)

## Run

```bash
npm run dev --workspace @tfclaw/server
```

WebSocket endpoint:

- `ws://HOST:PORT/?role=agent&token=YOUR_TOKEN`
- `ws://HOST:PORT/?role=client&token=YOUR_TOKEN`

Health endpoint:

- `GET /health`
