
# Token-Free-Claw (TFClaw)

- The OpenClaw core requires an API Key, which is too expensive.
- Use OAuth? Claude refuses to provide OAuth access to third-party software.
- The official Claude Code App is only available to Max subscription users.

TFClaw is a **“terminal-oriented remote desktop” MVP**, with a companion mobile app service that allows users to start a command line session anytime from their phone to complete coding tasks.

- The core does not provide Agent services and requires no token. You can directly start your own agent inside the terminal and reuse mature CLI context management.
- Claude Code doesn’t let you use Claw? Just remotely launch the official Claude Code inside your own terminal.
- Open-source mobile app (currently Android only) connects to a remote terminal, enabling anyone to use Claude Code from their phone.

---

## Components

1. `server` – Handles forwarding and state caching (sessions organized by token).
2. `terminal-agent` – Runs on the user’s PC/server, manages multiple terminals, and reports output. Controlled via tmux.
3. `gateway` (located at `apps/feishu-gateway`, currently Feishu only) – Manages Chat Apps and maps messages to terminal commands.
4. `mobile` (Android first) – Displays terminal list/output and sends commands (including control keys like Ctrl+D).

---

## Currently Implemented Features

### General

- Associate mobile/Feishu clients with `terminal-agent` via `token`.

### Agent Supports

- Create new terminal
- Close terminal
- Write input (supports `__CTRL_C__`, `__CTRL_D__`, `__ENTER__`)
- Real-time stdout/stderr streaming
- Screenshot source listing (screen + Windows windows)
- Screenshot by `sourceId` (returns base64 image)

### Server Supports

- Agent/client role authentication (query token)
- Terminal state and output snapshot caching
- Command forwarding and basic ACK

### Gateway (Feishu Channel) Supports

- `/tmux help` – View all supported commands
- `/tmux status|sessions|panes|new|target|close|socket|lines|wait|stream|capture|key|send`
- `/t<subcommand>` alias (e.g., `/tkey`, `/ttarget`, `/tcapture`)
- `/passthrough on|off|status` and `/pt on|off|status`
- Passthrough mode: normal messages continuously sent to tmux until `/pt off`
- `/capture` returns screen/window ID list; reply with number to receive image
- Streaming output auto-pushes progress updates and recalls previous progress message upon new Feishu message (prevents stacking)
- Adds reaction (default `OnIt`) to user message before processing

### Mobile (Expo) Supports

Supports most `/tmux` and `/passthrough` commands via buttons:

- Connect to relay
- View and switch terminal list
- View output, send commands, use shortcut keys
- Create/close terminal
- Trigger screenshot and display latest image (Windows agent only)

---

## `/tmux` and `/passthrough` Commands

These commands are consistent across Feishu, mobile, and local terminal test flows:

```text
/tmux help
/tmux status
/tmux sessions
/tmux panes [session]
/tmux new [session]
/tmux target <session:window.pane|id>
/tmux close <id|session:window.pane>
/tmux socket <path|default>
/tmux lines <20-5000>
/tmux wait <0-5000>
/tmux stream <auto|on|off>
/tmux capture [lines]
/tmux key <key...>
/tmux send <literal command>
/passthrough on|off|status
/pt on|off|status
/t<subcommand>  Alias for /tmux subcommands (e.g., /tkey /ttarget /tcapture)
````

### Command Details

1. `/tmux help`
   Displays overview of tmux control commands.

2. `/tmux status`
   Shows current control state: `passthrough`, `target`, `socket`, `capture_lines`, `wait_ms`, `stream_mode`.

3. `/tmux sessions`
   Lists visible sessions in current tmux server.

4. `/tmux panes [session]`
   Lists panes and returns IDs (`[1] [2] ...`).
   Optional `[session]` filters by session.
   Each pane includes `target/window/cmd/activity`.

5. `/tmux new [session]`
   Creates new tmux session (default `tfclaw`).
   Automatically sets target to `${session}:0.0`.

6. `/tmux target <session:window.pane|id>`
   Switches target pane (by full target or ID).
   Returns latest capture after switching.

7. `/tmux close <id|session:window.pane>`
   Closes pane/window.
   Clears current target if it was closed.

8. `/tmux socket <path|default>`
   Switches tmux socket.
   `default` restores default socket.

9. `/tmux lines <20-5000>`
   Sets capture line limit (range enforced).

10. `/tmux wait <0-5000>`
    Sets delay (ms) before capturing output after sending command.

11. `/tmux stream <auto|on|off>`

    * `auto`: auto-enable streaming for long tasks
    * `on`: force streaming
    * `off`: disable streaming

12. `/tmux capture [lines]`
    Captures current screen content.

13. `/tmux key <key...>`
    Sends key sequence (e.g., `Enter`, `Esc`, `Ctrl+C`, `^C`).

14. `/tmux send <literal command>`
    Sends literal command and executes with Enter.

---

### `/passthrough` Mode (alias `/pt`)

* `/passthrough on` enables continuous passthrough to tmux.
* If no target is set, defaults to `tfclaw:0.0`.
* Control commands remain locally parsed.
* To force-send a slash command to tmux, prefix with `//` (e.g., `//tmux list-sessions`).

