# VirtualWait

VirtualWait 是一套面向 maimai DX 机台场地的**排队 + 机器人 + 成绩工具**综合系统
（由 VirtualWait-Template 与 MaidXTool 合并而来）。用户通过网页查看队列、单人或双人
排队并在队头确认上机；管理员负责场地和队列运营；QQ 机器人（NoneBot2）在机台空闲时
向队首发送群 @ 提醒，并提供 B50 成绩图查询与发票命令。

本仓库以一个完整项目发布：Web、签名身份 Gateway、共享 SDGB 客户端、QQ 机器人、
自托管样例与共享契约均是正式组成部分。

> 生产使用前必须完成真实身份服务的授权与安全审计。`mock` provider 仅用于本地开发
> 和测试；不要提交二维码、令牌、密钥、运行数据库或真实用户资料。

## 能力概览

- 城市、区县、场地、机台四级目录与公开队列板；
- 单人/双人队列、队头确认上机、**游玩结束/超时自动回队尾**（可取消离开）、队头确认超时自动排到队尾；
- 二维码身份流程、HttpOnly 会话、管理员运维台、审计和数据保留；
- Python 签名 Gateway：`mock`、自有 `http` provider、`sdgb_preview` 无登录预览、
  **`sdgb_full` 真实登录验证（登录校验 → 立即登出）**；
- 共享 SDGB 客户端（`packages/sdgb-client`）：AES-CBC+zlib 加密管道、二维码换凭证、
  B50 成绩渲染、发票写操作；
- QQ 机器人（`services/bot`，NoneBot2 + NapCat）：队列空闲 @ 通知、`/b50` 成绩图、
  `/fp` 发票、`/help`；
- SQLite、Nginx、systemd、备份/健康检查样例，以及单元、HTTP E2E、浏览器测试。

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

Web、Gateway、Bot 和管理员使用独立的会话或密钥。Gateway 默认仅监听回环地址，
不应直接暴露到公网。

## 仓库组成

| 路径 | 发布内容 |
|---|---|
| `apps/web/` | Next.js 应用、队列 API、管理员台、SQLite、Bot API |
| `services/sdgb-gateway/` | HMAC 签名身份 Gateway 与 provider 实现 |
| `services/bot/` | NoneBot2 QQ 机器人（B50/发票命令 + 队列空闲通知） |
| `packages/sdgb-client/` | 共享 SDGB 客户端（加密管道/换码/B50/写操作） |
| `packages/contracts/` | Web 与 Gateway 的 JSON Schema、fixture |
| `infra/` | Nginx、systemd、docker-compose、环境变量样例 |
| `docs/` | 架构、技术规格、安全、部署和联动文档 |
| `scripts/` | 全项目验证入口 |

## 运行要求

- Node.js `22.5+`
- Python `3.11+`（Gateway）；Python `3.10+`（Bot / sdgb-client）
- SQLite（通过 Node 内置 `node:sqlite` 使用）
- 可选：NapCat（QQ 协议端），用于 QQ 机器人
- 生产环境：TLS 反向代理、受限数据目录、备份和已授权的身份 provider

当前持久层为 SQLite，适合单城市或少量场地的**单机单实例**部署。多实例、高可用或
跨机房部署前，需要先迁移到服务型数据库并重新进行并发和故障转移验证。

## 本地启动

默认链路完全离线：Web 调用本地 Gateway，Gateway 使用 `mock` provider 接受
`mock:*` 测试二维码；Bot 可暂不启动。

```bash
# 终端 1：Gateway
cd services/sdgb-gateway
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
cp .env.example .env.local
PYTHONPATH=src python3 -m virtualwait_gateway
```

```bash
# 终端 2：Web
cd apps/web
cp .env.example .env.local
npm ci
npm run dev
```

访问 <http://localhost:3000>，使用以下虚构二维码登录：

```text
mock:demo-user:示例玩家:12000:示例称号
```

Web 与 Gateway 的 `GATEWAY_KEY_ID`、`GATEWAY_SHARED_SECRET`、`PUBLIC_ID_HMAC_SECRET`
必须保持一致。运行数据默认写入 `apps/web/data/` 和 `services/sdgb-gateway/data/`，
均已被 Git 忽略。

### 启用 QQ 机器人（NoneBot2 + NapCat）

机器人插件已统一到 NoneBot2（不再使用 AstrBot）：

1. 部署 NapCat（QQ 协议端，OneBot v11 正向 WebSocket，如 `ws://127.0.0.1:3001`）。
2. 安装并启动机器人：

