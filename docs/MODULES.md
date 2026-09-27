# 模块手册（Module Reference）

本文档是 VirtualWait-Template 的**模块级**参考：每个源码模块/路由/脚本的职责、关键导出与不变量。
架构与部署请另读 [ARCHITECTURE.md](ARCHITECTURE.md)、[TECHNICAL_SPEC.md](TECHNICAL_SPEC.md)、[SECURITY.md](SECURITY.md)、[DEPLOYMENT.md](DEPLOYMENT.md)。

```
浏览器 ──> Nginx(infra/server/nginx) ──> Next.js Web(apps/web)
                                          │  GATEWAY_MODE=remote
                                          ▼
                                身份 Gateway(services/sdgb-gateway) ──> 上游验证服务/AiMe
                                          │
                              systemd(infra/server/systemd) 托管 web/maintenance/backup/healthcheck
```

分层约定：`lib/` 内**不**依赖 `app/`；`app/api` 路由只做参数解析、权限与响应组装，业务逻辑在 `lib/`；`components/` 只经 `/api` 与页面 props 交互。

---

## 1. Web 服务端库（apps/web/src/lib）

### 1.1 数据库层 `lib/db/`

| 模块 | 职责与关键导出 |
|---|---|
| `index.ts` | 统一出口：re-export `getDb`、`nowIso`、`addSeconds`、`SCHEMA_SQL`、`openDatabase` |
| `connection.ts` | SQLite 单例：首次 `getDb()` 时执行建表（schema）、迁移（migrate）、目录种子（seed），开启 WAL 与外键 |
| `sqlite.ts` | `node:sqlite` 轻封装：`openDatabase`、`Db`（exec/prepare/pragma/transaction）、`Statement` |
| `schema.ts` | 导出 `SCHEMA_SQL`（全量 DDL）与 `MIGRATIONS_SQL`（增量变更），含队列/审计/防滥用/`completion_token`/`session` 表 |
| `migrate.ts` | 幂等迁移：`migrate(db)`，容错重复列，重建 legacy `ip_day_binding` 主键（见 `_ensureIpDayBindingQuota`，正则依赖 sqlite_master 原文格式） |
| `seed.ts` | `seed(db)`：从 catalog `INSERT OR IGNORE` + `COALESCE` 灌场地/机台默认，不覆盖管理员编辑 |
| `utils.ts` | 时间工具 `nowIso()`、`addSeconds()` |

### 1.2 认证与会话 `lib/auth/`

| 模块 | 职责与关键导出 |
|---|---|
| `session.ts` | 用户会话：HMAC 签名 Cookie（`vw_session`，payload 含 `uid/sid/ip/exp`）；`setSession`（写 `session` 表行支持吊销）、`clearSession`（置 `revoked_at_ms`）、`getSessionUser`（校验签名/过期/IP 连续/session 行未吊销）、`upsertMaimaiUser`、`getUserById` |
| `login-attempt.ts` | `resolveLoginAttempt`：消费 Gateway 结果 → upsert 用户、IP 绑定（配额失败写 `IP_ACCOUNT_BOUND` + 审计 + 回滚新建账号）、写 `join_attempt.result_json`；`loginAttemptUser` |
| `completion-capability.ts` | 一次性登录完成令牌：`createCompletionCapability`（库中只存 SHA-256 哈希）、`consumeCompletionCapability`（单次消费即删）、`cleanupExpiredCompletionCapabilities` |
| `ip-binding.ts` | 每 IP 每上海日绑定配额：`assertIpCanBindUser`（快速失败）+ `bindIpToUser`（`INSERT…SELECT WHERE COUNT<quota` 原子守卫，`changes=0` 时区分已绑定/配额满） |
| `ip.ts` | `getClientIp`（受 `TRUST_PROXY_HEADERS` 控制取代理头）+ `hashIp`（HMAC，防库泄露反查） |
| `rate-limit.ts` | 固定窗口限流桶 + QR 验证并发槽（`reserveQrSlot`/`acquireQrSlot`/`releaseQrSlot`）+ 旧桶清理 |
| `time.ts` | 上海日键 `shanghaiDayKey`、下一午夜 `nextMidnightMs`、剩余秒数 |
| `admin.ts` | 管理员认证：`vw_admin` Cookie 签发/校验/清除，`requireAdmin` 支持 Bearer `ADMIN_API_TOKEN` 或 Cookie |
| `bot.ts` | 机器人认证：`requireBot` 校验 `BOT_API_TOKEN` Bearer 头 |

