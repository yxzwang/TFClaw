# @tfclaw/feishu-gateway

Feishu long-connection bot bridge for TFClaw.

## Required env

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `TFCLAW_TOKEN`

## Optional env

- `TFCLAW_RELAY_URL` (default `ws://127.0.0.1:8787`)
- `FEISHU_ALLOW_FROM` (comma-separated open_id whitelist)

## Run

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx TFCLAW_TOKEN=demo-token npm run dev --workspace @tfclaw/feishu-gateway
```

## Commands in Feishu

- `/help`
- `/list`
- `/new`
- `/use <id|title|index>`
- `/close <id|title|index>`
- `/capture` (lists screens/windows with numbers; reply number to return image)
- `<terminal-id>: <command>`
- `<command>` (run in selected terminal)
- `/ctrlc`, `/ctrld`
