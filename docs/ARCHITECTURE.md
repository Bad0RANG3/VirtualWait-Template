# 架构与队列流程

本文描述当前模板的运行时结构与队列领域规则，便于定制与排障。实现以代码为准；若本文与代码冲突，以代码为准。

## 1. 系统拓扑

```text
浏览器
  │  HTTPS / 受控 HTTP
  ▼
反向代理（可选 Nginx）
  │
  ├─► Web (Next.js, 127.0.0.1:3000)
  │     │  HMAC 签名请求
  │     ▼
  │   Gateway (Python, 127.0.0.1:8787)
  │     │  mock | http | sdgb_preview
  │     ▼
  │   身份上游（仅真实 provider）
  │
  └─ Web 本地 SQLite（队列、会话、审计、运行时设置）
```

- Web **始终** `GATEWAY_MODE=remote`，不内嵌身份 mock。
- Gateway 默认不暴露公网；本地与自托管示例均绑定回环地址。
- 运行数据在 `apps/web/data/`（或 `VIRTUALWAIT_DATA_DIR`）与 Gateway 的 `data/`，均被 Git 忽略。

## 2. 单体仓库地图

| 路径 | 职责 |
|------|------|
| `apps/web` | Next.js 15 前端、队列/管理 API、SQLite |
| `services/sdgb-gateway` | 签名身份 Gateway 与 provider |
| `packages/contracts` | Gateway JSON Schema 与测试夹具 |
| `infra/server` | Nginx / systemd / 环境变量样例 |
| `scripts/verify-all.mjs` | 一键门禁（Web + Gateway + 部署样例） |
| `docs/` | 模板定制、安全清单、本文 |

## 3. Web 内部结构

### 3.1 目录导航与目录数据

公开页面按 **城市 → 区/县 → 场地 → 机台** 组织：

| 路由 | 说明 |
|------|------|
| `/` | 城市目录 |
| `/city/[citySlug]` | 区/县列表 |
| `/city/[citySlug]/[districtSlug]` | 场地与机台卡片（含活跃排队人数） |
| `/queue/[venueSlug]/[machineSlug]` | 机台公开队列板 |
| `/login` `/register` `/bind` `/me` | 登录与个人 |
| `/admin` | 管理员运维台 |

静态目录定义在 [`apps/web/src/lib/constants/catalog.ts`](../apps/web/src/lib/constants/catalog.ts)。
运行时可覆盖的场地元数据（地址、区县展示、开放时间）与机台硬币数在 SQLite，经 [`apps/web/src/lib/settings/venue-meta.ts`](../apps/web/src/lib/settings/venue-meta.ts) 读写；超时默认值来自环境变量，管理员可写入 `app_settings`。

### 3.2 队列领域模块

稳定入口为 `apps/web/src/lib/queue/service.ts`（仅 re-export）。实现按职责拆分：

| 模块 | 职责 |
|------|------|
| `core.ts` | 审计、party、上机、重排队尾、结束/过期 |
| `public.ts` | 公开队列视图、按机台活跃人数统计 |
| `user-actions.ts` | 加入、拼机确认、取消、队头确认上机、结束游玩 |
| `timeouts.ts` | 游玩超时回队尾、队头确认超时（后移/卸卡） |
| `admin.ts` | 队列开闭、活跃条目、管理员动作、审计列表 |
| `views.ts` | 队列槽位/展示组装 |
| `maintenance.ts` | 保留策略清理（由 `npm run maintenance` 驱动） |

相关支撑：

| 路径 | 职责 |
|------|------|
| `lib/settings/timeouts.ts` | 游玩超时、队头确认超时（环境默认 + DB 覆盖） |
| `lib/settings/venue-meta.ts` | 场地元数据、机台 `coin_cost` |
| `lib/time/hours.ts` | 开放时间解析与“当前是否营业” |
| `lib/db/` | SQLite schema 与连接 |

### 3.3 主要 API（概览）

用户侧（需会话 / 同源写校验）：

- `POST /api/queues/{venue}/{machine}/join`
- `GET  /api/queues/{venue}/{machine}/public`
- `POST /api/entries/{id}/confirm` — 队头确认上机
- `POST /api/entries/{id}/cancel`
- `POST /api/entries/{id}/finish`
- `POST /api/parties/...` — 拼机确认等
- 认证：`/api/auth/*`、`/api/bind`、`/api/me`

