# VirtualWait Web

VirtualWait 的 Next.js 15 前端、账号与队列 API，以及本地 SQLite 持久层。
该目录是模板代码：不包含有效令牌、真实用户资料或运行数据库。

## 本地开发

要求 Node.js 22.5+，项目使用 `node:sqlite`。

```bash
cp .env.example .env.local
npm ci
npm run dev
```

`.env.example` 只含不可用于生产的占位值。本地体验路径：

1. 打开 `/admin`，用 `ADMIN_API_TOKEN` 登录，读取「场地签到码」面板里的 6 位码；
2. 打开 `/login`，用该签到码注册账号（用户名 + 口令 + 昵称）；
3. 在 `/me` 绑定 QQ（`REQUIRE_QQ_FOR_QUEUE=true` 时排队必填）；
4. 进入机台页排队、确认上机、结束游玩。

Web 只读写本地 SQLite，不调用任何外部身份服务或游戏服务器。

## 常用命令

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e
npm run test:browser
npm run db:reset
npm run maintenance -- --once
npm run healthcheck
npm run preflight -- --production

# 现场开户（REGISTRATION_ENABLED=false 时使用）
printf '%s' '玩家口令' | npm run account:create -- --username player01 --nickname '玩家一号'
```

`data/virtualwait.db` 是本地运行数据，不会被提交。`npm run db:reset` 会删除该数据库，仅限开发环境使用。
`npm run test:browser` 需要先 `npx playwright install chromium`，或设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。

仓库根目录也可跑一键门禁：`node scripts/verify-all.mjs`。

## 模板默认页面

| 路径 | 说明 |
|------|------|
| `/` | 城市目录首页 |
| `/city/sample-city` | 城市下的区/县 |
| `/city/sample-city/sample-district` | 区县下的场地与机台（含活跃人数） |
| `/login` | 登录 / 注册（用户名 + 口令；注册需场地签到码） |
| `/queue/sample-venue/machine-a` 等 | 示例机台队列板 |
| `/me` | 个人资料、QQ 绑定与我的排队记录 |
| `/admin` | 管理员运维台（队列、超时、场地、机台、签到码、审计） |

城市、区县、场地、机台和默认开放时间定义在 `src/lib/constants/catalog.ts`。
复制模板后应先替换这些示例值；详细步骤见 [模板定制文档](../../docs/TEMPLATE.md)。

## 源码结构（`src/`）

| 路径 | 职责 |
|------|------|
| `app/` | App Router 页面与 `api/*` 路由 |
| `components/` | 队列板、登录/注册表单、个人页、管理台等 UI |
| `lib/constants/catalog.ts` | 城市 → 区县 → 场地 → 机台静态目录 |
| `lib/auth/` | 账号（注册/口令）、会话 Cookie、IP 归属、限流、管理员会话 |
| `lib/settings/` | 超时、场地元数据、机台硬币、**场地签到码** |
| `lib/queue/` | 队列领域（见下表）；`service.ts` 为稳定 re-export |
| `lib/time/hours.ts` | 开放时间解析与营业判断 |
| `lib/db/` | SQLite schema、迁移、可重入事务、备份复制 |
| `lib/testing/` | 仅测试使用的夹具（不参与运行时路径） |
| `lib/env.ts` | 环境变量校验与默认值 |

### 身份模块

| 文件 | 职责 |
|------|------|
| `auth/password.ts` | scrypt 加盐哈希、常量时间校验、口令策略 |
| `auth/account.ts` | 注册（含签到码校验）、口令登录、用户名/昵称规则 |
| `auth/session.ts` | `vw_session` 签名 Cookie、`session` 表吊销、会话用户读取 |
| `auth/rate-limit.ts` | 固定窗口限流桶，注册/登录限流组合 |
| `auth/ip-binding.ts` | 每 IP 每日注册配额与登录元数据记录 |
| `settings/checkin.ts` | 场地签到码派生、校验与轮换（仅服务端） |
| `settings/checkin-shared.ts` | 客户端安全：签到码类型与倒计时格式化 |
| `auth/admin.ts`、`auth/bot.ts` | 管理面与 Bot 面鉴权 |

### 队列模块

| 文件 | 职责 |
|------|------|
| `queue/service.ts` | 对外 re-export（保持 import 路径稳定） |
| `queue/core.ts` | 审计、上机、重排队尾、结束/过期 |
| `queue/public.ts` | 公开队列、活跃人数统计 |
| `queue/user-actions.ts` | 加入 / 拼机 / 确认上机 / 取消 / 结束 |
| `queue/timeouts.ts` | 游玩超时、队头确认超时 |
| `queue/admin.ts` | 管理侧队列与条目操作 |
| `queue/views.ts` | 展示槽位组装 |
| `queue/maintenance.ts` | 保留策略清理 |

规则摘要：队头在空闲机台上需在 `HEAD_CONFIRM_TIMEOUT_SEC`（默认 180s）内确认；确认超时整组自动**排到队尾**，不卸卡。
结束游玩或游玩超时 `PLAYING_TIMEOUT_SEC`（默认 1500s）后自动回队尾继续排队（可取消离开）。
完整流程见 [架构说明](../../docs/ARCHITECTURE.md)。

## 管理员能力（`/admin`）

使用 `ADMIN_API_TOKEN` 登录后可：

- 查看并**立即轮换**各场地的签到码（`GET/POST /api/admin/venues/{venueId}/checkin`）；
- 设置机台队列状态：`OPEN` / `PAUSED` / `CLOSED`；
- 对活跃条目代操作：开始、重排、取消、结束等（`version` 乐观并发）；
- 调整游玩超时与队头确认超时（写入 `app_settings`，覆盖 env 默认）；
- 编辑场地地址、区县展示、开放时间、群 UMO；
- 编辑机台单次游玩硬币数；
- 查看审计事件。

相关 API 前缀：`/api/admin/session`、`/settings`、`/venues`、`/machines`、`/queues`、`/entries`、`/audit`。

## 主要用户 API

- `POST /api/auth/register` — 用户名 + 口令 + 昵称 + 场地签到码
- `POST /api/auth/login` — 用户名 + 口令
- `POST /api/auth/logout`、`GET/PATCH /api/auth/me`
- `POST /api/queues/{venueSlug}/{machineSlug}/join`
- `GET  /api/queues/{venueSlug}/{machineSlug}/public`
- `POST /api/entries/{entryId}/confirm` — 队头确认上机
- `POST /api/entries/{entryId}/cancel`
- `POST /api/entries/{entryId}/finish`
- 健康检查：`/api/healthz`

写接口均做同源校验；响应默认 `Cache-Control: no-store`。

## 监听地址

`npm run start` 默认只监听 `127.0.0.1`（见 `scripts/start.mjs`）：生产强制
`TRUST_PROXY_HEADERS=true`，客户端 IP 完全来自代理头，一旦能直连端口就能伪造 IP，
绕过每 IP 注册配额、登录限流与会话 IP 绑定。只有平台无法走回环代理（例如容器网络）时
才用 `HOST=0.0.0.0`，并确保端口对外不可达。

## 环境变量

`.env.example` 说明了全部本地配置。生产环境至少需要：

- 独立且随机的 `SESSION_SECRET`、`ADMIN_API_TOKEN`，每项长度至少 32 字符；
- `APP_BASE_URL`（生产环境必须为 HTTPS；仅受控内网可设 `ALLOW_INSECURE_APP_URL=true` 放行 HTTP）；
- `REGISTRATION_ENABLED`、`CHECKIN_REQUIRED`、`CHECKIN_WINDOW_SEC`、`CHECKIN_GRACE_WINDOWS`；
- `REGISTER_*` / `LOGIN_*` 限流参数与 `IP_ACCOUNT_QUOTA_PER_DAY`（每 IP 每日注册账号上限，默认 5）；
- `PLAYING_TIMEOUT_SEC` / `HEAD_CONFIRM_TIMEOUT_SEC`（管理员仍可在运行时覆盖）；
- `REQUIRE_QQ_FOR_QUEUE`（默认 true：未绑定 QQ 不能排队）；
- 已清洗转发头的反向代理，以及 `TRUST_PROXY_HEADERS=true`；
- `HOST`/`PORT`（保持回环）与 `DB_BUSY_TIMEOUT_MS`（web 与维护进程共用同一 SQLite 文件）；
- 受限权限的数据目录、加密备份和明确的数据保留期限（`IP_BINDING_RETENTION_DAYS`、
  `LOGIN_METADATA_RETENTION_DAYS`、`QUEUE_HISTORY_RETENTION_DAYS`、`AUDIT_EVENT_RETENTION_DAYS`、`SESSION_MAX_AGE_DAYS`）。

不要把生产值写入任何 `.env.example`、测试夹具、README、浏览器代码或日志。生产检查可执行：

```bash
npm run preflight -- --production
```

## 安全边界

- 口令只以 scrypt 加盐哈希入库；用户名不存在时也执行等价哈希计算，避免账号枚举；
- 注册/登录均有限流，超限返回 `429` 与 `RATE_LIMITED`；
- 会话 Cookie 为 `HttpOnly`，生产启用 `Secure` 与 `SameSite=Strict`，并在服务端 `session` 表可吊销；
- 所有写接口执行同源检查，API 默认 `Cache-Control: no-store`；
- 公开队列接口只返回昵称，**永不返回 QQ、用户名、IP 或身份内部字段**；
- Content-Security-Policy 仅在生产严格（开发模式为支持 HMR 放行 `unsafe-eval`，见 `next.config.ts`）；
- 维护任务按配置清理限流桶、过期 IP 配额、不活跃登录元数据、终态队列、审计与过期会话；
- 运行时设置（超时、场地元数据、硬币、签到码密钥）与队列同库，备份与权限要求相同。

发布前请同时阅读 [安全与发布清单](../../docs/SECURITY.md)、[架构说明](../../docs/ARCHITECTURE.md)
和 [部署说明](../../infra/server/README.md)。

## 机器人 Bot API（可选）

配置 `BOT_API_TOKEN` 后启用：

- `GET /api/bot/catalog`
- `GET /api/bot/queues/{venueSlug}/{machineSlug}`

玩家在 `/me` 绑定 QQ；管理员在场地中配置群 UMO（`groupUmo`）。
详见 [docs/QUEUE_NOTIFY.md](../../docs/QUEUE_NOTIFY.md) 与 QQ 机器人 [`services/bot`](../../services/bot)。