### 1.3 队列领域 `lib/queue/`

| 模块 | 职责与关键导出 |
|---|---|
| `service.ts` | **稳定入口**（仅 re-export），路由/外部一律从此导入 |
| `core.ts` | 原语：`audit`、`getParty`、`startEntries`、`requeueToEnd`、`finishOrExpireEntry`、`listActiveEntries` + 行类型 |
| `user-actions.ts` | 用户操作：`joinQueue`（SOLO/DUO/加入拼机；事务内分配序号、部分唯一索引兜底并发、原子抢位 `joinExistingDuo`）、`confirmPair`、`cancelEntry`、`confirmStartPlay`、`finishPlay`、`getUserActiveEntries` |
| `timeouts.ts` | `processTimeouts`：游玩超时回队尾 + 队头确认窗口（`waitingGroups` 组级打点，duo 取最早戳；确认超时整组自动排到队尾，不卸卡） |
| `views.ts` | `buildSlots`/`toPartyView`/`toEntryView`：行 → 对外视图（位置、`canConfirmStart`、公开资料脱敏） |
| `public.ts` | `getPublicQueue`（只读无副作用、WAITING 截断至 200 防超大响应、`totalWaiting` 如实）、`countActiveEntries*` |
| `maintenance.ts` | `runMaintenance`：超时处理 + 清理过期 attempt/限流桶/QR 槽/完成令牌(300s)/IP 日绑定/不活跃资料/终态队列/审计(365d)/session(30d) |
| `admin.ts` | 管理操作：`setQueueStatus`、`listAuditEvents`、`listAdminActiveEntries`、`adminEntryAction`（START/REQUEUE/CANCEL/FINISH，版本乐观锁） |
| `bot.ts` | 机器人视图：`getBotCatalog`、`getBotQueueDetail`、`botHeadCooldownKey` |

### 1.4 运行时设置 `lib/settings/`

| 模块 | 职责与关键导出 |
|---|---|
| `index.ts` | 统一出口（re-export 超时/场地元数据/营业时间） |
| `timeouts.ts` | `app_settings` 表读写游玩/队头确认超时（DB 优先、env 兜底），带范围校验 |
| `venue-meta.ts` | 场地/机台元数据 CRUD：`getVenueMeta`/`updateVenueMeta`/`updateMachineMeta`/`getVenueHoursBySlug`/`isVenueOpenNow` |

### 1.5 身份网关客户端 `lib/gateway/`

| 模块 | 职责与关键导出 |
|---|---|
| `client.ts` | HMAC 签名请求头；`createVerificationJob`、`getVerificationJob`（轮询、响应大小上限） |
| `contracts.ts` | v1 响应契约 zod 校验（建任务/验证响应） |

### 1.6 支撑模块 `lib/`

| 模块 | 职责 |
|---|---|
| `constants/catalog.ts` | 模板目录静态数据（`CITIES`/`CityDef`/`venueBySlug`/slug 辅助） |
| `time/hours.ts` | 营业时间换算与 `isWithinHours`（UTC+8） |
| `api.ts` | 错误码→HTTP 映射、`jsonOk`/`jsonError`、`assertSameOrigin`、`mapServiceError`、`readJsonBody`、`withUser`/`withAdmin` |
| `crypto.ts` | `sha256Hex`、HMAC、`randomToken`、`safeEqual`、`signPayload` |
| `env.ts` | 环境变量集中解析 + 生产不安全密钥检查（`env` 对象） |
| `types.ts` | 共享类型：状态机、`PublicQueueSnapshot`、`SessionUser`、管理员视图 |

---