管理员（`ADMIN_API_TOKEN` 会话）：

- `GET/POST /api/admin/session`
- `GET/PATCH /api/admin/settings` — 超时
- `PATCH /api/admin/venues/{id}` — 地址、区县、开放时间等
- `PATCH /api/admin/machines/{id}` — 机台硬币数
- `POST /api/admin/queues/{id}/status` — OPEN / PAUSED / CLOSED
- `POST /api/admin/entries/{id}/action` — 代开始/重排/取消/结束等
- `GET /api/admin/audit`

## 4. 队列状态与默认规则

### 4.1 记录状态（概念）

- 等待：`WAITING`（含拼机进行中的条目）
- 游玩：`PLAYING`
- 终态：取消、完成、超时卸卡等（由实现枚举定义，见 contracts）

单人条目与双人 `party` 在队头判定时按 **组** 计：单刷一组、已确认拼机一组。

### 4.2 用户路径

1. 登录（Gateway 校验二维码 → 匿名 subject + 最小公开资料）。
2. 在开放机台 `join`（单人 / 发起或加入双人）。
3. 机台无 `PLAYING` 且自己在队头时，用户点 **确认上机**（`confirmStartPlay`）。
4. 游玩结束后用户或管理员 **结束**；否则达到游玩超时后系统将条目 **重排到队尾**。

### 4.3 队头确认超时

当机台空闲时，系统为当前队头组标记 `head_eligible_at`。
超时秒数：`HEAD_CONFIRM_TIMEOUT_SEC`（默认 **180**），可被管理员运行时覆盖。

| 次数 | 行为 |
|------|------|
| 第 1 次超时 | 整组后移 **1 组**（单刷/拼机均算一组），`head_miss_count` 记 1 |
| 第 2 次超时 | **自动取消（卸卡）** |

管理员仍可强制开始/重排/取消/结束，不依赖用户确认按钮。

### 4.4 游玩超时

`PLAYING_TIMEOUT_SEC`（默认 **1500** 秒）到期后，条目自动回到队尾并记审计原因 `playing_timeout`。同样可被管理员设置覆盖。

### 4.5 超时处理触发

`processTimeouts(queueId)` 在用户动作、公开读路径与维护周期等入口被调用；不要假设仅有单一 cron。

## 5. 目录与运行时覆盖

| 数据 | 来源 | 说明 |
|------|------|------|
| 城市 / 区县 / slug / 默认机台列表 | `catalog.ts` | 代码配置，部署时替换示例 |
| 场地地址、区县展示、开放时间 | DB `venue` + settings API | 管理员可改；缺省回退 catalog |
| 机台硬币数 `coin_cost` | DB `queue` 行 | 管理员可改；catalog 可给默认 |
| 超时秒数 | env → `app_settings` | 管理员覆盖 env 默认 |

## 6. Gateway 角色（简述）

Gateway 负责：

1. 校验 Web 的 HMAC / 时间戳 / nonce / 请求摘要；
2. 调用 provider（`mock` / `http` / `sdgb_preview`）；
3. 将上游身份 HMAC 为匿名 subject；
4. 只返回允许公开的最小资料；
5. **不**持久化原始二维码、token、完整上游响应。

细节见 [Gateway README](../services/sdgb-gateway/README.md)。

## 7. 验证

```bash
node scripts/verify-all.mjs
```

或分步：`apps/web` 的 lint / tsc / unit / e2e / browser，以及 `services/sdgb-gateway` 的 pytest。

## 8. 机器人队列通知（Bot API）

与 AstrBot 插件联动时，Web 提供独立 Bearer 鉴权的 Bot 面（`BOT_API_TOKEN`），**不**复用管理员 token：

| 路径 | 用途 |
|------|------|
| `GET /api/bot/catalog` | 全市机台摘要（`activeCount` / `hasPlaying` / `groupUmo`） |
| `GET /api/bot/queues/{venue}/{machine}` | 详情：`machineIdle`、队首玩家与可选 `qq` |

用户在 `/me` 绑定 `app_user.qq`；场地在管理后台配置 `venue.group_umo`（下发为 `groupUmo`）。公开 `/public` **永不**返回 QQ。

细节、限流默认值、插件行为与测试矩阵见 [QUEUE_NOTIFY.md](QUEUE_NOTIFY.md)。
