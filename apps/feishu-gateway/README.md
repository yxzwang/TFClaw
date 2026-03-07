# @tfclaw/feishu-gateway (TFClaw Gateway)

当前这个 workspace 已升级为统一 `tfclaw gateway` 入口：

1. 读取 `config.json`（默认当前工作目录，可用 `TFCLAW_CONFIG_PATH` 覆盖）
2. 初始化各 Chat Apps 的 `connect()` 生命周期（对齐 nanobot 的通道管理方式）
3. Feishu 使用 Long Connection（WebSocket）完整可用，其它 Chat Apps 先提供连接骨架

## 配置文件

推荐直接使用仓库根目录的 `config.example.json`：

```bash
cp config.example.json config.json
```

关键字段：

- `relay.token`
- `relay.url`
- `nexchatbot.enabled`
- `nexchatbot.baseUrl`
- `nexchatbot.runPath`（默认 `/v1/main-agent/feishu-bridge`）
- `openclawBridge.enabled`
- `openclawBridge.openclawRoot`
- `openclawBridge.stateDir`
- `openclawBridge.sharedSkillsDir`（公用 skills 目录）
- `openclawBridge.userHomeRoot`（子用户 home 根目录，支持相对 `config.json` 目录；默认 `.home`）
- `openclawBridge.userPrefix`
- `openclawBridge.tmuxSessionPrefix`
- `openclawBridge.gatewayPortBase`
- `openclawBridge.gatewayPortMax`
- `openclawBridge.sessionKey`
- `openclawBridge.allowAutoCreateUser`
- `channels.feishu.enabled`
- `channels.feishu.appId`
- `channels.feishu.appSecret`
- `channels.feishu.disableProxy`（默认建议 `true`，避免本机代理拦截长连接初始化）

### OpenClaw per-user bridge（飞书用户 -> Linux 用户 -> 独立 OpenClaw）

当 `openclawBridge.enabled=true` 时：

1. 每个飞书用户会映射到一个本地 Linux 用户（默认前缀 `tfoc_`）。
2. 若 Linux 用户不存在，网关会自动创建（要求网关进程具备 root 权限，且 `allowAutoCreateUser=true`）。
3. 网关会在该 Linux 用户下复用/拉起 tmux session，并在该 session 中启动独立 OpenClaw Gateway 进程。
4. TFClaw 收到的飞书消息会转发为 OpenClaw `chat.send`，等待 `chat` final 事件后，把回复再发回飞书。
5. 会强制写入该用户的 OpenClaw 运行配置，禁用 OpenClaw 自带 Feishu 通道（由 TFClaw 统一收发）。

注意：

- 需要系统可用：`tmux`、`useradd`、`runuser`/`sudo`/`su`。
- 需要 OpenClaw 已可运行（至少存在 `openclaw.mjs` 与 `dist/entry.js`）。  
  若 `openclawBridge.autoBuildDist=true`，网关会尝试自动执行 `pnpm exec tsdown --no-clean`。

## 启动

```bash
npm run dev:gateway
```

或生产模式：

```bash
npm run start:gateway
```

## 兼容旧环境变量

如果没有 `config.json`，会自动回退到旧 env 方案：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `TFCLAW_TOKEN`
- `TFCLAW_RELAY_URL`
- `FEISHU_ALLOW_FROM`
- `TFCLAW_NEXCHATBOT_ENABLED`
- `TFCLAW_NEXCHATBOT_BASE_URL`
- `TFCLAW_NEXCHATBOT_RUN_PATH`
- `TFCLAW_NEXCHATBOT_API_KEY`
- `TFCLAW_NEXCHATBOT_TIMEOUT_MS`
- `TFCLAW_OPENCLAW_ENABLED`
- `TFCLAW_OPENCLAW_ROOT`
- `TFCLAW_OPENCLAW_STATE_DIR`
- `TFCLAW_OPENCLAW_SHARED_SKILLS_DIR`
- `TFCLAW_OPENCLAW_USER_HOME_ROOT`
- `TFCLAW_OPENCLAW_USER_PREFIX`
- `TFCLAW_OPENCLAW_TMUX_SESSION_PREFIX`
- `TFCLAW_OPENCLAW_GATEWAY_HOST`
- `TFCLAW_OPENCLAW_GATEWAY_PORT_BASE`
- `TFCLAW_OPENCLAW_GATEWAY_PORT_MAX`
- `TFCLAW_OPENCLAW_STARTUP_TIMEOUT_MS`
- `TFCLAW_OPENCLAW_REQUEST_TIMEOUT_MS`
- `TFCLAW_OPENCLAW_SESSION_KEY`
- `TFCLAW_OPENCLAW_NODE_PATH`
- `TFCLAW_OPENCLAW_CONFIG_TEMPLATE_PATH`
- `TFCLAW_OPENCLAW_AUTO_BUILD_DIST`
- `TFCLAW_OPENCLAW_ALLOW_AUTO_CREATE_USER`

## 模式分流规则

- `tmux` 模式（terminal/passthrough）：仅接受 `text`，内容直通 tmux（保持原行为）
- `tfclaw` 模式：
  - 预设命令（`/tmux`、`/pt`、`/capture`、`/list`、`/new` 等）走 TFClaw 原流程
  - 非预设消息（包括非 text）优先走 OpenClaw bridge（启用时）
  - 若 OpenClaw bridge 未启用，则回退到 NexChatBot bridge
  - 返回给用户的内容使用对应 bridge 的最终回复

## Feishu 命令

- `/tfhelp`（TFClaw 命令总览）
- `/tflist`、`/tfnew`、`/tfuse <id|title|index>`、`/tfattach [id|title|index]`、`/tfclose <id|title|index>`
- `/tfcapture`（列出屏幕/窗口并回复数字）
- `<terminal-id>: <command>`、`<command>`（发给当前选中 terminal）
- `/tfkey <...>`、`/tfctrlc`、`/tfctrld`
- `/tfmode status|list|personal|group <groupName>`
- `/tfgroup list|create|workspace|add|remove ...`
- `/tfadmin list|add|remove ...`
- `/tfusers`
- `/tfroot show`（只读，`/tfroot set` 已禁用）
- `/tfenv list|set|unset ...`（管理当前用户私有 env）
- `/tfapikey <ENV_KEY> <api_key>`（将 API Key 写入当前用户私有 env）

### 权限与参数说明

- `super_root` 只从本地文件配置加载：`<openclawBridge.stateDir>/super-root.local.json`
- `/tfadmin add/remove` 与 `/tfgroup add/remove` 的用户参数支持：
  - 飞书 ID（如 `ou_xxx`）
  - 飞书用户名（如 `汪燠欣`）
  - Linux 用户名（如 `tfoc_xxx`）
  - `me`
- `/tfenv` 与 `/tfapikey` 仅作用于当前发送消息用户，不会修改其他用户环境变量。
