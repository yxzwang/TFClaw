# TFClaw Docker（无 systemd）一键部署说明

本文对应脚本：`scripts/deploy-docker-public.sh`  
适用场景：你在 **Docker 容器内**，没有 `systemd`，需要直接跑 TFClaw relay server 并通过 Cloudflare Quick Tunnel 提供公网 `wss` 地址。

## 1. 一键部署命令

在容器内（root）执行：

```bash
curl -fsSL https://raw.githubusercontent.com/yxzwang/TFClaw/main/scripts/deploy-docker-public.sh -o /tmp/deploy-tfclaw-docker.sh && bash /tmp/deploy-tfclaw-docker.sh start
```

部署成功会输出：

```bash
TFCLAW_TOKEN=...
TFCLAW_RELAY_URL=wss://xxxx.trycloudflare.com
```

把这两个值填到 `terminal-agent` 或 mobile app 即可连接。

## 2. 这个脚本会自动做什么

`start` 动作默认会：

1. 安装依赖（`curl/git/openssl` 等）
2. 安装 Node.js 20（如当前不足 20）
3. 安装 `cloudflared`（默认开启）
4. 拉取代码到 `/opt/token-free-claw`（已存在则复用）
5. `npm ci` 并构建 `@tfclaw/protocol` + `@tfclaw/server`
6. 使用 `nohup` 启动 server 与 cloudflared（无 systemd）
7. 写运行信息到 `/opt/tfclaw-state/runtime.env`

默认优化：`start` 时如果依赖和构建产物已存在，会自动跳过重复安装和重复构建。

## 3. Token 会随机生成吗？

会。规则如下：

1. 你传了 `TFCLAW_TOKEN`：使用你提供的值。
2. 你没传，但 `runtime.env` 里已有历史 token：复用历史 token（避免每次变更）。
3. 都没有：自动随机生成一个 48 位字母数字 token。

所以首次可随机，后续默认稳定不变。

## 4. 常用命令

### 启动/部署

```bash
bash scripts/deploy-docker-public.sh start
```

### 停止

```bash
bash scripts/deploy-docker-public.sh stop
```

### 状态

```bash
bash scripts/deploy-docker-public.sh status
```

### 查看日志

```bash
bash scripts/deploy-docker-public.sh logs
```

## 5. 常用环境变量

```bash
TFCLAW_TOKEN='your-strong-token'
TFCLAW_ENABLE_CLOUDFLARE_TUNNEL=1
TFCLAW_SERVER_PORT=8787
TFCLAW_SERVER_HOST=0.0.0.0
TFCLAW_REPO_REF=main
TFCLAW_INSTALL_DIR=/opt/token-free-claw
TFCLAW_STATE_DIR=/opt/tfclaw-state
TFCLAW_FORCE_SETUP=0
TFCLAW_FORCE_BUILD=0
```

示例：

```bash
TFCLAW_TOKEN='replace-with-strong-token' TFCLAW_SERVER_PORT=8787 bash scripts/deploy-docker-public.sh start
```

如需强制重装依赖并重新构建：

```bash
TFCLAW_FORCE_SETUP=1 TFCLAW_FORCE_BUILD=1 bash scripts/deploy-docker-public.sh start
```

## 6. 运行信息与日志位置

- 运行状态：`/opt/tfclaw-state/runtime.env`
- server 日志：`/var/log/tfclaw-server.log`
- tunnel 日志：`/var/log/tfclaw-cloudflared.log`

查看当前 token/url：

```bash
cat /opt/tfclaw-state/runtime.env
```

## 7. 注意事项

1. 该脚本假定容器基于 Ubuntu/Debian（可用 `apt-get`）。
2. Quick Tunnel URL 在进程重启后可能变化。生产建议使用 Cloudflare Named Tunnel + 域名。
3. 若你不想走 cloudflared，可设置 `TFCLAW_ENABLE_CLOUDFLARE_TUNNEL=0`，然后自己做反代/TLS。

## 8. Terminal-agent 默认行为（新增）

从当前版本开始，`start` 默认会自动启动 `terminal-agent`（`TFCLAW_ENABLE_TERMINAL_AGENT=1`）。

- agent 连接地址：`ws://127.0.0.1:<TFCLAW_SERVER_PORT><TFCLAW_WS_PATH>`
- agent token：与服务端 `TFCLAW_TOKEN` 相同
- agent 日志：`/var/log/tfclaw-terminal-agent.log`

如果你只想启动 relay server + tunnel，不启动 agent：

```bash
TFCLAW_ENABLE_TERMINAL_AGENT=0 bash scripts/deploy-docker-public.sh start
```
