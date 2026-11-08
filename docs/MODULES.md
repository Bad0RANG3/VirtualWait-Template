# 模块手册（Module Reference）

本文按目录列出 VirtualWait 的功能模块与职责，作为改动前的导航。
「入口」指稳定对外接口，「要点」是该模块最容易踩坑的约束。

## 1. Web 服务端库（`apps/web/src/lib`）

### 1.1 数据库层 `lib/db/`

| 文件 | 职责 | 要点 |
|------|------|------|
| `schema.ts` | 全量 DDL（`SCHEMA_SQL`）与增量迁移（`MIGRATIONS_SQL`） | 身份表为 `app_user`（本地账号）；不要恢复旧扫码身份表 |
| `migrate.ts` | 旧库结构升级：重建 `app_user`、删除旧身份表、修复 `queue`/`queue_entry`/`ip_day_binding` | 旧账号无本地口令，无法迁移 |
| `connection.ts` | SQLite 单例：首次 `getDb()` 建库、迁移、seed，开启 WAL 与外键 | 单机单实例 |
| `seed.ts` | 按 catalog 插入/补齐场地与机台，不覆盖管理员改动 | `INSERT OR IGNORE` + 空值回填 |
| `sqlite.ts` | 连接封装：可重入事务（默认 `BEGIN IMMEDIATE`） | 嵌套事务会并入外层，不再二次 BEGIN |
| `backup.ts` | `createBackup()`：`VACUUM INTO` 复制，**不**跑 schema/迁移/seed | 备份脚本专用 |
| `utils.ts` / `index.ts` | 时间工具、稳定 re-export | 其他模块只从 `lib/db` 导入 |

### 1.2 认证与会话 `lib/auth/`

| 文件 | 职责 | 要点 |
|------|------|------|
| `password.ts` | scrypt 加盐哈希、`verifyPassword`、`burnPasswordWork`、口令策略 | 参数改动需考虑迁移 |
| `account.ts` | `registerAccount`（含签到码校验与配额回滚）、`authenticate`、用户名/昵称校验 | 失败统一 `INVALID_CREDENTIALS` |
| `session.ts` | `vw_session` 签名 Cookie、`session` 表签发/吊销、`getSessionUser` | 命中校验 IP 哈希连续性 |
| `rate-limit.ts` | 固定窗口计数桶 + 注册/登录限流组合 | 过期按**每行自己的窗口**判断，短窗口调用方不会清掉长窗口计数 |
| `ip-binding.ts` | 每 IP 每日注册配额（`ip_day_binding`）、登录元数据记录 | 配额只作用于注册；地址不可解析的客户端共用一个保守桶 |
| `ip.ts` | 客户端 IP 提取（受 `TRUST_PROXY_HEADERS` 控制）与 HMAC 哈希 | XFF 取最右侧可信条目 |
| `admin.ts` | 管理会话 Cookie 与 `requireAdmin`（Bearer 或 Cookie） | 不复用为 Bot 令牌 |
| `bot.ts` | `requireBot` 校验 `BOT_API_TOKEN` | 常量时间比较 |
| `time.ts` | 上海日历日与次日零点工具 | 固定 UTC+8 |

### 1.3 队列领域 `lib/queue/`

入口 `service.ts` 仅 re-export；实现按职责拆分：

| 文件 | 职责 |
|------|------|
| `core.ts` | 审计写入、party 读取、`startEntries`、`requeueToEnd`、`finishOrExpireEntry`、活跃条目查询 |
| `user-actions.ts` | `joinQueue`（SOLO/DUO/拼机，事务内序号 + 唯一索引兜底）、`confirmPair`、`cancelEntry`、`confirmStartPlay`、`finishPlay` |
| `timeouts.ts` | `processTimeouts`：游玩超时回队尾、队头确认超时整组回队尾 |
| `admin.ts` | 队列开闭、活跃条目列表、管理员动作（`version` 乐观并发）、审计列表 |
| `public.ts` | 公开快照（WAITING 截断 200，`totalWaiting` 如实）、按机台活跃计数 |
| `bot.ts` | Bot catalog 与单机台详情（含队首 QQ）、冷却键 |
| `views.ts` | 行 → 视图（槽位分组、位置、`canConfirmStart`、队头确认截止时间） |
| `maintenance.ts` | 保留策略清理与超时推进（`npm run maintenance` 常驻调用） |

### 1.4 运行时设置 `lib/settings/`

