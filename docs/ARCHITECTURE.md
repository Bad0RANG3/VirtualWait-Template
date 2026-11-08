# 架构与队列流程

本文描述当前模板的运行时结构、账号与签到码流程、以及队列领域规则，便于定制与排障。
实现以代码为准；若本文与代码冲突，以代码为准。

## 1. 系统拓扑

```text
浏览器
  │  HTTPS / 受控 HTTP
  ▼
反向代理（可选 Nginx）
  │
  ▼
Web (Next.js, 127.0.0.1:3000)
  ├─ 账号与会话（本地口令）
  ├─ 场地签到码（时间窗口派生）
  ├─ 队列状态机与管理台 API
  ├─ Bot API（可选 Bearer）
  └─ 本地 SQLite（账号、队列、会话、审计、运行时设置）

QQ -- OneBot v11 WS --> NapCat --> Bot (NoneBot2, services/bot)
Bot -- Bearer --> Web /api/bot/* -- 队列空闲 @ 提醒 --> 队首
```

- Web 是唯一的服务端组件；**没有任何外部身份服务、游戏服务器或 Gateway 进程**。
- 运行数据在 `apps/web/data/`（或 `VIRTUALWAIT_DATA_DIR`），被 Git 忽略。

## 2. 单体仓库地图

| 路径 | 职责 |
|------|------|
| `apps/web` | Next.js 前端、账号/队列/管理 API、SQLite、Bot API |
| `services/bot` | NoneBot2 QQ 机器人（队列空闲通知） |
| `infra/server` | Nginx / systemd / 环境变量样例 |
| `infra/docker` | 机器人镜像与 compose |
| `scripts/verify-all.mjs` | 一键门禁（Web + 部署样例 + 机器人） |
| `docs/` | 模板定制、安全清单、本文 |

## 3. 身份：本地账号 + 场地签到码

### 3.1 账号

| 字段 | 规则 |
|------|------|
| `username` | 3–20 位 `[A-Za-z0-9_-]`，`COLLATE NOCASE` 唯一 |
| 口令 | 8–128 位；scrypt(N=16384, r=8, p=1) + 每用户 16 字节随机盐，存 `password_hash`/`password_salt`/`password_algo` |
| `nickname` | 2–20 个可见字符（拒绝控制/格式字符），`COLLATE NOCASE` 唯一，显示在公开队列板 |
| `qq` | 可空唯一，5–12 位数字，用于机器人 @ 提醒；公开接口永不返回 |
| `checkin_venue_id` | 注册时所用签到码所属场地 |

实现见 [`apps/web/src/lib/auth/account.ts`](../apps/web/src/lib/auth/account.ts) 与
[`password.ts`](../apps/web/src/lib/auth/password.ts)。

- 用户名不存在时也会执行一次等价 scrypt 计算，失败统一返回 `INVALID_CREDENTIALS`，避免账号枚举。
- 注册与登录分别限流；返回 `429` + `RATE_LIMITED`（见 `lib/auth/rate-limit.ts`）。
  登录按账号计所有尝试、按 IP 只计失败尝试——场馆共享出口下的正常登录不会被自己人限流。
- 限流桶按「该行自己的窗口长度」判断过期：短窗口调用方（例如每 5 秒一次的 Bot 轮询）
  不会清掉仍在生效的长窗口计数。

### 3.2 场地签到码

```text
windowIndex = floor(now / CHECKIN_WINDOW_SEC)
code        = HMAC_SHA256(venue.checkin_secret, "vw-checkin:" + windowIndex)[0..3] mod 1e6  → 6 位
```

- `checkin_secret` 为每场地 32 字节随机值，首次读取时懒生成，仅存于 SQLite。
- 默认窗口 600 秒；额外接受 `CHECKIN_GRACE_WINDOWS`（默认 1）个历史窗口，避免跨窗口边界误拒。
- 注册时校验并记录 `checkin_venue_id`；校验失败返回 `CHECKIN_INVALID`，缺失返回 `CHECKIN_REQUIRED`。
- 管理台可查看当前码与剩余时间，并可「立即轮换」（轮换后旧码立即失效）。
- 关闭 `CHECKIN_REQUIRED` 允许无码注册，仅适用于封闭内网部署。

实现见 [`apps/web/src/lib/settings/checkin.ts`](../apps/web/src/lib/settings/checkin.ts)。

### 3.3 会话

| 项 | 说明 |
|----|------|
| Cookie | `vw_session`，HMAC-SHA256 签名载荷（uid/sid/ip/exp），`HttpOnly`、`SameSite=Strict`、生产 `Secure` |
| 服务端 | `session` 表行记录 `issued_at_ms`/`revoked_at_ms`，登出即吊销（即使 Cookie 被复制也失效） |
| 生命周期 | `SESSION_MAX_AGE_DAYS`（默认 30），维护任务清理过期行 |
| IP 连续性 | 命中时校验客户端 IP 哈希与登录时一致，不一致直接拒绝 |

