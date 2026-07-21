# VirtualWait Web

VirtualWait 的 Next.js 15 前端与队列 API。该目录是模板代码：不包含有效令牌、用户资料或 SQLite 数据库。

## 本地开发

要求 Node.js 22.5+，项目使用 `node:sqlite`。

```bash
# 先启动 Gateway（另一终端）：
# cd services/sdgb-gateway && PYTHONPATH=src python3 -m virtualwait_gateway
cp .env.example .env.local
npm install
npm run dev
```

`.env.example` 只含不可用于生产的占位值。Web 始终通过签名接口调用 Gateway；本地用 Gateway 的 mock provider + `mock:demo-user:示例玩家:12000:示例称号` 验证完整登录链路。接入真实二维码时，把 Gateway 的 `VW_GATEWAY_PROVIDER` 换成 `http` 或 `sdgb_preview`。

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
```

`data/virtualwait.db` 是本地运行数据，不会被提交。`npm run db:reset` 会删除该数据库，仅限开发环境使用。

仓库根目录也可跑一键门禁：`node scripts/verify-all.mjs`。

## 模板默认页面

| 路径 | 说明 |
|------|------|
| `/` | 城市目录首页 |
| `/city/sample-city` | 城市下的区/县 |
| `/city/sample-city/sample-district` | 区县下的场地与机台（含活跃人数） |
| `/login` | 二维码登录 |
| `/register` | 注册/首次资料 |
| `/bind` | 刷新已登录用户的公开资料 |
| `/queue/sample-venue/machine-a` 等 | 示例机台队列板 |
| `/me` | 当前用户的活动记录 |
| `/admin` | 管理员运维台 |

城市、区县、场地、机台和默认开放时间定义在 `src/lib/constants/catalog.ts`。复制模板后应先替换这些示例值；详细步骤见 [模板定制文档](../../docs/TEMPLATE.md)。

## 源码结构（`src/`）

| 路径 | 职责 |
|------|------|
| `app/` | App Router 页面与 `api/*` 路由 |
| `components/` | 队列板、登录/绑定表单、管理台等 UI |
| `lib/constants/catalog.ts` | 城市 → 区县 → 场地 → 机台静态目录 |
| `lib/queue/` | 队列领域（见下表）；`service.ts` 为稳定 re-export |
| `lib/settings/` | 超时、场地元数据、机台硬币的运行时读写 |
| `lib/time/hours.ts` | 开放时间解析与营业判断 |
| `lib/db/` | SQLite schema 与连接 |
| `lib/auth/` | 用户会话与管理员会话 |
| `lib/gateway/` | 对签名 Gateway 的客户端 |
| `lib/env.ts` | 环境变量校验与默认值 |

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

规则摘要：队头在空闲机台上需在 `HEAD_CONFIRM_TIMEOUT_SEC`（默认 180s）内确认；第 1 次超时后移 1 组，第 2 次卸卡。游玩超时 `PLAYING_TIMEOUT_SEC`（默认 1500s）回队尾。完整流程见 [架构说明](../../docs/ARCHITECTURE.md)。

## 管理员能力（`/admin`）

使用 `ADMIN_API_TOKEN` 登录后可：

- 设置机台队列状态：`OPEN` / `PAUSED` / `CLOSED`；
- 对活跃条目代操作：开始、重排、取消、结束等；
- 调整游玩超时与队头确认超时（写入 `app_settings`，覆盖 env 默认）；
- 编辑场地地址、区县展示、开放时间；
- 编辑机台单次游玩硬币数；
- 查看审计事件。

相关 API 前缀：`/api/admin/session`、`/settings`、`/venues`、`/machines`、`/queues`、`/entries`、`/audit`。

## 主要用户 API

- `POST /api/queues/{venueSlug}/{machineSlug}/join`
- `GET  /api/queues/{venueSlug}/{machineSlug}/public`
- `POST /api/entries/{entryId}/confirm` — 队头确认上机
- `POST /api/entries/{entryId}/cancel`
- `POST /api/entries/{entryId}/finish`
- 认证与资料：`/api/auth/*`、`/api/bind`、`/api/me`
- 健康检查：`/api/healthz`

写接口均做同源校验；响应默认 `Cache-Control: no-store`。

## 环境变量

`.env.example` 说明了全部本地配置。生产环境至少需要：

- 独立且随机的 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN`；每项长度至少 32 字符；
- `APP_BASE_URL`（推荐 HTTPS；受控内网/测试可用 HTTP）；
- 已实现并审计的远程身份 Gateway，且 `GATEWAY_MODE=remote`（Web 拒绝 in-process mock）；
- `PLAYING_TIMEOUT_SEC` / `HEAD_CONFIRM_TIMEOUT_SEC`（管理员仍可在运行时覆盖）；
- 已清洗转发头的反向代理，以及 `TRUST_PROXY_HEADERS=true`；
- 受限权限的数据目录、加密备份和明确的数据保留期限。

不要把生产值写入任何 `.env.example`、测试夹具、README、浏览器代码或日志。生产检查可执行：

```bash
npm run preflight -- --production
```

## 安全边界

- 会话 Cookie 为 `HttpOnly`，生产环境启用 `Secure` 与 `SameSite=Strict`；
- 所有写接口执行同源检查；
- API 默认 `Cache-Control: no-store`；
- 原始二维码不写入 Web 数据库；
- 维护任务会按配置清理临时验证数据、历史队列记录和不活动的公开资料快照；
- 运行时设置（超时、场地元数据、硬币）与队列同库，备份与权限要求相同。

发布前请同时阅读 [安全与发布清单](../../docs/SECURITY.md)、[架构说明](../../docs/ARCHITECTURE.md) 和 [部署说明](../../infra/server/README.md)。