| 文件 | 职责 |
|------|------|
| `timeouts.ts` | 游玩/队头确认超时（`app_settings` 覆盖 env，带范围校验） |
| `checkin.ts` | 场地签到码派生、校验、轮换；`venueIdBySlug` / `venueNameById`（仅服务端） |
| `checkin-shared.ts` | 客户端安全的纯部分：`VenueCheckinCode` 类型与倒计时格式化 |
| | **不要**从客户端组件导入 `checkin.ts`（会经 `lib/db` 拉入 `node:fs`） |
| `venue-meta.ts` | 场地地址/区县/营业时间/群 UMO、机台 `coin_cost` 读写与列表 |
| `index.ts` | 稳定 re-export |

### 1.5 支撑模块 `lib/`

| 文件 | 职责 |
|------|------|
| `api.ts` | 错误码 → HTTP 映射、JSON 响应、同源校验、请求体上限、`withUser`/`withAdmin` |
| `crypto.ts` | sha256 / HMAC / 随机令牌 / 常量时间比较 / 载荷签名 |
| `env.ts` | 环境变量解析与生产安全检查 |
| `types.ts` | 队列、公开快照、会话用户、管理端视图类型 |
| `time/hours.ts` | 营业时间解析与「当前是否营业」 |
| `constants/catalog.ts` | 城市 → 区县 → 场地 → 机台静态目录 |
| `testing/users.ts` | 仅测试使用的账号夹具（不参与运行时路径） |

## 2. Web API 路由（`apps/web/src/app/api`）

### 2.1 认证

| 路由 | 说明 |
|------|------|
| `POST /api/auth/register` | 用户名 + 口令 + 昵称 + 场地签到码；成功即建立会话 |
| `POST /api/auth/login` | 用户名 + 口令 |
| `POST /api/auth/logout` | 吊销服务端会话行并清除 Cookie |
| `GET/PATCH /api/auth/me` | 读取/更新昵称与 QQ |
| `GET /api/me/entries` | 当前用户的活动排队记录 |

### 2.2 队列

| 路由 | 说明 |
|------|------|
| `POST /api/queues/{venueSlug}/{machineSlug}/join` | 入队 / 发起或加入拼机 |
| `GET /api/queues/{venueSlug}/{machineSlug}/public` | 公开队列快照（无 QQ） |
| `POST /api/entries/{entryId}/confirm` | 队头确认上机 |
| `POST /api/entries/{entryId}/cancel` | 取消排队 |
| `POST /api/entries/{entryId}/finish` | 结束游玩（自动回队尾） |
| `POST /api/parties/{partyId}/confirm` | 拼机确认 |

### 2.3 管理（`ADMIN_API_TOKEN` / `vw_admin` Cookie）

| 路由 | 说明 |
|------|------|
| `POST/DELETE /api/admin/session` | 管理登录 / 退出 |
| `GET/POST /api/admin/settings` | 超时设置 |
| `GET /api/admin/venues`、`GET/POST /api/admin/venues/{venueId}` | 场地列表与元数据 |
| `GET/POST /api/admin/venues/{venueId}/checkin` | 读取 / 轮换场地签到码 |
| `POST /api/admin/machines/{machineId}` | 机台硬币数 |
| `POST /api/admin/queues/{queueId}/status` | 队列开闭 |
| `GET /api/admin/entries`、`POST /api/admin/entries/{entryId}/action` | 活跃条目与代操作 |
| `GET /api/admin/audit` | 审计事件 |

### 2.4 Bot 与健康

| 路由 | 说明 |
|------|------|
| `GET /api/bot/catalog` | 全市机台摘要（Bearer `BOT_API_TOKEN`） |
| `GET /api/bot/queues/{venueSlug}/{machineSlug}` | 单机台详情（含队首 QQ） |
| `GET /api/healthz` | 进程/SQLite 就绪探针（Nginx 模板中对外 404） |

## 3. Web 页面（`apps/web/src/app`）

| 页面 | 说明 |
|------|------|
| `/` | 城市目录 |
| `/city/[citySlug]`、`/city/[citySlug]/[districtSlug]` | 区县与场地/机台列表 |
| `/queue/[venueSlug]/[machineSlug]` | 机台队列板（登录后入队/确认/结束） |
| `/login` | 登录 / 注册（`AuthPanel`） |
| `/me` | 个人资料、QQ 绑定、我的排队 |
| `/admin` | 运维台（未登录时显示令牌表单） |

## 4. Web 组件（`apps/web/src/components`）

| 组件 | 职责 |
|------|------|
| `AppShell.tsx` | 顶部导航与「登录 / 注册」入口 |
| `AuthPanel.tsx` | 登录/注册切换、场地选择与签到码输入 |
| `ProfileSettingsForm.tsx` | 昵称与 QQ 保存 |
| `LogoutButton.tsx` | 退出登录 |
| `QueueBoard.tsx` | 队列板主交互（轮询、入队、我的操作、拼机发现） |
| `queue/QueueStatusHeader.tsx`、`queue/QueueSlotList.tsx`、`queue/DuoDiscoveryList.tsx`、`queue/queue-formatters.ts` | 队列展示与文案 |
| `AdminDashboard.tsx` + `admin/*` | 超时、场地、机台、队列、条目、审计、**签到码**面板 |
| `admin/useAdminMutation.ts` | 管理端写操作 busy/error/ok 生命周期 |
| `LocationPicker.tsx` | 城市/区县快捷选择 |