实现见 [`apps/web/src/lib/auth/session.ts`](../apps/web/src/lib/auth/session.ts)。

### 3.4 每 IP 每日注册配额

- `ip_day_binding` 按（`ip_hash`, 上海日历日, `user_id`）记录；`IP_ACCOUNT_QUOTA_PER_DAY` 默认 5。
- **只作用于注册**：登录只更新 `last_login_ip_hash`/`last_login_day`，不受配额限制
  （场馆共享 Wi-Fi/NAT 会服务很多玩家，否则会把常客挡在门外）。
- 账号行与配额绑定在**同一个事务**里写入：配额失败时账号一并回滚，并写入审计
  `IP_BINDING_QUOTA_HIT`（审计在回滚之后单独记录，因此不会随之消失）。
- 无法解析客户端地址时（代理漏配），所有这类客户端哈希到同一个值，**共用一个保守配额桶**
  而不是被豁免——豁免等于给它们无限开户能力。

实现见 [`apps/web/src/lib/auth/ip-binding.ts`](../apps/web/src/lib/auth/ip-binding.ts)。

## 4. Web 内部结构

### 4.1 目录导航与目录数据

公开页面按 **城市 → 区/县 → 场地 → 机台** 组织：

| 路由 | 说明 |
|------|------|
| `/` | 城市目录 |
| `/city/[citySlug]` | 区/县列表 |
| `/city/[citySlug]/[districtSlug]` | 场地与机台卡片（含活跃排队人数） |
| `/queue/[venueSlug]/[machineSlug]` | 机台公开队列板 |
| `/login` | 登录 / 注册（用户名 + 口令 + 昵称 + 场地签到码） |
| `/me` | 个人资料、QQ 绑定、我的排队记录 |
| `/admin` | 管理员运维台 |

静态目录定义在 [`apps/web/src/lib/constants/catalog.ts`](../apps/web/src/lib/constants/catalog.ts)。
运行时可覆盖的场地元数据（地址、区县展示、开放时间、群 UMO）与机台硬币数在 SQLite，经
[`apps/web/src/lib/settings/venue-meta.ts`](../apps/web/src/lib/settings/venue-meta.ts) 读写；
超时默认值来自环境变量，管理员可写入 `app_settings`；签到码密钥在 `venue.checkin_secret`。

### 4.2 队列领域模块

稳定入口为 `apps/web/src/lib/queue/service.ts`（仅 re-export）。实现按职责拆分：

| 模块 | 职责 |
|------|------|
| `core.ts` | 审计、party、上机、重排队尾、结束/过期 |
| `public.ts` | 公开队列视图、按机台活跃人数统计 |
| `user-actions.ts` | 加入、拼机确认、取消、队头确认上机、结束游玩 |
| `timeouts.ts` | 游玩超时回队尾、队头确认超时自动排到队尾 |
| `admin.ts` | 队列开闭、活跃条目、管理员动作、审计列表 |
| `views.ts` | 队列槽位/展示组装 |
| `maintenance.ts` | 保留策略清理（由 `npm run maintenance` 驱动） |

相关支撑：

| 路径 | 职责 |
|------|------|
| `lib/settings/timeouts.ts` | 游玩超时、队头确认超时（环境默认 + DB 覆盖） |
| `lib/settings/checkin.ts` | 场地签到码派生、校验、轮换 |
| `lib/settings/venue-meta.ts` | 场地元数据、机台 `coin_cost` |
| `lib/time/hours.ts` | 开放时间解析与「当前是否营业」 |
| `lib/db/` | SQLite schema、迁移、连接与 seed |

### 4.3 主要 API（概览）

身份（写接口需同源）：

- `POST /api/auth/register` — 用户名 + 口令 + 昵称 + 场地签到码
- `POST /api/auth/login` — 用户名 + 口令
- `POST /api/auth/logout`、`GET/PATCH /api/auth/me`

用户侧（需会话 / 同源写校验）：

- `POST /api/queues/{venue}/{machine}/join`
- `GET  /api/queues/{venue}/{machine}/public`
- `POST /api/entries/{id}/confirm` — 队头确认上机
- `POST /api/entries/{id}/cancel`
- `POST /api/entries/{id}/finish`
- `POST /api/parties/...` — 拼机确认等

管理员（`ADMIN_API_TOKEN` 会话）：

- `GET/POST /api/admin/session`
- `GET/PATCH /api/admin/settings` — 超时
- `PATCH /api/admin/venues/{id}` — 地址、区县、开放时间、群 UMO
- `GET/POST /api/admin/venues/{id}/checkin` — 读取 / 轮换场地签到码
- `PATCH /api/admin/machines/{id}` — 机台硬币数
- `POST /api/admin/queues/{id}/status` — OPEN / PAUSED / CLOSED
- `POST /api/admin/entries/{id}/action` — 代开始/重排/取消/结束等
- `GET /api/admin/audit`

## 5. 队列状态与默认规则

