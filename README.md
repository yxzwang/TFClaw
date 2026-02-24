# Token-Free-Claw (TFClaw)

TFClaw 是一个“面向 terminal 的远程桌面”MVP：

1. `server` 只做转发与状态缓存（按 token 组织会话）。
2. `terminal-agent` 运行在用户电脑/服务器上，管理多个 terminal 并上报输出。
3. `mobile`（Android 优先）查看 terminal 列表、输出，并发送命令（含 Ctrl+D 等控制键）。
4. `gateway`（位于 `apps/feishu-gateway`）统一管理 Chat Apps，并将消息映射为 terminal 指令。

## 当前已实现能力

- 通过 `token` 关联移动端/飞书端与 terminal-agent。
- agent 支持：
  - 新建 terminal
  - 关闭 terminal
  - 写入输入（支持 `__CTRL_C__`、`__CTRL_D__`、`__ENTER__`）
  - 实时回传 stdout/stderr
  - 可截图源列表（屏幕 + Windows 窗口）
  - 按 `sourceId` 选择截图（屏幕或窗口，返回 base64 图片）
- server 支持：
  - agent/client 角色鉴权（query token）
  - terminal 状态与输出快照缓存
  - 命令转发与基础 ACK
- mobile（Expo）支持：
  - 连接 relay
  - 查看 terminal 列表并切换
  - 查看输出、输入命令、快捷键
  - 新建/关闭 terminal
  - 触发截图并显示最新图片
- gateway（Feishu 通道）支持：
  - 已切换为 nanobot 对齐命令集（飞书端与 terminal 本地测试端一致）：
    - `/tmux status|sessions|panes|new|target|close|socket|lines|wait|stream|capture|key|send`
    - `/t<subcommand>` 别名（例如 `/tkey` `/ttarget` `/tcapture`）
    - `/passthrough on|off|status` 与 `/pt on|off|status`
  - passthrough 开启后，普通消息持续直通 tmux（直到 `/pt off`）
  - `/capture` 返回“屏幕/窗口编号列表”，回复数字后回传对应图片
  - tmux 流式输出会实时回推 progress，并在飞书端新消息发出后自动撤回上一条 progress（防堆叠）
  - 收到用户消息后会先给原消息添加 reaction（默认 `OnIt`）

## 目录结构

```text
apps/
  server/
  terminal-agent/
  mobile/
  feishu-gateway/
packages/
  protocol/
```

## 本地启动

### 1. 安装依赖

```bash
npm install
```

### 2. 编译检查

```bash
npm run build
```

### 3. 启动 relay server

```bash
npm run dev:server
```

默认监听：`ws://0.0.0.0:8787`

也可以一键启动整套（build + server + agent + gateway）：

```bash
npm run start:stack
```

开发模式一键启动：

```bash
npm run dev:stack
```

### 4. 启动 terminal agent（另一个终端）

Windows PowerShell：

```powershell
$env:TFCLAW_TOKEN='demo-token'
$env:TFCLAW_RELAY_URL='ws://127.0.0.1:8787'
npm run dev:agent
```

Linux/macOS：

```bash
TFCLAW_TOKEN=demo-token TFCLAW_RELAY_URL=ws://127.0.0.1:8787 npm run dev:agent
```

### 5. 启动 mobile（另一个终端）

```bash
npm run dev:mobile
```

Android 模拟器请用 `ws://10.0.2.2:8787`，真机请填你的局域网 IP。

## TFClaw Gateway 启动

1. 在飞书开放平台创建应用并启用 Bot。
2. 权限添加 `im:message`，事件添加 `im.message.receive_v1`。
3. 事件订阅选择 **长连接（Long Connection）**。
4. 从 `config.example.json` 复制一份到 `config.json` 并填入 token/app 凭证。

启动：

```bash
npm run dev:gateway
```

说明：`gateway` 会优先读取 `config.json`，若不存在则回退到旧环境变量模式（兼容历史脚本）。

## Android APK 构建

见 `apps/mobile/README.md`，使用 EAS 进行 `preview` APK 构建。

## 环境变量

- `apps/server/.env.example`
- `apps/terminal-agent/.env.example`
- `apps/mobile/.env.example`
- `apps/feishu-gateway/.env.example`
- `config.example.json`

gateway 额外支持：`TFCLAW_CONFIG_PATH=/path/to/config.json`

常用新增参数：

- gateway
  - `TFCLAW_COMMAND_RESULT_TIMEOUT_MS`（默认 `86400000`，24h）
  - `TFCLAW_PROGRESS_RECALL_DELAY_MS`（默认 `350`ms）
  - `TFCLAW_FEISHU_ACK_REACTION_ENABLED`（默认 `1`）
  - `TFCLAW_FEISHU_ACK_REACTION`（默认 `OnIt`）
- terminal-agent
  - `TFCLAW_TMUX_SUBMIT_DELAY_MS`（默认 `60`）
  - `TFCLAW_TMUX_STREAM_POLL_MS`（默认 `350`）
  - `TFCLAW_TMUX_STREAM_IDLE_MS`（默认 `3000`）
  - `TFCLAW_TMUX_STREAM_INITIAL_SILENCE_MS`（默认 `12000`）
  - `TFCLAW_TMUX_STREAM_WINDOW_MS`（默认 `86400000`，24h）

## 已知限制（MVP）

- `terminal-agent` 已切到 `tmux` 渲染/会话模型，仍未支持移动端驱动的动态 resize。
- 窗口枚举/窗口截图当前仅在 Windows agent 上实现；Linux/macOS 暂仅屏幕截图。
- 未实现用户注册；身份依赖共享 token。
- `/tmux send` 这类“需要读取 tmux 内容”的命令会比纯文本命令（如 `/tmux help`）慢，这是预期行为：
  需要经过 tmux 执行、等待窗口和捕获输出（并可能进入流式收敛）。

## 后续建议

1. 增加 terminal resize 协议，适配手机端横竖屏和不同字号。
2. server 增加持久化存储（终端元数据、会话历史、用户体系）。
3. mobile 增加平台-会话分组与滚动历史加载。
4. gateway 继续补齐 Telegram/Discord/Slack 等通道的 connect/send 实现（当前已提供 connect 生命周期骨架）。
