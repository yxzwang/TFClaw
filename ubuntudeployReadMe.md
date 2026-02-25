# TFClaw Ubuntu 一键部署说明

本文对应脚本：`scripts/deploy-ubuntu-public.sh`  
目标：在 Ubuntu 上一条命令部署 TFClaw `server` 并通过 Cloudflare Quick Tunnel 暴露公网 `wss` 地址。

## 1. 一键部署（推荐）

在 Ubuntu 终端执行：

```bash
curl -fsSL https://raw.githubusercontent.com/yxzwang/TFClaw/main/scripts/deploy-ubuntu-public.sh -o /tmp/deploy-tfclaw.sh && sudo bash /tmp/deploy-tfclaw.sh
```

部署完成后会打印两项关键值：

```bash
TFCLAW_TOKEN=...
TFCLAW_RELAY_URL=wss://xxxx.trycloudflare.com
```

把这两个值填到你的 terminal-agent / mobile app 配置里即可连接。

## 2. 从本仓库本地执行

```bash
git clone https://github.com/yxzwang/TFClaw.git
cd TFClaw
sudo bash scripts/deploy-ubuntu-public.sh
```

## 3. 脚本默认会做什么

脚本会自动完成：

1. 安装依赖（`curl/git/jq/openssl` 等）
2. 安装 Node.js 20（若当前版本低于 20）
3. 安装 `cloudflared`（默认开启）
4. 拉取/使用代码并构建 `@tfclaw/protocol` 与 `@tfclaw/server`
5. 创建系统用户 `tfclaw`
6. 生成强 token（你没传 `TFCLAW_TOKEN` 时自动生成）
7. 写入 `/etc/tfclaw/server.env`（包含限流与安全参数）
8. 注册并启动两个 systemd 服务：
   - `tfclaw-server`
   - `tfclaw-cloudflared`

## 4. 一键命令可选参数

### 指定固定 token（建议）

```bash
sudo TFCLAW_TOKEN='your-long-random-token-32chars-min' bash scripts/deploy-ubuntu-public.sh
```

### 关闭 Cloudflare Tunnel（只内网/反代使用）

```bash
sudo TFCLAW_ENABLE_CLOUDFLARE_TUNNEL=0 bash scripts/deploy-ubuntu-public.sh
```

### 自定义端口/路径

```bash
sudo TFCLAW_SERVER_PORT=8787 TFCLAW_WS_PATH='/' bash scripts/deploy-ubuntu-public.sh
```

### 自定义安装目录/分支

```bash
sudo TFCLAW_INSTALL_DIR=/opt/token-free-claw TFCLAW_REPO_REF=main bash scripts/deploy-ubuntu-public.sh
```

## 5. 部署后常用运维命令

```bash
systemctl status tfclaw-server
journalctl -u tfclaw-server -f

systemctl status tfclaw-cloudflared
journalctl -u tfclaw-cloudflared -f
```

重启服务：

```bash
sudo systemctl restart tfclaw-server
sudo systemctl restart tfclaw-cloudflared
```

## 6. WSL 部署说明（Windows）

可以在 WSL2 Ubuntu 部署，但必须开启 `systemd`，否则脚本会直接报错退出。

在 WSL Ubuntu 中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

然后在 Windows PowerShell 执行：

```powershell
wsl --shutdown
```

重新打开 Ubuntu 后再执行一键部署命令。

## 7. 常见问题

### 1) 没看到 `trycloudflare.com` 地址

- 先看日志：`journalctl -u tfclaw-cloudflared -f`
- 有时 cloudflared 启动稍慢，等待几十秒后再看

### 2) 外网连不上

- 确认 `tfclaw-server` 和 `tfclaw-cloudflared` 都是 `active (running)`
- 确认客户端使用的是脚本输出的 `TFCLAW_RELAY_URL`

### 3) token 错误

- 服务端只允许 `/etc/tfclaw/server.env` 里的 `RELAY_ALLOWED_TOKENS`
- 客户端 `TFCLAW_TOKEN` 必须完全一致

## 8. 安全建议（生产）

1. 使用 32+ 长度随机 token，并定期轮换
2. 不要把 token 提交到仓库或聊天记录中
3. Quick Tunnel 适合快速测试；生产建议改为 Cloudflare Named Tunnel + 自有域名