## 2. Web API 路由（apps/web/src/app/api）

所有写接口同源校验；`Cache-Control: no-store`；错误经 `mapServiceError` 映射。

### 2.1 认证

| 路由 | 方法 | 权限 | 用途 |
|---|---|---|---|
| `/api/auth/register` | POST | 同源 | **占位**：密码注册已禁用，恒返 410 |
| `/api/auth/login` | POST | 同源 | **占位**：密码登录已禁用，恒返 410 |
| `/api/auth/qr` | POST | 同源 | 舞萌二维码登录：限流+并发槽+幂等（重放轮换完成令牌），建 Gateway 任务 |
| `/api/auth/attempts/[attemptId]` | GET | 同源+IP 匹配+限流 | 只读轮询尝试状态；SUCCEEDED 附公开 profile |
| `/api/auth/complete` | POST | 同源+IP 匹配 | 一次性完成令牌校验（先消费）→ 建会话 |
| `/api/auth/logout` | POST | 同源 | 吊销 session 行 + 清 Cookie |
| `/api/auth/me` | GET/PATCH | 登录 | 用户信息；改昵称/评分公开/QQ（唯一性） |
| `/api/bind` | POST | 登录+同源 | 刷新/绑定舞萌资料（身份冲突/已绑定/幂等） |

### 2.2 队列

| 路由 | 方法 | 权限 | 用途 |
|---|---|---|---|
| `/api/queues/[venueSlug]/[machineSlug]/public` | GET | 公开 | 队列快照（含可选当前用户视图） |
| `/api/queues/[venueSlug]/[machineSlug]/join` | POST | 登录+已绑 QQ+同源 | SOLO/DUO/加入拼机 |
| `/api/parties/[partyId]/confirm` | POST | 登录+同源 | 确认拼机配对 |
| `/api/entries/[entryId]/finish` | POST | 登录+同源 | 结束游玩 |
| `/api/entries/[entryId]/cancel` | POST | 登录+同源 | 取消排队 |
| `/api/entries/[entryId]/confirm` | POST | 登录+同源 | 队头确认开始 |
| `/api/me/entries` | GET | 登录 | 我的活跃排队记录 |

### 2.3 管理（`ADMIN_API_TOKEN`/`vw_admin` Cookie）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/admin/session` | POST/DELETE | 令牌登录（签 Cookie）/登出 |
| `/api/admin/audit` | GET | 审计事件（limit≤200） |
| `/api/admin/entries` | GET | 活跃条目（含 isDuo） |
| `/api/admin/entries/[entryId]/action` | POST | START/REQUEUE/CANCEL/FINISH（version 乐观锁） |
| `/api/admin/settings` | GET/POST | 超时设置读写 |
| `/api/admin/venues` | GET | 场地元数据列表 |
| `/api/admin/venues/[venueId]` | GET/POST | 列表（GET 与上同）/单场地更新 |
| `/api/admin/machines/[machineId]` | GET/POST | 列表/单机台币数（1-99） |
| `/api/admin/queues/[queueId]/status` | POST | OPEN/PAUSED/CLOSED 切换（记审计） |

### 2.4 Bot 与健康

| 路由 | 方法 | 权限 | 用途 |
|---|---|---|---|
| `/api/bot/catalog` | GET | `BOT_API_TOKEN` | 目录（活跃数/营业判断），分钟限流 |
| `/api/bot/queues/[venueSlug]/[machineSlug]` | GET | `BOT_API_TOKEN` | 队头/等待槽/空闲，分钟限流 |
| `/api/healthz` | GET | 无 | 仅 `SELECT 1`，不泄露业务信息 |

---

## 3. Web 页面（apps/web/src/app）

| 页面 | 职责 |
|---|---|
| `/`（`page.tsx`） | 首页：统计 + LocationPicker + 按城市分区入口（hero 仅保留刷新，导航在 AppShell） |
| `/city/[citySlug]` | 区/县列表，未知城市 404 |
| `/city/[citySlug]/[districtSlug]` | 场地与机台卡片（活跃人数/币数/营业状态） |
| `/queue/[venueSlug]/[machineSlug]` | 队列板服务端入口：取会话与快照渲染 QueueBoard |
| `/login` | 未登录 → QrLoginForm；已登录 → 重定向首页 |
| `/bind` | 登录后扫码刷新资料（QrBindForm） |
| `/me` | 个人中心：资料、活跃排队、退出 |
| `/admin` | 管理后台：登录表单或 AdminDashboard |

