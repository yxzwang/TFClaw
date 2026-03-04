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

## Feishu 命令

- `/help`
- `/list`
- `/new`
- `/use <id|title|index>`
- `/close <id|title|index>`
- `/capture`（列出屏幕/窗口并回复数字）
- `/tmux fileget <path>`（从 terminal-agent 下载文件并回传飞书）
- `/tfileget <path>`（`/tmux fileget` 别名）
- `<terminal-id>: <command>`
- `<command>`（发给当前选中 terminal）
- `/ctrlc`, `/ctrld`

## 文件收发

- 飞书用户直接发送 `file` 消息给机器人：gateway 会自动分片上传到 terminal-agent（默认落盘到当前 tmux target 对应 pane 路径；无 target 时回退到 `tfclaw-files/`）。
- 使用 `/tmux fileget <path>`：gateway 会向 terminal-agent 请求文件，再上传并发送飞书文件消息。`path` 为相对路径时，基于当前 tmux target 对应 pane 路径解析。
- 飞书单文件上传限制约 30MB；gateway 默认转发限制由 `TFCLAW_FILE_TRANSFER_MAX_BYTES` 控制（默认 50MB）。
