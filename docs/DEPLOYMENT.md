# 运行流程与自托管部署

本文说明系统如何运作，以及如何在一台 Linux 服务器上完成部署、验收与日常维护。
模板中的命令与配置都是起点，请按现场情况调整。

## 0. 部署方式一览

| 方式 | 适用 | 组件 |
|---|---|---|
| A：Linux 全栈（systemd + Nginx） | 推荐生产 | Web + 可选 QQ 机器人 |
| B：机器人 Docker 预构建镜像 | 推荐机器人 | NapCat + NoneBot2 |
| C：本地 / 内网开发 | 开发体验 | 同 A，无 TLS |

Web 是唯一的服务端组件：身份、队列、管理台和 Bot API 都在同一个 Next.js 进程，
数据在本地 SQLite。系统不连接任何外部身份服务或游戏服务器。

## 1. 系统如何运作

```text
玩家浏览器
  │ 1. 打开 /login，用场地签到码注册账号（或直接登录）
  │ 2. 在 /me 绑定 QQ（默认排队必填）
  │ 3. 在机台页入队 / 拼机 / 确认上机 / 结束游玩
  ▼
Web (Next.js) ── 本地 SQLite：账号、口令哈希、队列、会话、审计、设置
  ▲
  │ 服务端动作：队头确认超时整组回队尾、游玩超时回队尾、维护清理
  │
  └── Bot API (Bearer) ◄── QQ 机器人轮询：机台空闲 → 群内 @ 队首
```

关键时间参数：

| 参数 | 默认 | 含义 |
|---|---|---|
| `HEAD_CONFIRM_TIMEOUT_SEC` | 180 | 空闲机台的队首确认窗口，超时整组回队尾 |
| `PLAYING_TIMEOUT_SEC` | 1500 | 单次游玩上限，超时回队尾 |
| `CHECKIN_WINDOW_SEC` | 600 | 场地签到码轮换周期 |
| `SESSION_MAX_AGE_DAYS` | 30 | 登录会话有效期 |

## 2. 部署前准备

### 服务器与网络

- 一台 Linux 主机（systemd），Node.js 22.5+；Python 3.10+ 仅机器人需要；
- 一个域名与证书（推荐 HTTPS）；Web 只监听 `127.0.0.1:3000`；
- 数据目录与备份目录放在仓库之外，权限最小化。

### 业务资料

- 替换 `apps/web/src/lib/constants/catalog.ts` 中的示例城市、区县、场地、机台；
- 准备场地现场张贴签到码的方式（前台屏幕、群公告、纸质告示均可）。

### 必须生成并妥善保存的值

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # ADMIN_API_TOKEN
openssl rand -hex 32   # BOT_API_TOKEN（启用机器人时；机器人端填同名值给 QUEUE_NOTIFY_BOT_TOKEN）
```

每个环境独立，长度 ≥32 字符；只放进 secret manager 或权限 `0600` 的环境文件。

## 3. 推荐部署步骤

### 3.1 创建运行账户、目录和代码副本

```bash
sudo useradd --system --create-home --home-dir /opt/virtualwait virtualwait
sudo -u virtualwait git clone <repo> /opt/virtualwait
sudo mkdir -p /var/lib/virtualwait/web /var/backups/virtualwait /etc/virtualwait
sudo chown -R virtualwait:virtualwait /var/lib/virtualwait /var/backups/virtualwait
sudo chmod 700 /etc/virtualwait
```

### 3.2 构建并配置 Web

```bash
cd /opt/virtualwait/apps/web
sudo -u virtualwait npm ci
sudo -u virtualwait npm run build
```

复制 [Web 生产样例](../infra/server/env/web.production.env.example) 到 `/etc/virtualwait/web.env`，
`chmod 0600`，并替换每个 `CHANGE_ME_*`：

```ini
NODE_ENV=production
APP_BASE_URL=https://wait.example.com
VIRTUALWAIT_DATA_DIR=/var/lib/virtualwait/web
VIRTUALWAIT_BACKUP_DIR=/var/backups/virtualwait
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_API_TOKEN=<openssl rand -hex 32>
REGISTRATION_ENABLED=true
CHECKIN_REQUIRED=true
CHECKIN_WINDOW_SEC=600
IP_ACCOUNT_QUOTA_PER_DAY=5
TRUST_PROXY_HEADERS=true
HOST=127.0.0.1           # 只监听回环，避免绕过代理伪造 IP
PORT=3000
DB_BUSY_TIMEOUT_MS=5000  # web 与维护进程共用同一 SQLite 文件
BOT_API_TOKEN=           # 启用机器人时填写
```

> 关闭自助注册（`REGISTRATION_ENABLED=false`）后，用现场开户 CLI 建号：
>
> ```bash
> cd /opt/virtualwait/apps/web
> sudo -u virtualwait env $(grep -v '^#' /etc/virtualwait/web.env | xargs) >   sh -c "printf '%s' '玩家的口令' | npm run account:create -- --username player01 --nickname '玩家一号' --qq 12345678"
> ```
>
> 校验规则与自助注册一致（用户名/昵称/口令强度），不需要签到码，也不消耗每 IP 配额；
> 口令走 stdin 可避免进入 shell 历史。

验证形状（不会写入任何部署文件）：

```bash
sudo -u virtualwait env $(grep -v '^#' /etc/virtualwait/web.env | xargs) \
  npm run preflight -- --production