## 5. Web 运维脚本（`apps/web/scripts`）

| 脚本 | 职责 |
|------|------|
| `preflight.mjs` | 仓库泄露扫描、Node 版本、生产密钥/URL/代理检查、浏览器可用性 |
| `e2e.mjs` | 无浏览器的 HTTP E2E（起 Next dev + 临时数据目录） |
| `healthcheck.mjs` | 探活 `/api/healthz`（systemd timer 使用） |
| `maintenance.ts` | 常驻维护（`--once` 单次执行） |
| `backup-db.ts` / `verify-backup-db.ts` | SQLite 备份与备份校验（`db:verify` 要求必需表存在） |
| `start.mjs` | 生产入口：默认把监听地址钉在 `127.0.0.1`，避免绕过代理伪造 IP |
| `create-account.ts` | 现场开户 CLI（`npm run account:create`），校验规则与自助注册一致 |
| `reset-db.mjs` | 删除本地开发数据库（含 `-wal`/`-shm`） |

浏览器门禁位于 `apps/web/e2e/`：`helpers.ts`（通过管理 API 读取签到码）、`user-and-admin.spec.ts`、`mobile.spec.ts`。

## 6. QQ 机器人（`services/bot`）

| 文件 | 职责 |
|------|------|
| `bot.py` | NoneBot2 入口，加载 `plugins/` |
| `plugins/queue_notify.py` | 轮询 Bot API、热集筛选、冷却去重、群内 @ 队首、`/vw_queue_status` |
| `plugins/helpers.py` | 群路由解析、队首键、通知文案 |
| `napcat_guard.py` / `start_wrapper.py` | NapCat / NoneBot 崩溃自重启守护 |
| `tests/test_notify_logic.py` | 通知判定与冷却逻辑单测 |
| `DEPLOY.md`、`README.md` | 部署与配置说明 |

机器人不连接任何游戏服务器，也不处理账号数据。

## 7. 基础设施（`infra/`）

| 路径 | 职责 |
|------|------|
| `server/nginx/virtualwait.conf` | 生产 HTTPS 模板（TLS、隐藏健康检查、重写转发头） |
| `server/nginx/virtualwait-intranet.conf` | 受控内网 HTTP 模板（故意不安全，勿公网使用） |
| `server/systemd/` | `web` / `maintenance` / `backup` / `healthcheck` 单元与 timer |
| `server/env/*.example` | staging / production 环境变量样例（占位值不可运行） |
| `server/scripts/` | 环境样例与 Nginx 模板静态检查 |
| `docker/Dockerfile.bot`、`docker-compose.bot.yml`、`entrypoint.bot.sh` | 机器人镜像与 NapCat 编排 |

## 8. 测试索引（`apps/web/src/lib`）

| 文件 | 覆盖 |
|------|------|
| `auth/password.test.ts` | 哈希/校验/策略 |
| `auth/account.test.ts` | 注册（签到码、唯一性、配额回滚）、登录 |
| `auth/ip.test.ts`、`auth/ip-binding.test.ts` | IP 提取与每 IP 配额（含地址不可解析时的共享桶） |
| `auth/rate-limit.test.ts` | 混合窗口下不会误删生效中的计数 |
| `db/migrate.test.ts` | 旧库重建为本地账号结构（幂等、删除旧身份表） |
| `db/backup.test.ts` | 备份不改动源库结构（不跑迁移/seed） |
| `queue/requeue-guard.test.ts` | 取消与超时重排竞争时不会复活已取消条目 |
| `settings/checkin.test.ts` | 签到码窗口、宽限、轮换、跨场地不通用 |
| `queue/head-timeout*.test.ts` | 队头确认超时回队尾（含双人） |
| `queue/finish-requeue.test.ts` | 结束游玩回队尾 |
| `queue/join-concurrency.test.ts` | 并发入队与一人一条 |
| `queue/join-qq.test.ts` | 未绑定 QQ 不可排队 |
| `queue/public-snapshot.test.ts` | 公开快照截断与计数 |
| `queue/bot.test.ts` | Bot catalog/详情与 Bearer 鉴权 |
| `queue/maintenance.test.ts` | 保留策略清理 |
| `env.test.ts`、`api.test.ts`、`constants/catalog.test.ts` | 环境变量校验、同源检查、目录配置 |