---

## Directory Structure

```text
apps/
  server/
  terminal-agent/
  mobile/
  feishu-gateway/
packages/
  protocol/
```

---

## Local Startup

From project root:

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

---

## 3.1 Feishu Service Startup

1. Create an app in Feishu Open Platform and enable Bot.
2. Add permission: `im:message`
3. (Optional) Add message recall permission for dynamic output simulation.
4. Copy `config.example.json` → `config.json` and fill in credentials.
5. Start full stack (build + server + agent + gateway):

Default: `ws://0.0.0.0:8787`

```bash
npm run start:stack
```

Dev mode:

```bash
npm run dev:stack
```

6. Enable **Long Connection** in Feishu event subscription.
7. Add event `im.message.receive_v1`.
8. Send message to bot.

---

## 3.2 Mobile App Service Startup

See:
[https://github.com/yxzwang/TFClaw/blob/main/dockerdeployReadMe.md](https://github.com/yxzwang/TFClaw/blob/main/dockerdeployReadMe.md)

### 1. Start via Docker

```bash
./scripts/deploy-docker-public.sh start
```

Log will show:

```
TFCLAW_TOKEN=xxxxxxxxx
TFCLAW_RELAY_URL=wss://xxxxxxxxxx.com
```

Use these to log in on mobile app.


The login screen is shown below.  
The top “A 50%” button can be tapped to switch the scaling ratio, and you can also manually enter a custom ratio on the right.

<img src="images/login.jpg" alt="Login Screen" width="320" />

After logging in, the connection status indicator turns green.  
Tap the top “ignore” button to display the terminal in full-screen mode:

<img src="images/connected.jpg" alt="Connected Screen" width="320" />



### 2. Check Status

```bash
./scripts/deploy-docker-public.sh status
```

### 3. Stop Service

```bash
./scripts/deploy-docker-public.sh stop
```

Note:

* First startup generates random token.
* Subsequent restarts reuse token.
* URL is regenerated each time.

---

## Android APK Build

See `apps/mobile/README.md`.
Use EAS to build `preview` APK.
Release demo is published; you can build yourself if preferred.

---

## Environment Variables

* `apps/server/.env.example`
* `apps/terminal-agent/.env.example`
* `apps/mobile/.env.example`
* `apps/feishu-gateway/.env.example`
* `config.example.json`

Gateway additional:

```
TFCLAW_CONFIG_PATH=/path/to/config.json
```

### Common Parameters

**gateway**

* `TFCLAW_COMMAND_RESULT_TIMEOUT_MS` (default 24h)
* `TFCLAW_PROGRESS_RECALL_DELAY_MS` (default 350ms)
* `TFCLAW_FEISHU_ACK_REACTION_ENABLED` (default 1)
* `TFCLAW_FEISHU_ACK_REACTION` (default `OnIt`)

**terminal-agent**

* `TFCLAW_TMUX_SUBMIT_DELAY_MS` (default 60ms)
* `TFCLAW_TMUX_STREAM_POLL_MS` (default 350ms)
* `TFCLAW_TMUX_STREAM_IDLE_MS` (default 3000ms)
* `TFCLAW_TMUX_STREAM_INITIAL_SILENCE_MS` (default 12000ms)
* `TFCLAW_TMUX_STREAM_WINDOW_MS` (default 24h)

---

## Public Deployment & Security

Recommended architecture:

* Expose only `443`
* Use reverse proxy (Nginx/Caddy/Traefik/Cloudflare Tunnel)
* Proxy to local `server` (e.g., `127.0.0.1:8787`)

### Minimum Security Baseline

1. Enable TLS (`wss://` only).
2. Use strong token (32+ random chars), rotate regularly.
3. Enable restrictions in `apps/server`:

   * `RELAY_ENFORCE_STRONG_TOKEN=true`
   * `RELAY_ALLOWED_TOKENS=<comma-separated tokens>`
   * `RELAY_ALLOWED_ORIGINS=<comma-separated origins>`
4. Firewall: allow only reverse proxy to access relay port.
5. Use process manager (systemd/pm2/docker restart policy) with logging and monitoring.

---

## Known Limitations (MVP)

* Feishu dynamic window tracking does not maintain expected 24h persistence (cause unknown). Use `/tcapture` manually if needed.
* Window enumeration/screenshot only supported on Windows agent; Linux/macOS support screen capture only.
* Mobile app requires public server exposure — pay attention to security.

