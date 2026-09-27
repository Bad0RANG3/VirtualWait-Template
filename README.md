# VirtualWait — maimai DX 虚拟排卡系统

VirtualWait 是一套面向 maimai DX 机台的 **虚拟排卡（线上排队）系统**：玩家用手机或网页就能排队，不再依赖实体排队卡。系统同时内置 maimai 身份验证 Gateway、QQ 叫号机器人、B50 成绩图与发票工具，由 VirtualWait-Template 与 MaidXTool 合并重构而来，以 monorepo 形式发布。

> 生产使用前必须完成真实身份服务的授权与安全审计。`mock` provider 仅用于本地开发和测试；不要提交二维码、令牌、密钥、运行数据库或真实用户资料。

## 虚拟排卡怎么用

1. 打开网页，选择城市 → 区县 → 机厅 → 机台；
2. 第一次使用先扫机台二维码登录（Gateway 校验身份，只存匿名 subject），再到个人中心绑定 QQ；
3. 单人入队或双人拼机，公开队列板实时显示；
4. 机台空闲时系统 / QQ 机器人 @ 队首，**3 分钟内确认上机**（超时自动排到队尾）；
5. 游玩结束或游玩超时自动**回到队尾**继续排队，不想继续可随时取消离开。

## 核心能力

- **虚拟排卡**：城市 / 区县 / 场地 / 机台四级目录、公开队列板、单人 / 双人拼机、队头确认上机；
- **自动回队尾**：游玩结束、游玩超时、队头确认超时都会回队尾，可随时取消离开；管理员可强制开始 / 重排 / 取消 / 结束；
- **二维码身份登录**：原始二维码、token、明文 userID 与完整上游响应不入库；`sdgb_full` 真实登录验证后**立即登出**；
- **登出失败恢复**：AES-GCM 加密上下文 + `LOGGING_OUT` 后台恢复作业，保证“必登出”；
- **QQ 叫号机器人**（NoneBot2 + NapCat）：机台空闲 @ 队首、`/b50` 成绩图，以及发票 / 写道具 / 传分 / 跑区域 / 写伙伴等写命令；
- **管理台**：场地 / 机台 / 超时 / 硬币 / 队列状态 / 审计；
- **运维全家桶**：SQLite、Nginx、systemd、备份、健康检查、维护任务；
- **配置化**：所有密钥、队列规则、超时、保留期、身份 provider 均由环境变量或 gitignored 配置文件驱动；
- **测试门禁**：单元测试、HTTP E2E、浏览器测试、pytest、一键 `verify-all`。

## 架构

```text
浏览器 -- HTTPS --> Web (Next.js + SQLite)
                         | HMAC
                         v
                  Gateway (Python)
                         | mock | http | sdgb_preview | sdgb_full
                         v
                  已授权身份 provider / SDGB 标题服务器

QQ -- OneBot v11 WS --> NapCat --> Bot (NoneBot2, services/bot)
Bot -- Bearer --> Web Bot API -- 队列空闲 @ 提醒 --> 队首
Bot -- sdgb-client --> SDGB 标题服务器 -- /b50 /fp
```

Web、Gateway、Bot 和管理员使用独立的会话或密钥。Gateway 默认仅监听回环地址，不应直接暴露到公网。

## 仓库组成

| 路径 | 发布内容 |
|---|---|
| `apps/web/` | Next.js 应用、队列 API、虚拟排卡前端、管理员台、SQLite、Bot API |
| `services/sdgb-gateway/` | HMAC 签名身份 Gateway 与 provider 实现 |
| `services/bot/` | NoneBot2 QQ 机器人（B50 / 发票命令 + 队列空闲通知） |
| `packages/sdgb-client/` | 共享 SDGB 客户端（加密管道 / 换码 / B50 / 写操作） |
| `packages/contracts/` | Web 与 Gateway 的 JSON Schema、fixture |
| `infra/` | Nginx、systemd、docker-compose、环境变量样例 |
| `docs/` | 架构、技术规格、安全、约束、部署和联动文档 |
| `scripts/` | 全项目验证入口 |

