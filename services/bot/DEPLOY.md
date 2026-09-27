# 机器人部署文档（Windows / Linux）

B50 Bot 由两部分组成：

1. **协议端 NapCat**：登录机器人 QQ 小号，提供 OneBot v11 WebSocket 服务（`127.0.0.1:3001`）
2. **机器人端 NoneBot2**：加载 `services/bot/plugins/` 插件，连接 NapCat，处理 `/b50`、`/fp`、`/vw_queue_status` 命令

```
手机QQ(机器人小号) ⇄ NapCat(127.0.0.1:3001) ⇄ NoneBot2(:8080) ⇄ sdgb → 成绩接口/渲染服务
```

## 环境要求

| 组件 | Windows | Linux / macOS |
|------|---------|---------------|
| Python | 3.10+ | 3.10+ |
| Node.js | 18+（NapCat 需要） | 18+（NapCat 本机部署时） |
| QQ | 桌面版 QQ NT | 无需（NapCat 独立运行） |
| 网络 | 可访问游戏服务器与渲染服务 | 同左 |

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
```

**无需填写任何配置**：SDGB 的国服公开参数（AES/AIME/机厅）已内置在
`packages/sdgb-client/sdgb/settings.py`。仅当要换机厅或换版本时，才复制
`settings_local.example.py` 为 `settings_local.py` 覆盖对应字段，或改用 `VW_SDGB_*` 环境变量。

### 3. 启动

```bat
运行 `start_bot.bat`（或 `python bot.py`）
```

验证：NoneBot 日志出现 `OneBot V11 | Bot <QQ号> connected` 即链路打通。

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

> `start.sh`（本目录）只启动 NoneBot2；NapCat 需先按上面任一方式就绪，
> 因此 Docker 部署同样兼容。

### 2. 机器人端 NoneBot2

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**无需填写任何配置**：默认参数已内置（字段说明同 Windows）。

### 3. 启动

```bash
bash start.sh          # 本机 NapCat + NoneBot 一起拉（服务目录内）
# NapCat 已在跑（含 Docker）时直接运行：
python bot.py
```

验证：NoneBot 日志出现 `OneBot V11 | Bot <QQ号> connected`。

### 4. 守护进程（可选，自动重启）

- `python napcat_guard.py`：Linux 下以 `node napcat.mjs` 方式守护
- `python start_wrapper.py`：NoneBot 崩溃自动重启（跨平台）

---

## 三、Docker 部署（推荐，开箱即用）

仓库提供 `infra/docker/docker-compose.bot.yml`，同时拉起 NapCat（OneBot 协议端）与 VirtualWait 机器人（NoneBot2）。**WebSocket 已预置好**：compose 给 NapCat 设了 `MODE=ws`，官方镜像会自动启用 OneBot v11 正向 WebSocket 服务端（`0.0.0.0:3001`）；登录 QQ 后 B50 机器人即通过 `ws://napcat:3001` 连上。整个链路**唯一手动步骤就是扫码登录 QQ**。

机器人镜像为**预构建、可复用**：镜像内置国服公开的 SDGB 默认参数（`settings.py`），不包含个人/机厅私有覆盖或运行数据（`settings_local.py`、`.env`、`napcat/`、QQ 登录态均不会打进镜像）；如需换机厅，用 `VW_SDGB_*` 环境变量覆盖即可。

### 3.1 一键启动（推荐，从源码构建）

**无需任何配置**，一条命令即可拉起 NapCat + 机器人（镜像内置公开的 SDGB 默认参数）：

```bash
docker compose -f infra/docker/docker-compose.bot.yml up -d --build
```

> 国内网络可用 `--build-arg` 加速 pip；见 `infra/docker/Dockerfile.bot` 头部注释。

若使用已打好的预构建镜像（需为含内置默认参数的新版本），两种来源：

- **GHCR（CI 自动构建）**：推送到 `main` / 打 `v*` tag 时，`.github/workflows/docker-bot.yml` 会自动构建并推送。
  ```bash
docker pull ghcr.io/bad0rang3/virtualwait-bot:latest
docker tag  ghcr.io/bad0rang3/virtualwait-bot:latest bad0rang3/maidxtool:latest
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build
```
- **离线 tar**：同一 workflow 会产出 `virtualwait-bot-<sha>.tar.gz` 构件（Actions → 对应 run → Artifacts，或从 `dist/` 获取），
  ```bash
docker load -i dist/virtualwait-bot-<sha>.tar.gz
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build
```

自行本地打包（需已装 Docker）：