```

### 3.3 安装 systemd 服务

```bash
sudo cp infra/server/systemd/virtualwait-*.service infra/server/systemd/virtualwait-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now virtualwait-web.service virtualwait-maintenance.service
sudo systemctl enable --now virtualwait-backup.timer virtualwait-healthcheck.timer
systemctl status virtualwait-web.service
```

| 单元 | 作用 |
|---|---|
| `virtualwait-web.service` | Next.js 生产服务（`npm run start`） |
| `virtualwait-maintenance.service` | 常驻维护：超时推进 + 保留策略清理 |
| `virtualwait-backup.timer` | 定期 SQLite 备份 |
| `virtualwait-healthcheck.timer` | 每分钟探活 `/api/healthz` |

> 生产强制 `TRUST_PROXY_HEADERS=true`，客户端 IP 完全来自代理头。因此 `npm run start`
> 默认只监听 `127.0.0.1`；请勿改成对外地址，并在宿主机防火墙上封禁应用端口——
> 直连端口即可伪造 IP，从而绕过每 IP 注册配额、登录限流与会话 IP 绑定。

### 3.4 配置 Nginx（HTTPS 可选）

使用 [virtualwait.conf](../infra/server/nginx/virtualwait.conf)（生产 TLS）或
[virtualwait-intranet.conf](../infra/server/nginx/virtualwait-intranet.conf)（受控内网 HTTP）。
模板要点：代理到 `127.0.0.1:3000`、强制 HTTPS、覆盖 `X-Forwarded-For`/`X-Real-IP`、
对外隐藏 `/api/healthz`。

```bash
sudo cp infra/server/nginx/virtualwait.conf /etc/nginx/sites-available/virtualwait
sudo ln -s /etc/nginx/sites-available/virtualwait /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 3.5 首次上线检查

1. 打开 `/admin`，用 `ADMIN_API_TOKEN` 登录；
2. 在「场地签到码」面板确认每场地都显示了 6 位码，并可「立即轮换」；
3. 用一个测试账号走完注册 → 绑定 QQ → 入队 → 确认上机 → 结束；
4. 检查审计事件里出现 `ACCOUNT_REGISTERED` / `ENTRY_JOINED` 等记录。

## 4. 启用 QQ 机器人叫号（可选）

Web 侧需要非空 `BOT_API_TOKEN`。机器人侧配置 `QUEUE_NOTIFY_BASE_URL` 与
`QUEUE_NOTIFY_BOT_TOKEN`（与 Web 一致），可选 `QUEUE_NOTIFY_DEFAULT_GROUP` / `QUEUE_NOTIFY_ROUTING`。

### 4.1 机器人 Docker 一键部署（推荐）

```bash
# 在线（GHCR）
docker pull ghcr.io/bad0rang3/virtualwait-bot:latest
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build

# 离线/内网：使用预构建离线包（dist/）
docker load -i dist/virtualwait-bot-<sha>.tar.gz
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build

# 改代码时现场构建
docker compose -f infra/docker/docker-compose.bot.yml up -d --build

# 扫码登录机器人 QQ（唯一手动步骤）
docker compose -f infra/docker/docker-compose.bot.yml logs napcat | grep -E "WebUi (Token|User Panel Url)"
```

