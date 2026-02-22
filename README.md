# Token-Free-Claw (TFClaw)

TFClaw 是一个“面向 terminal 的远程桌面”MVP：

1. `server` 只做转发与状态缓存（按 token 组织会话）。
2. `terminal-agent` 运行在用户电脑/服务器上，管理多个 terminal 并上报输出。
3. `mobile`（Android 优先）查看 terminal 列表、输出，并发送命令（含 Ctrl+D 等控制键）。
4. `feishu-gateway` 用飞书长连接机器人把消息映射为 terminal 指令。

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
- feishu-gateway 支持：
  - `/list` `/new` `/use` `/close` `/ctrlc` `/ctrld`
  - `terminalId: command` 形式
  - 选中 terminal 后直接发送命令
  - `/capture` 返回“屏幕/窗口编号列表”，回复数字后回传对应图片

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

## 飞书网关启动

1. 在飞书开放平台创建应用并启用 Bot。
2. 权限添加 `im:message`，事件添加 `im.message.receive_v1`。
3. 事件订阅选择 **长连接（Long Connection）**。
4. 配置环境变量（见 `apps/feishu-gateway/.env.example`）。

Windows PowerShell：

```powershell
$env:FEISHU_APP_ID='cli_xxx'
$env:FEISHU_APP_SECRET='xxx'
$env:TFCLAW_TOKEN='demo-token'
$env:TFCLAW_RELAY_URL='ws://127.0.0.1:8787'
npm run dev:feishu
```

## Android APK 构建

见 `apps/mobile/README.md`，使用 EAS 进行 `preview` APK 构建。

## 环境变量

- `apps/server/.env.example`
- `apps/terminal-agent/.env.example`
- `apps/mobile/.env.example`
- `apps/feishu-gateway/.env.example`

## 已知限制（MVP）

- `terminal-agent` 已切到 `tmux` 渲染/会话模型，仍未支持移动端驱动的动态 resize。
- 窗口枚举/窗口截图当前仅在 Windows agent 上实现；Linux/macOS 暂仅屏幕截图。
- 未实现用户注册；身份依赖共享 token。

## 后续建议

1. 增加 terminal resize 协议，适配手机端横竖屏和不同字号。
2. server 增加持久化存储（终端元数据、会话历史、用户体系）。
3. mobile 增加平台-会话分组与滚动历史加载。
4. feishu-gateway 增加输出节流与多图/文件回传能力。