```bash
docker build -f infra/docker/Dockerfile.bot -t bad0rang3/maidxtool:latest .
mkdir -p dist && docker save bad0rang3/maidxtool:latest | gzip > dist/virtualwait-bot-local.tar.gz

2. **无需任何配置**：镜像已内置公开的 SDGB 默认参数，直接进入下一步。仅当需要覆盖机厅信息或启用队列叫号时，才在 `infra/docker/` 下新建可选 `.env`（示例）：

```bash
cd infra/docker
cat > .env <<'EOF'
# 队列叫号（可选；不配则仅 B50/FP 可用）
QUEUE_NOTIFY_BASE_URL=http://你的Web地址:3000
QUEUE_NOTIFY_BOT_TOKEN=<与 Web 的 BOT_API_TOKEN 一致>
QUEUE_NOTIFY_DEFAULT_GROUP=<通知群号，留空则按场地 groupUmo 路由>
# 换机厅/换版本时覆盖（可选）
VW_SDGB_REGION_ID=1
VW_SDGB_PLACE_ID=1403
VW_SDGB_CLIENT_ID=A63E01C2805
VW_SDGB_KEYCHIP_ID=A63E-01C28055905
EOF
```

3. 启动（`--no-build` 表示直接使用已加载的预构建镜像，不现场构建）：

```bash
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build
```

4. 扫码登录机器人 QQ（唯一手动步骤）：

```bash
docker compose -f infra/docker/docker-compose.bot.yml logs napcat | grep -E "WebUi (Token|User Panel Url)"
```

用日志里的完整地址打开 WebUI 扫码登录（首次启动 NapCat 会把默认 token 随机化，所以地址以日志为准；也可用 `WEBUI_TOKEN=<强密码> docker compose -f infra/docker/docker-compose.bot.yml up -d` 固定它）。该端口仅建议本机访问，勿暴露公网。

登录成功后自动完成：NapCat 监听 3001 → B50 机器人自动连上（日志出现 `OneBot V11 | Bot <QQ号> connected`）→ 私聊机器人发 `/help` 即可使用。

### 3.2 源码构建（开发 / 改代码时）

```bash
docker compose -f infra/docker/docker-compose.bot.yml up -d --build
```

机厅密钥同样通过 `infra/docker/.env` 的环境变量注入；镜像构建上下文有白名单式 `.dockerignore`，**不会**包含本地密钥/运行数据。如需使用自定义镜像仓库或标签：

```bash
VIRTUALWAIT_BOT_IMAGE=ghcr.io/你的账号/virtualwait-bot:1.0.0 \
  docker compose -f infra/docker/docker-compose.bot.yml up -d
```

### 3.3 验证

```bash
docker compose -f infra/docker/docker-compose.bot.yml ps
docker compose -f infra/docker/docker-compose.bot.yml logs -f virtualwait-bot
```

NoneBot 日志出现 `OneBot V11 | Bot <QQ号> connected` 即链路打通。

### 3.4 运维

- 改 `infra/docker/.env` 后重启：`docker compose -f infra/docker/docker-compose.bot.yml up -d`
- `docker compose -f infra/docker/docker-compose.bot.yml down`：停止（保留 QQ 登录态与数据卷）
- 升级镜像：`docker load -i dist/virtualwait-qqbot-stack.<新版本>.tar.gz && docker compose -f infra/docker/docker-compose.bot.yml up -d`
- 从源码升级：`git pull && docker compose -f infra/docker/docker-compose.bot.yml up -d --build`

QQ 登录态、NapCat 配置与 B50 缓存分别保存在命名卷 `napcat_qq`、`napcat_config`、`b50_data` 中；`docker compose -f infra/docker/docker-compose.bot.yml down -v` 会删除它们，需重新登录。

> 旧部署升级：若之前未配 `MODE=ws` 时已登录过，需删除 NapCat 卷里的
> `onebot11_<QQ号>.json`（或 WebUI 里给账号新建 3001 正向 WS），让预置配置重新生效。
>
> 仅重新打包机器人镜像：`docker build -f infra/docker/Dockerfile.bot -t virtualwait-bot:1.0.0 -t virtualwait-bot:latest .`，编排与配置见 `infra/docker/`。
## 四、验证与使用

1. QQ 里私聊机器人发 `/help`，返回菜单即成功
2. 机台登录界面拍下二维码，用任意扫码工具解析出字符串（SGWCMAID...）
3. 发 `/b50 <二维码字符串>` → 收到完整 B50 图，图片下方附「✅ 已登出」

---

## 五、常见问题

| 现象 | 处理 |
|------|------|
| NoneBot 反复报 `Error while setup websocket to ws://127.0.0.1:3001` | NapCat 未启动/未登录；打开 `http://127.0.0.1:6099/webui` 扫码 |
| 反向 WS 404 | venv 里装 `websockets`：`pip install websockets` |
| `/b50` 报「凭证可能已过期」 | 二维码 10 分钟有效，换新码重试 |
| `isLogin=1`（小黑屋） | 等 15 分钟自动解除，期间不要反复登录；同账号 10 分钟内重复 `/b50` 走本地缓存 |
| Linux 下 NapCat 起不来 | 改用 Docker 部署，确认 WS 服务端可达 `127.0.0.1:3001` |
| Docker 拉 `mlikiowa/napcat-docker` 超时/失败 | 国内网络给 Docker 配 registry mirror（见 `infra/docker/docker-compose.bot.yml`），或 `docker save`/`load` 离线迁移 |
| 群里发命令没反应 | 群聊需 @机器人；私聊直接发 |
| Windows 无法同时跑主号 QQ | QQ NT 单实例限制：机器人运行时桌面主号 QQ 需关闭 |

## 安全提示

- `settings.py` 内置的是公开协议参数；`settings_local.py`（若使用）与 `token_cache.json` / `records_cache.json` 含个人/账号数据，勿外传
- NapCat 端口（3001/6099/8080）勿暴露公网
- QQ 小号风控自负；二维码字符串是登录凭证，建议私聊发送
