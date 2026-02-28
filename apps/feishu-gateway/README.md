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
- `channels.feishu.enabled`
- `channels.feishu.appId`
- `channels.feishu.appSecret`
- `channels.feishu.disableProxy`（默认建议 `true`，避免本机代理拦截长连接初始化）

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

## 模式分流规则

- `tmux` 模式（terminal/passthrough）：仅接受 `text`，内容直通 tmux（保持原行为）
- `tfclaw` 模式：
  - 预设命令（`/tmux`、`/pt`、`/capture`、`/list`、`/new` 等）走 TFClaw 原流程
  - 非预设消息（包括非 text）走 NexChatBot 桥接流程
  - 返回给用户的内容直接使用 NexChatBot 的 `reply`

## Feishu 命令

- `/help`
- `/list`
- `/new`
- `/use <id|title|index>`
- `/close <id|title|index>`
- `/capture`（列出屏幕/窗口并回复数字）
- `<terminal-id>: <command>`
- `<command>`（发给当前选中 terminal）
- `/ctrlc`, `/ctrld`