---

## 4. Web 组件（apps/web/src/components）

| 组件 | 职责 |
|---|---|
| `AppShell.tsx` | 全局外壳：粘性顶栏（Logo、登录/我的导航）+ 内容容器 |
| `LocationPicker.tsx` | 级联选择器，直接消费 `CityDef`（与 /city 目录零漂移） |
| `QueueBoard.tsx` | 队列板客户端：轮询（AbortController + 指数退避 3.5s→30s）、入队/取消/确认、结束回尾、溢出提示 |
| `hooks/useQrVerificationFlow.ts` | 共享扫码验证 hook：提交一次 + 轮询 attempt 至离开 PROCESSING |
| `QrLoginForm.tsx` | 扫码登录（轮询后凭完成令牌调 complete） |
| `QrBindForm.tsx` | 扫码刷新/绑定资料（REGISTER_BIND/LOGIN_BIND） |
| `ProfileSettingsForm.tsx` | 昵称/Rating 公开/QQ 编辑（PATCH /api/auth/me） |
| `LogoutButton.tsx` | 登出并回首页 |
| `AdminLoginForm.tsx` | 管理令牌登录 |
| `AdminDashboard.tsx` | 管理面板聚合：队列/超时/场地机台/条目/审计（统一 mutate） |
| `admin/AdminVenueEditor.tsx` | 场地元数据（地址/区县/机台数/营业时间/群 UMO） |
| `admin/AdminTimeoutSettings.tsx` | 游玩/队头确认超时设置 |
| `admin/AdminQueueControls.tsx` | 队列三态控制 |
| `admin/AdminMachineCoinEditor.tsx` | 机台币数编辑 |
| `admin/AdminEntryActions.tsx` | 条目操作（含双人整组） |
| `admin/AdminAuditLog.tsx` | 审计只读列表 |
| `queue/QueueStatusHeader.tsx` | 队列页头部徽章（组数/币数/超时/营业） |
| `queue/QueueSlotList.tsx` | 槽位列表（单刷/拼机、"我"高亮） |
| `queue/DuoDiscoveryList.tsx` | 可加入拼机发现列表 |

---

## 5. Web 运维脚本（apps/web/scripts）

| 脚本 | 用途 |
|---|---|
| `preflight.mjs` | 部署前静态检查（Node 版本/密钥强度/URL/`GATEWAY_MODE`/`TRUST_PROXY_HEADERS`；生产强制 HTTPS，可用 `ALLOW_INSECURE_APP_URL` 放行内网） |
| `e2e.mjs` | 端到端：临时端口起 Web+Gateway，跑完整业务流断言 |
| `healthcheck.mjs` | 本地健康检查（Web `/api/healthz` + Gateway `/healthz`） |
| `maintenance.ts` | 常驻维护 worker（`runMaintenance` 循环；`--once` 单次） |
| `reset-db.mjs` | 删除开发库 `data/virtualwait.db`（仅开发） |
| `backup-db.ts` | `VACUUM INTO` 一致性备份，0600、拒绝覆盖 |
| `verify-backup-db.ts` | 备份校验：权限/integrity_check/外键/必需表/行数 |

---

## 6. 身份网关（services/sdgb-gateway/src/virtualwait_gateway）

需要 Python ≥3.11。签名边界：HMAC + 时间戳 + nonce + 重放防护 + SQLite 作业状态。