### 5.1 记录状态（概念）

- 等待：`WAITING`（含拼机进行中的条目）
- 游玩：`PLAYING`
- 终态：`DONE` / `CANCELLED` / `EXPIRED`；「结束游玩」与超时不再是终态，而是自动回队尾继续排队

单人条目与双人 `party` 在队头判定时按 **组** 计：单刷一组、已确认拼机一组。
同一用户在任一队列中只能有一条 `WAITING`/`PLAYING` 记录，由部分唯一索引兜底。

### 5.2 用户路径

1. 注册（场地签到码）或登录（用户名 + 口令）→ 会话。
2. 在开放机台 `join`（单人 / 发起或加入双人）。
3. 机台无 `PLAYING` 且自己在队头时，用户点 **确认上机**（`confirmStartPlay`）。
4. 游玩结束后用户或管理员 **结束**，条目**自动回到队尾**继续排队（不想继续可随时取消）；
   达到游玩超时后系统同样将条目 **重排到队尾**。

### 5.3 队头确认超时

当机台空闲时，系统为当前队头组标记 `head_eligible_at`。
超时秒数：`HEAD_CONFIRM_TIMEOUT_SEC`（默认 **180**），可被管理员运行时覆盖。

| 行为 |
|------|
| 超时后整组**自动排到队尾**（单刷/拼机均算一组），下一位队首获得新的确认窗口 |
| 整组的 `head_miss_count` +1，成功上机时归零；该计数进入通知键，使超时的一人队也能被再次 @ |

管理员仍可强制开始/重排/取消/结束，不依赖用户确认按钮。

### 5.4 游玩超时

`PLAYING_TIMEOUT_SEC`（默认 **1500** 秒）到期后，条目自动回到队尾并记审计原因 `playing_timeout`。
同样可被管理员设置覆盖。

### 5.5 超时处理触发

`processTimeouts(queueId)` 在用户动作、管理员动作与维护周期等入口被调用；
公开读路径保持无副作用（GET 不推进超时），不要假设仅有单一 cron。

## 6. 目录与运行时覆盖

| 数据 | 来源 | 说明 |
|------|------|------|
| 城市 / 区县 / slug / 默认机台列表 | `catalog.ts` | 代码配置，部署时替换示例 |
| 场地地址、区县展示、开放时间、群 UMO | DB `venue` + settings API | 管理员可改；缺省回退 catalog |
| 场地签到码密钥 | DB `venue.checkin_secret` | 懒生成；管理台可轮换 |
| 机台硬币数 `coin_cost` | DB `queue` 行 | 管理员可改；catalog 可给默认 |
| 超时秒数 | env → `app_settings` | 管理员覆盖 env 默认 |

## 7. 数据保留

`npm run maintenance` 常驻，按环境变量清理：

| 数据 | 变量 | 默认 |
|------|------|------|
| 限流桶 | `RATE_LIMIT_BUCKET_RETENTION_SEC` | 3600 秒 |
| 每 IP 日配额 | `IP_BINDING_RETENTION_DAYS` | 2 天 |
| 不活跃登录元数据 | `LOGIN_METADATA_RETENTION_DAYS` | 180 天 |
| 终态队列与拼机 | `QUEUE_HISTORY_RETENTION_DAYS` | 180 天 |
| 审计事件 | `AUDIT_EVENT_RETENTION_DAYS` | 365 天 |
| 会话行 | `SESSION_MAX_AGE_DAYS` | 30 天 |

## 8. 验证

```bash
node scripts/verify-all.mjs
```

或分步：`apps/web` 的 lint / tsc / unit / e2e / browser / build，以及 `services/bot` 的 pytest。

## 9. 机器人队列通知（Bot API）

与 QQ 机器人（services/bot，NoneBot2）联动时，Web 提供独立 Bearer 鉴权的 Bot 面（`BOT_API_TOKEN`），
**不**复用管理员 token：

| 路径 | 用途 |
|------|------|
| `GET /api/bot/catalog` | 全市机台摘要（`activeCount` / `hasPlaying` / `groupUmo`） |
| `GET /api/bot/queues/{venue}/{machine}` | 详情：`machineIdle`、队首玩家与可选 `qq` |

用户在 `/me` 绑定 `app_user.qq`；场地在管理后台配置 `venue.group_umo`（下发为 `groupUmo`）。公开 `/public` **永不**返回 QQ。

细节、限流默认值、插件行为与测试矩阵见 [QUEUE_NOTIFY.md](QUEUE_NOTIFY.md)。

## 10. 升级注意（来自旧版本）

旧版本的数据库使用外部扫码身份，账号表结构不同。`lib/db/migrate.ts` 检测到旧结构时会重建
`app_user` 并清空 `session`/`queue_entry`/`queue_party`/`ip_day_binding`，旧身份相关表被删除。
旧账号没有本地口令，**无法迁移**：升级前必须公告玩家用用户名 + 口令 + 当场签到码重新注册。
