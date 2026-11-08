# 机器人部署文档（Windows / Linux / Docker）

VirtualWait 机器人只负责**队列叫号通知**，由两部分组成：

1. **协议端 NapCat**：登录机器人 QQ 小号，提供 OneBot v11 WebSocket 服务（`127.0.0.1:3001`）
2. **机器人端 NoneBot2**：加载 `services/bot/plugins/` 插件，连接 NapCat，
   轮询 VirtualWait Web 的 Bot API 并在机台空闲时 @ 队首

```
手机QQ(机器人小号) ⇄ NapCat(127.0.0.1:3001) ⇄ NoneBot2(:8080) ⇄ VirtualWait Web /api/bot/*
```

机器人不需要任何游戏账号或协议参数；只需要 Web 的地址与 `BOT_API_TOKEN`。

## 环境要求

| 组件 | Windows | Linux / macOS |
|------|---------|---------------|
| Python | 3.10+ | 3.10+ |
| Node.js | 18+（NapCat 需要） | 18+（NapCat 本机部署时） |
| QQ | 桌面版 QQ NT | 无需（NapCat 独立运行） |
| 网络 | 能访问 VirtualWait Web | 同左 |

---

## 一、Windows 部署

### 1. 协议端 NapCat

1. 下载 NapCat Windows 包，把内容解压到 `napcat/shell/`
   （需含 `NapCatWinBootMain.exe`、`napcat.mjs`、`loadNapCat.js`、`qqnt.json`、`NapCatWinBootHook.dll`）
2. 本机安装桌面版 QQ NT（机器人运行时桌面 QQ 会被占用，主号需退出）
3. 配置 `napcat/shell/config/onebot11_<机器人QQ号>.json`：
   `websocketServers` 开启一个端口为 `3001` 的服务端
4. 首次启动后打开 `http://127.0.0.1:6099/webui` 扫码登录机器人 QQ

### 2. 机器人端 NoneBot2

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

在 `.env` 里填写：`QUEUE_NOTIFY_BASE_URL`（VirtualWait Web 地址）、
`QUEUE_NOTIFY_BOT_TOKEN`（与 Web 的 `BOT_API_TOKEN` 一致）、
`QUEUE_NOTIFY_DEFAULT_GROUP` 或 `QUEUE_NOTIFY_ROUTING`。

### 3. 启动

```bat
运行 `start_bot.bat`（或 `python bot.py`）
```

验证：NoneBot 日志出现 `OneBot V11 | Bot <QQ号> connected` 即链路打通；
私聊机器人发 `/vw_queue_status` 可查看轮询状态。

### 4. 守护进程（可选，自动重启）

- `python napcat_guard.py`：NapCat 崩溃自动重启
- `python start_wrapper.py`：NoneBot 崩溃自动重启

---

## 二、Linux / macOS 部署

### 1. 协议端 NapCat（二选一）

- **Docker（推荐）**：按 NapCat 官方说明以容器运行，把 OneBot v11 WebSocket
  服务端映射到宿主机 `127.0.0.1:3001`（机器人端直连即可，无需 `napcat/` 目录）
- **本机 node**：把 NapCat Linux 包放进 `napcat/shell/`（需含 `napcat.mjs` 等），
  然后 `bash napcat/start_napcat.sh`

> `start.sh`（本目录）只启动 NoneBot2；NapCat 需先按上面任一方式就绪。

### 2. 机器人端 NoneBot2

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

### 3. 启动

```bash
bash start.sh          # 本机 NapCat 已在跑时直接 python bot.py 亦可
```

### 4. 守护进程（可选，自动重启）

- `python napcat_guard.py`：Linux 下以 `node napcat.mjs` 方式守护
- `python start_wrapper.py`：NoneBot 崩溃自动重启（跨平台）

---

## 三、Docker 部署（推荐，开箱即用）

仓库提供 `infra/docker/docker-compose.bot.yml`，同时拉起 NapCat（OneBot 协议端）
与 VirtualWait 机器人（NoneBot2）。compose 给 NapCat 设了 `MODE=ws`，官方镜像会自动启用
OneBot v11 正向 WebSocket 服务端（`0.0.0.0:3001`），登录 QQ 后机器人即通过
`ws://napcat:3001` 连上。整个链路**唯一手动步骤就是扫码登录 QQ**。

机器人镜像只包含 `services/bot`，不含任何个人配置或运行数据
（`.env`、`napcat/`、QQ 登录态都不会打进镜像）。

### 3.1 一键启动

```bash
docker compose -f infra/docker/docker-compose.bot.yml up -d --build
```

镜像默认来自 `ghcr.io/bad0rang3/virtualwait-bot:latest`（CI 自动构建），
本地已有镜像时可去掉 `--build` 直接 `up -d`。

启用叫号前，在 `infra/docker/.env` 里配置：

```bash
cd infra/docker
cat > .env <<'EOF'
QUEUE_NOTIFY_BASE_URL=http://你的Web地址:3000
QUEUE_NOTIFY_BOT_TOKEN=<与 Web 的 BOT_API_TOKEN 一致>
QUEUE_NOTIFY_DEFAULT_GROUP=<通知群号，留空则按场地 groupUmo 路由>
EOF
```

### 3.2 扫码登录机器人 QQ（唯一手动步骤）

```bash
docker compose -f infra/docker/docker-compose.bot.yml logs napcat | grep -E "WebUi (Token|User Panel Url)"
```

用日志里的完整地址打开 WebUI 扫码登录（首次启动 NapCat 会把默认 token 随机化，
所以地址以日志为准；也可用 `WEBUI_TOKEN=<强密码> docker compose ... up -d` 固定它）。
该端口仅建议本机访问，勿暴露公网。

### 3.3 验证与运维

```bash
docker compose -f infra/docker/docker-compose.bot.yml ps
docker compose -f infra/docker/docker-compose.bot.yml logs -f virtualwait-bot
docker compose -f infra/docker/docker-compose.bot.yml down        # 停止（保留登录态与数据卷）
docker compose -f infra/docker/docker-compose.bot.yml down -v     # 删除数据卷（需重新登录）
```

QQ 登录态与 NapCat 配置保存在命名卷 `napcat_qq`、`napcat_config` 中。

> 旧部署升级：若之前未配 `MODE=ws` 时已登录过，需删除 NapCat 卷里的
> `onebot11_<QQ号>.json`（或 WebUI 里给账号新建 3001 正向 WS），让预置配置重新生效。

---

## 四、常见问题

| 现象 | 处理 |
|------|------|
| NoneBot 反复报 `Error while setup websocket to ws://127.0.0.1:3001` | NapCat 未启动/未登录；打开 `http://127.0.0.1:6099/webui` 扫码 |
| 反向 WS 404 | venv 里装 `websockets`：`pip install websockets` |
| 群内收不到提醒 | 检查 `QUEUE_NOTIFY_BOT_TOKEN` 是否与 Web `BOT_API_TOKEN` 一致、机器人在目标群、场地 `group_umo` 是否配置 |
| Docker 拉 `mlikiowa/napcat-docker` 超时 | 给 Docker 配 registry mirror，或 `docker save`/`load` 离线迁移 |
| Windows 无法同时跑主号 QQ | QQ NT 单实例限制：机器人运行时桌面主号 QQ 需关闭 |

## 安全提示

- `QUEUE_NOTIFY_BOT_TOKEN` 是访问 Web Bot API 的凭据，Bot API 会返回队首 QQ 号，
  视为管理面：只走受控内网，勿暴露公网，勿进日志或聊天记录
- NapCat 端口（3001/6099/8080）勿暴露公网
- QQ 小号风控自负