| 模块 | 职责 |
|---|---|
| `config.py` | `Settings.from_env()`：严格校验，拒绝占位符（`change_me` 等）、弱密钥、模板 `key_id`、相对路径；provider 合法性 |
| `app.py` | HTTP 服务器与路由（`/v1/verification-jobs`、`/v1/score-write-jobs`），按配置选 provider |
| `transport.py` | 安全上游传输：禁跟随重定向（防 SSRF）、响应大小上限、类型化错误 |
| `security.py` | HMAC-SHA256 请求签名验证、nonce/时间戳/重放防护、匿名 subject 派生 |
| `repository.py` | SQLite 持久层：`verification_job`（按 `kind` 区分验身/传分作业）/`used_nonce`/`rate_limit_bucket`/`pending_logout` |
| `provider.py` | `VerificationProvider` 协议 + mock/http/sdgb_preview 三实现，防御性 JSON 解析 |
| `score_write.py` | 传分作业：内存串行队列 + 最小写入间隔，复用 `packages/sdgb-client` 的 `transfer_score_with_qr`；二维码只在内存中 |
| `sdgb_preview.py` | SDGB 免登录预览：AiMe `get_data` 换 token → `GetUserPreviewApi`，AES 参数加密，仅内存 |
| `service.py` | 业务编排：建任务、调 provider、落状态、重试待登出任务 |
| `contracts.py` | 公开 v1 契约：请求解析/响应构造/错误码与状态机 |
| `__main__.py` / `__init__.py` | CLI 入口（加载 .env.local/.env）/ 包导出 |

---

## 7. 基础设施（infra/server）

| 组件 | 用途 |
|---|---|
| `nginx/virtualwait.conf` | 生产 TLS：80→443、HSTS、限请求体 8k、隐藏 `/api/healthz`、代理到 3000 并重写可信 IP 头 |
| `nginx/virtualwait-intranet.conf` | 受控内网 HTTP 模板（明文 Cookie，禁止公网） |
| `systemd/virtualwait-web.service` | Next.js Web（受限权限，读 `/etc/virtualwait/web.env`） |
| `systemd/virtualwait-gateway.service` | Python Gateway（回环 8787） |
| `systemd/virtualwait-maintenance.service` | 常驻维护 worker |
| `systemd/virtualwait-backup.{service,timer}` | 每晚 03:30 + 抖动备份 |
| `systemd/virtualwait-healthcheck.{service,timer}` | 每分钟健康检查 |
| `scripts/verify-nginx-template.mjs` | 断言 nginx 模板安全模式（限流/隐藏 healthz/IP 头/TLS） |
| `scripts/verify-server-env-examples.mjs` | 校验 4 个 env 样例（格式/必需键/占位符/禁 dev 默认值） |
| `env/*.env.example` | staging/production × Web/Gateway 样例（生产：https、远程 Gateway、`IP_ACCOUNT_QUOTA_PER_DAY=5`） |

---

## 8. 测试索引（apps/web/src/lib）

| 测试文件 | 覆盖 |
|---|---|
| `api.test.ts` | 错误码映射 |
| `env.test.ts` | 环境解析与不安全密钥检测 |
| `gateway/contracts.test.ts` | Gateway 契约校验 |
| `constants/catalog.test.ts` | 目录数据完整性 |
| `auth/ip.test.ts` | IP 提取与哈希 |
| `auth/ip-binding.test.ts` | 配额/重绑/unknown IP |
| `auth/completion-capability.test.ts` | 一次性消费/purge |
| `queue/maintenance.test.ts` | 隐私保留策略（含 session 清理） |
| `queue/head-timeout.test.ts` | 队头超时（solo） |
| `queue/head-timeout-duo.test.ts` | duo 组打点/整组自动排到队尾/不卸卡 |
| `queue/bot.test.ts` | Bot 视图 |
| `queue/join-qq.test.ts` | 入队前置（需绑 QQ） |
| `queue/join-concurrency.test.ts` | 唯一索引兜底/原子抢位 |
| `queue/public-snapshot.test.ts` | 公开快照截断与 totalWaiting |

Gateway 测试见 `services/sdgb-gateway/tests/`（pytest，`test_config`/`test_contract_fixtures`/`test_http_security`/`test_pending_logout`/`test_provider`/`test_sdgb_preview`/`test_sdgb_full`/`test_score_write`）。