```bash
cd services/bot
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 填写 .env：ONEBOT_WS_URLS、QUEUE_NOTIFY_BASE_URL、QUEUE_NOTIFY_BOT_TOKEN、群号等
python bot.py
```

3. 在 Web 的 `.env.local` 设置随机的 `BOT_API_TOKEN`，然后重启 Web。
4. 在 Web 管理台为每个需要通知的场地设置群 UMO（`groupUmo`）。
5. 玩家在 `/me` 绑定 QQ 后才可加入队列并被 @ 提醒。

队列通知插件按“目录摘要 -> 热机详情 -> 通知”三层轮询（默认 **3 秒**一次），有启动预热、
网络/429 指数退避和无 QQ 统计；**队首只 @ 一次**，若 3 分钟内未确认上机，
Web 会将其自动排到队尾并提醒下一位队首。完整配置见
[services/bot/README.md](services/bot/README.md) 与 [队列通知联动文档](docs/QUEUE_NOTIFY.md)。

### QQ 机器人命令

| 命令 | 说明 |
|------|------|
| `/help` | 全部命令说明 |
| `/b50 <二维码>` | 完整 B50 成绩图（每次新码，查完自动登出；同账号 10 分钟缓存） |
| `/fp <二维码> [2~5]` | 发票（写操作，真实改账号数据；库存为 0 才下发，免费固定 1 张） |
| `/vw_queue_status` | 队列通知插件轮询状态 |

> `/b50`、`/fp` 是高风险命令：每次使用新二维码、查询结束必登出、中断可能触发
> 小黑屋（isLogin=1，15 分钟冷却）。发送前确认二维码是自己的账号。

## 身份 provider

Web **始终**使用签名远程 Gateway（`GATEWAY_MODE=remote`）。Gateway 支持：

| provider | 说明 |
|---|---|
| `mock` | 离线测试，只接受 `mock:*` 二维码 |
| `http` | 转发到你自己的验证服务 |
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

原始二维码、token、明文 userID 与完整上游响应不会入库；登出恢复上下文使用
`VW_PUBLIC_ID_HMAC_SECRET` 派生密钥做 AES-GCM 加密后持久化。

## 生产部署要点

1. 替换 `catalog.ts` 中全部示例城市、场地、机台和文案。
2. 使用独立随机值配置 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、
   `GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN`、`BOT_API_TOKEN`；每项至少 32 字符，
   且不同环境不得复用。
3. 设置生产 `APP_BASE_URL`，通过 HTTPS 暴露 Web；Gateway 与 NapCat 端口仅监听
   回环或私有受控网络。
4. 只有反向代理已清除并重写客户端转发 IP 头时，才设置 `TRUST_PROXY_HEADERS=true`。
5. 将 SQLite、WAL、备份和环境文件移出仓库并施加最小权限；安装维护、备份和健康
   检查 timer。
6. 接入真实 provider（`sdgb_full` / `http`）前，完成接口授权、数据最小化、限流、
   超时与故障恢复测试；遵守 `/b50`、`/fp` 的凭证纪律。

部署文件和 systemd 安装步骤见 [infra/server/README.md](infra/server/README.md)，
完整安全要求见 [docs/SECURITY.md](docs/SECURITY.md)。

## 验证

在仓库根目录运行一键门禁：

```bash
node scripts/verify-all.mjs
```

一键门禁包含 Web 生产预检、单元测试、HTTP E2E、浏览器测试、构建、Gateway 测试、
sdgb-client / Bot 语法检查与部署样例检查。

## 文档

- [技术规格与上线验收](docs/TECHNICAL_SPEC.md)：系统边界、状态机、数据、安全、运维与验收标准；
- [架构与队列流程](docs/ARCHITECTURE.md)：模块地图、队列规则和 API 概览；
- [队列通知联动](docs/QUEUE_NOTIFY.md)：QQ、Bot API、NoneBot2 插件的完整联调规范；
- [运行流程与自托管部署](docs/DEPLOYMENT.md)：流程图、部署前准备和服务器上线步骤；
- [模板定制](docs/TEMPLATE.md)：替换目录、品牌、规则和身份 provider；
- [安全与发布清单](docs/SECURITY.md)：密钥、数据、网络和发布要求；
- [文档索引](docs/README.md)：所有子模块文档入口。

## 安全与合规

本项目不会替你取得第三方接口或用户数据的使用授权。运营方负责确认身份服务、二维码
处理、QQ 群通知和个人信息处理符合适用法律、平台规则与场地政策。公开接口不得包含
QQ；Bot API 应视为管理面并仅在受控网络路径使用。