在 `infra/docker/.env` 中配置：

```ini
QUEUE_NOTIFY_BASE_URL=https://wait.example.com
QUEUE_NOTIFY_BOT_TOKEN=<与 Web 的 BOT_API_TOKEN 一致>
QUEUE_NOTIFY_DEFAULT_GROUP=<兜底群号，可留空>
```

### 4.2 本机 venv 部署

```bash
cd services/bot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env      # 填写 ONEBOT_WS_URLS / QUEUE_NOTIFY_*
.venv/bin/python bot.py
```

细节与排障见 [services/bot/DEPLOY.md](../services/bot/DEPLOY.md) 与
[QUEUE_NOTIFY.md](QUEUE_NOTIFY.md)。

## 5. 升级、备份与日常维护

### 5.1 从旧版本升级（重要）

旧版本使用外部扫码身份，账号表结构不同。升级后 `lib/db/migrate.ts` 会：

- 重建 `app_user` 为本地账号结构；
- 清空 `session`、`queue_entry`、`queue_party`、`ip_day_binding`；
- 删除旧身份相关表。

**旧账号没有本地口令，无法迁移**。请在升级前公告「玩家需用用户名 + 口令 + 当场签到码重新注册」，
并选择低峰期执行。升级后建议立即轮换一次签到码。

### 5.2 备份与恢复演练

```bash
cd /opt/virtualwait/apps/web
sudo -u virtualwait npm run db:backup -- --output /var/backups/virtualwait/manual.db
sudo -u virtualwait npm run db:verify -- --input /var/backups/virtualwait/manual.db
```

`db:backup` 用 `VACUUM INTO` 直接打开运行库复制，**不会**执行 schema/迁移/seed：
备份任务永远不会改动生产库结构（升级动作只由 Web 进程启动时完成）。
`db:verify` 会校验 `integrity_check`、`foreign_key_check` 与必需表存在，且在 Linux 上要求
备份文件权限不含 group/other 访问位。恢复时把校验过的备份放到 `VIRTUALWAIT_DATA_DIR` 并重启 Web。

### 5.3 日常维护清单

| 频率 | 动作 |
|---|---|
| 每日 | 检查 `virtualwait-web`/`virtualwait-maintenance` 状态与磁盘空间；确认备份成功 |
| 每周 | 抽查审计事件；确认签到码轮换正常；查看机器人 429/发送失败 |
| 每季 | 演练一次备份恢复；复核 `IP_ACCOUNT_QUOTA_PER_DAY` 与限流是否匹配客流 |
| 需要时 | 签到码外泄 → 管理台立即轮换；密钥泄露 → 轮换并重启（会失效全部会话） |

### 5.4 常见故障

| 现象 | 处置 |
|---|---|
| 502 / 页面打不开 | 检查 `systemctl status virtualwait-web`、`/var/lib/virtualwait/web` 权限与磁盘 |
| 注册报「签到码不正确」 | 现场码已轮换；在管理台读取当前码，或确认服务器时间正确 |
| 注册报「今日注册的账号过多」 | 触发了每 IP 注册配额；调整 `IP_ACCOUNT_QUOTA_PER_DAY` 或改用其他网络 |
| 忘记管理员令牌 | 在 `/etc/virtualwait/web.env` 更新 `ADMIN_API_TOKEN` 并重启 Web |
| 群内收不到 @ | 检查 `BOT_API_TOKEN` 与 `QUEUE_NOTIFY_BOT_TOKEN` 是否一致、场地群 UMO、机器人是否在线 |
| 队列不动 | 确认 `virtualwait-maintenance` 在运行（连续 5 个周期失败会主动退出让 systemd 重启）；公开读路径不会推进超时 |
| 玩家报「今日注册的账号过多」但现场没那么多人 | 若代理未注入 IP 头，所有客户端会共用同一个配额桶；检查 Nginx 是否设置 `X-Forwarded-For`/`X-Real-IP` |
| 管理脚本带 Bearer 调用返回 403 | 该请求缺 `Origin` 且未带 `Authorization: Bearer`；带令牌即可（带 Bearer 会跳过同源校验） |

## 6. 上线验收

按 [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) 第 12 节逐项勾选，并确认
`node scripts/verify-all.mjs` 在开发机或 CI 上通过。