## 快速开始（本地开发）

前置要求：Node.js 22.5+（Web 使用 `node:sqlite`）、Python 3.12、npm；可选 Docker（QQ 机器人一键部署）。

### 1. 启动身份 Gateway（默认 mock）

```bash
cd services/sdgb-gateway
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -e ".[test]"   # Linux/macOS: .venv/bin/python -m pip install -e ".[test]"
cp .env.example .env.local
.venv\Scripts\python -m virtualwait_gateway
```

默认监听 `127.0.0.1:8787`。`mock` provider 只接受 `mock:*` 二维码，用于离线联调。

### 2. 启动 Web

```bash
cd apps/web
npm ci
cp .env.example .env.local
```

编辑 `.env.local`，至少设置独立随机的 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN`，其中 `PUBLIC_ID_HMAC_SECRET` 与 `GATEWAY_SHARED_SECRET`（以及 `GATEWAY_KEY_ID`）必须和 Gateway 的 `.env.local` **完全一致**。然后：

```bash
npm run dev
```

打开 http://localhost:3000，用 `mock:*` 二维码体验完整排队流程。

### 3. 启动 QQ 机器人（可选，推荐 Docker 预构建镜像）

机器人镜像已发布到 Docker Hub **`bad0rang3/maidxtool`**，在线直接拉取；离线/内网用仓库 `dist/` 的预构建包（`virtualwait-qqbot-stack.1.0.0.tar.gz`，NapCat + 机器人全栈 ~620 MB）：

```bash
# 在线：docker pull bad0rang3/maidxtool:latest
# 离线：docker load -i dist/virtualwait-qqbot-stack.1.0.0.tar.gz
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build
docker compose -f infra/docker/docker-compose.bot.yml logs napcat | grep -E "WebUi (Token|User Panel Url)"
```

按日志地址打开 WebUI 扫码登录机器人 QQ 即可（唯一手动步骤）。机厅密钥通过 `infra/docker/.env` 的 `VW_SDGB_*` 注入，**镜像内不含密钥**；Web 侧需在 `.env.local` 填写 `BOT_API_TOKEN`，并和 compose 的 `QUEUE_NOTIFY_BOT_TOKEN` 保持一致。完整说明见 [services/bot/DEPLOY.md](services/bot/DEPLOY.md)。

## 生产部署

> 详细步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)（完整流程）与 [infra/server/README.md](infra/server/README.md)（systemd / Nginx 模板）。以下为部署方式一览。

### 方式 A：Linux 全栈（Web + Gateway + 机器人，systemd）— 推荐生产

1. 创建运行用户与目录，`git clone` 到 `/opt/virtualwait`；
2. 安装依赖并构建：`cd apps/web && npm ci && npm run build`；Gateway 使用专用 Python venv 安装；
3. 复制 [Web 生产样例](infra/server/env/web.production.env.example) 与 [Gateway 生产样例](infra/server/env/gateway.production.env.example) 到 `/etc/virtualwait/`，替换所有 `CHANGE_ME_*` 值；确保 Web ↔ Gateway 共享密钥一致；
4. 安装 `infra/server/systemd/` 下的 service / timer，配置 Nginx 反向代理（模板见 [virtualwait.conf](infra/server/nginx/virtualwait.conf)）；
5. 启用备份与健康检查 timer，保持 `virtualwait-maintenance` 常驻；
6. QQ 机器人按方式 B（Docker）或本机 venv 部署。

### 方式 B：QQ 机器人 Docker 预构建镜像 — 推荐

```bash
# 在线（Docker Hub）：docker pull bad0rang3/maidxtool:latest
# 离线：docker load -i dist/virtualwait-qqbot-stack.1.0.0.tar.gz
docker compose -f infra/docker/docker-compose.bot.yml up -d --no-build
```

NapCat + NoneBot2 一起拉起，OneBot v11 正向 WebSocket 已预置，唯一手动步骤是扫码登录 QQ；机器人为 Docker Hub 预构建镜像，密钥全部环境变量注入。源码部署用 `--build`，详见 [services/bot/DEPLOY.md](services/bot/DEPLOY.md)。

### 方式 C：本地 / 内网开发

见上方“快速开始”。Web、Gateway 均可跑在单机上，SQLite 数据默认在 `apps/web/data`。

### 生产环境变量速查

| 配置组 | 位置 | 要点 |
|---|---|---|
| Web 密钥 | `apps/web/.env.local` 或 `/etc/virtualwait/web.env` | `SESSION_SECRET`、`ADMIN_API_TOKEN` 独立随机；`GATEWAY_SHARED_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_KEY_ID` 与 Gateway 一致 |
| Gateway | `services/sdgb-gateway/.env.local` 或 `/etc/virtualwait/gateway.env` | `VW_GATEWAY_HOST=127.0.0.1`；生产 provider 用 `http` / `sdgb_preview` / `sdgb_full`，不用 `mock` |
| Bot | `services/bot/.env` 或 compose 环境变量 | `ONEBOT_WS_URLS`、`QUEUE_NOTIFY_BASE_URL`、`QUEUE_NOTIFY_BOT_TOKEN`（= Web 的 `BOT_API_TOKEN`） |
| SDGB 密钥 | `VW_SDGB_*` 环境变量或 gitignored `packages/sdgb-client/sdgb/settings_local.py` | AES Key/IV、AIME Salt、KeychipID 等；禁止提交 |
| 队列规则 | Web env → 管理台 | `HEAD_CONFIRM_TIMEOUT_SEC`（默认 180）、`PLAYING_TIMEOUT_SEC`（默认 1500），管理台可运行时覆盖 |
| 数据保留 | Web env | `IP_BINDING_RETENTION_DAYS`、`PROFILE_DATA_RETENTION_DAYS`、`QUEUE_HISTORY_RETENTION_DAYS`、`AUDIT_EVENT_RETENTION_DAYS` |

## 身份 provider

Web **始终**使用签名远程 Gateway（`GATEWAY_MODE=remote`）。Gateway 支持：

| provider | 说明 |
|---|---|
| `mock` | 离线测试，只接受 `mock:*` 二维码 |
| `http` | 转发到你自己的授权验证服务 |
| `sdgb_preview` | 无登录预览（AiMe 换码 + `GetUserPreviewApi`，不登录） |
| `sdgb_full` | **真实登录验证**：换码 → 探测 isLogin → `UserLoginApi` → 取公开资料 → 立即 `UserLogoutApi`；登出失败走 `LOGGING_OUT` 恢复作业 |

`sdgb_full` 配置（`services/sdgb-gateway/.env.local`）：

```env
VW_GATEWAY_PROVIDER=sdgb_full
VW_SDGB_AIME_URL=http://ai.sys-allnet.cn/wc_aime/api/get_data
VW_SDGB_TITLE_SERVER_URL=https://maimai-gm.wahlap.com:42081/Maimai2Servlet
VW_SDGB_AIME_SALT=<aime salt>
VW_SDGB_AES_KEY=<title server aes key>
VW_SDGB_AES_IV=<title server aes iv>
VW_SDGB_OBFUSCATE_PARAM=<api hash salt>
VW_SDGB_KEYCHIP_ID=<keychip id>
VW_SDGB_CLIENT_ID=<client id>
VW_SDGB_REGION_ID=1403
VW_SDGB_PLACE_ID=1
VW_SDGB_TIMEOUT_SEC=10
```

原始二维码、token、明文 userID 与完整上游响应不会入库；登出恢复上下文使用 `VW_PUBLIC_ID_HMAC_SECRET` 派生密钥做 AES-GCM 加密后持久化。

## QQ 机器人命令

| 命令 | 说明 |
|------|------|
| `/help` | 全部命令说明 |
| `/b50 <二维码>` | 完整 B50 成绩图（每次新码，查完自动登出；同账号 10 分钟缓存） |
| `/fp <二维码> [2~5]` | 发票（写操作，真实改账号数据；库存为 0 才下发，免费固定 1 张） |
| `/giveitem <二维码> KIND:ID [...]` | 写道具 / 收藏品（写操作，一次最多 10 条） |
| `/score <二维码> MUSIC:LEVEL:ACH [...]` | 传分（写操作，一次最多 5 个谱面） |
| `/map <二维码> 区域ID\|区域名 [...]` | 跑区域（写操作；实机已证假局不记距离，只用于量服务器幅度） |
| `/chara <二维码> 角色ID\|first [...]` | 写旅行伙伴槽位（写操作；给 1 个 ID 占满 5 槽） |
| `/vw_queue_status` | 队列通知插件轮询状态 |

> 写命令是高风险操作：每次使用新二维码（登录一次即消耗该码）、流程走完必登出、
> 中断可能触发小黑屋（isLogin=1，约 15 分钟冷却）。发送前确认二维码是自己的账号。
> 各命令的格式示例与实机边界见 [services/bot/README_commands.md](services/bot/README_commands.md)。

## 约束与红线（摘要）

完整约束见 [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md)，安全与发布清单见 [docs/SECURITY.md](docs/SECURITY.md)。要点：

- **登录验证密钥不要动**：`GATEWAY_SHARED_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_KEY_ID` 必须 Web ↔ Gateway 两端一致；`BOT_API_TOKEN` 必须 Web ↔ Bot 一致；每个环境独立随机；
- **敏感文件不提交**：`packages/sdgb-client/sdgb/settings_local.py`、各 `.env.local` / `.env`、`services/bot/napcat/`、`data/`、数据库、WAL、备份全部 gitignored，提交前检查 `git status`；
- **架构红线**：Web 永远 `GATEWAY_MODE=remote`；Gateway 只监听回环 / 受控网络；SQLite 单机单实例；`maintenance` 常驻；公开接口永不返回 QQ；
- **高风险命令纪律**：写命令每次新码（登录一次即消耗）、流程走完必登出，遵守小黑屋冷却；
  群内出现二维码串由 `qr_guard` 撤回。

## 验证

在仓库根目录运行一键门禁：

```bash
node scripts/verify-all.mjs
```

一键门禁包含 Web 生产预检、单元测试、HTTP E2E、浏览器测试、构建、Gateway 测试、
sdgb-client 写路径测试与编译检查、TLS 校验门禁（禁止 `verify=False`）、Bot 测试与部署样例检查。

## 文档

- [约束与红线](docs/CONSTRAINTS.md)：不得破坏的流程、密钥与敏感文件、架构和行为约束；
- [安全与发布清单](docs/SECURITY.md)：密钥、数据、网络和发布要求；
- [技术规格与上线验收](docs/TECHNICAL_SPEC.md)：系统边界、状态机、数据、安全、运维与验收标准；
- [架构与队列流程](docs/ARCHITECTURE.md)：模块地图、队列规则和 API 概览；
- [队列通知联动](docs/QUEUE_NOTIFY.md)：QQ、Bot API、NoneBot2 插件的完整联调规范；
- [运行流程与自托管部署](docs/DEPLOYMENT.md)：流程图、部署前准备和服务器上线步骤；
- [模板定制](docs/TEMPLATE.md)：替换目录、品牌、规则和身份 provider；
- [文档索引](docs/README.md)：所有子模块文档入口。

## 安全与合规

本项目不会替你取得第三方接口或用户数据的使用授权。运营方负责确认身份服务、二维码处理、QQ 群通知和个人信息处理符合适用法律、平台规则与场地政策。公开接口不得包含 QQ；Bot API 应视为管理面并仅在受控网络路径使用。