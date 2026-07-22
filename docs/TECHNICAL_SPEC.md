# VirtualWait 技术规格与上线验收

本文是 VirtualWait 当前实现的技术规格。它定义系统边界、业务规则、接口和运行要求；实现细节以代码和 JSON Schema 为准。本文不授予任何第三方身份服务、二维码或平台接口的使用权限。

## 1. 结论与适用范围

VirtualWait 可以作为 **单城市或少量场地、单实例部署** 的虚拟排队系统上线，前提是完成第 12 节的上线验收。它适用于现场机台排队、用户自行确认上机、管理员兜底操作以及可选的 QQ 群通知。

当前版本不适合直接作为多区域高可用平台：Web 使用本地 SQLite，数据库文件必须由同一台主机上的单个 Web 实例独占写入。需要多实例、跨机房或高可用时，必须先将持久层迁移到具备事务、锁和备份方案的服务型数据库，并重新进行并发与故障转移测试。

真实二维码验证仅可接入已获授权的服务。默认 mock provider 仅用于开发和测试，不能视为生产身份认证。

## 2. 系统目标与非目标

| 类别 | 内容 |
|---|---|
| 核心目标 | 让用户查看机台状态、加入单人或双人队列、在队头确认上机，并由管理员处理异常情况。 |
| 身份目标 | Web 只接收匿名 subject 和最小公开资料，不持久化原始二维码、上游 token 或完整上游响应。 |
| 运维目标 | 提供健康检查、审计事件、保留清理、备份验证和 systemd/Nginx 样例。 |
| 通知目标 | 机台空闲时，由独立 Bot API 向已绑定 QQ 的队首发送群内提醒。 |
| 非目标 | 支付、储值、机台物联网控制、Web 内即时通讯、跨城市多租户隔离、分布式高可用。 |

## 3. 组件与信任边界

```text
浏览器
  | HTTPS
  v
Nginx / 受控反向代理
  | 127.0.0.1:3000
  v
Next.js Web + SQLite ---- HMAC ----> Gateway (127.0.0.1:8787)
  |                                      |
  | Bearer (可选 Bot 专用密钥)            | 已授权的身份 provider
  v                                      v
AstrBot 插件                           mock | http | sdgb_preview
```

| 组件 | 职责 | 不应承担的职责 |
|---|---|---|
| Web | 页面、会话、队列状态机、管理员 API、SQLite、Bot API | 直接调用未经授权的上游身份接口。 |
| Gateway | 验证 Web HMAC、nonce 与时间戳；调用 provider；返回最小身份结果 | 对公网开放、记录二维码或 token。 |
| Nginx | TLS、代理、可信客户端 IP 头重写 | 将 Gateway 暴露给互联网。 |
| AstrBot 插件 | 轮询受保护 Bot API、去重、冷却、发送群消息 | 使用公开队列接口获取 QQ。 |

Web、Gateway、管理员和 Bot 均使用不同的密钥或会话。管理员令牌不能复用为 Bot 令牌，Bot 令牌不能进入浏览器代码。

## 4. 功能规格

### 4.1 目录与公开查看

静态目录按 `城市 -> 区/县 -> 场地 -> 机台` 配置，来源为 `apps/web/src/lib/constants/catalog.ts`。场地地址、营业时间和机台硬币数可由管理员写入 SQLite 覆盖默认值。

公开队列仅返回展示所需的昵称、脱敏资料、等待位置和状态；不得返回 QQ、会话、身份 hash、IP、二维码、令牌或管理配置。公开读路径会处理已到期的队列状态，因此页面刷新可以推进超时状态。

### 4.2 用户与队列

1. 用户通过 Gateway 验证二维码并取得 Web 会话。
2. 用户在个人页绑定唯一 QQ 号；格式为 5 到 12 位数字。当前规则下，**未绑定 QQ 不得加入队列**，以保证空闲提醒可送达。
3. 用户加入开放且处于营业时间内的单人队列，或创建/加入双人队伍。
4. 双人队伍须双方确认，才允许作为完整组上机。
5. 空闲机台的队首可确认上机；管理员可在管理台代操作。
6. 用户或管理员结束游玩；取消和超时均写入审计。

同一用户在任一队列中只能有一条 `WAITING` 或 `PLAYING` 记录。数据库的部分唯一索引是该不变量的最终保护。

### 4.3 状态机与时限

`queue_entry.status`：`WAITING`、`PLAYING`、`DONE`、`CANCELLED`、`EXPIRED`。

`queue_party.status`：`SEEKING`、`PENDING`、`CONFIRMED`、`DISBANDED`。

| 触发 | 前置条件 | 结果 |
|---|---|---|
| 加入 | 已登录、已绑定 QQ、队列 `OPEN`、营业中、无活跃条目 | 新建 `WAITING` 记录；双人发起方为 `SEEKING`。 |
| 加入拼机 | 目标为同一队列 `SEEKING` 队伍且未满 | 双方变为 `PENDING`。 |
| 双方确认 | 两名成员分别确认 | 队伍变为 `CONFIRMED`。 |
| 确认上机 | 机台无 `PLAYING`、请求者为等待队首；双人已确认 | 整组变为 `PLAYING`。 |
| 结束 | 条目为 `PLAYING` | 整组/条目变为 `DONE`。 |
| 用户取消 | 自己的条目为 `WAITING` | 条目 `CANCELLED`；双人队按成员关系拆分或解散。 |
| 游玩超时 | `playing_at` 超过 `PLAYING_TIMEOUT_SEC` | 整组回到等待队尾。 |
| 队头首次超时 | 空闲机台，队首未在 `HEAD_CONFIRM_TIMEOUT_SEC` 内确认 | 整组后移一组，计一次 miss。 |
| 队头第二次超时 | 同一组已有一次 miss 且再次超时 | 整组自动取消（卸卡）。 |

默认 `PLAYING_TIMEOUT_SEC=1500`、`HEAD_CONFIRM_TIMEOUT_SEC=180`。管理员可写入 `app_settings` 覆盖环境默认值。超时处理会由公开读、用户动作、管理员动作和维护过程共同触发；不能仅依赖单一 cron。

### 4.4 管理员能力

管理员通过 `ADMIN_API_TOKEN` 建立 HttpOnly 管理会话，可修改：

- 队列开关：`OPEN`、`PAUSED`、`CLOSED`；
- 活跃条目：开始、重排、取消、结束；
- 运行时超时、场地地址/区县/营业时间/群 UMO、机台硬币数；
- 审计事件列表。

管理员动作采用 `version` 乐观并发控制。版本不一致时必须返回 `ENTRY_VERSION_CONFLICT`，客户端刷新后重试，不能盲写。

### 4.5 Bot 通知

启用条件为设置非空的 `BOT_API_TOKEN`。API 使用独立 Bearer 鉴权：

| 接口 | 数据 | 默认限流 |
|---|---|---|
| `GET /api/bot/catalog` | 全市机台热集摘要 | 20 次/分钟 |
| `GET /api/bot/queues/{venueSlug}/{machineSlug}` | 单机台详情、队首显示名和 QQ | 120 次/分钟 |

插件只对 `machineIdle && head != null` 的机台尝试通知。群路由优先级为后端 `groupUmo`、场地映射、区县映射、默认 UMO。通知按 `machineSlug + 已排序 QQ 集合` 做冷却，默认 300 秒；启动前两轮只预热缓存，不发消息。公开 `/public` 接口禁止输出 QQ。

## 5. 数据规格与保留策略

| 表 | 主要数据 | 数据等级 |
|---|---|---|
| `venue`、`queue`、`app_settings` | 场地、机台、运行时配置 | 内部运营数据 |
| `app_user` | 昵称、最小公开资料、匿名身份 hash、可选 QQ | 个人数据 |
| `queue_party`、`queue_entry` | 排队关系、状态、时间、版本 | 运营与个人数据 |
| `audit_event` | 管理/用户/系统动作、资源、时间、元数据 | 安全审计数据 |
| `join_attempt` | 验证任务状态与过期信息 | 临时身份流程数据 |
| `ip_day_binding`、`rate_limit_bucket`、`qr_concurrency_slot` | 防滥用派生数据 | 安全数据 |

默认维护策略由 `npm run maintenance` 执行：临时验证数据 1 天、IP 日绑定 2 天、不活跃资料 180 天、终态队列 180 天、审计 365 天。实际保留期由环境变量控制，应按所在地隐私法规、场地运营需求和最小化原则调整。

SQLite 数据目录、WAL/SHM、备份与导出均属于受保护数据。数据库访问、备份访问和环境文件应使用独立非 root 账户与最小权限；不得提交仓库。

## 6. 安全规格

### 6.1 Web

- 写操作要求同源 `Origin`；生产环境缺失 Origin 即拒绝。
- 会话 Cookie 为 `HttpOnly`；生产环境启用 `Secure` 与 `SameSite=Strict`。
- 所有 JSON API 响应使用 `Cache-Control: no-store`。
- 请求 JSON 默认上限为 4 KiB；输入使用 Zod 校验。
- 登录、轮询和 Bot API 均有固定窗口限流；超限返回 `429` 和可选 `retryAfterSec`。
- 生产环境要求随机且互不复用的 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN`，每项至少 32 字符。

### 6.2 Gateway

- 每个请求必须携带 key id、时间戳、nonce、body SHA-256 和 HMAC 签名。
- timestamp 必须位于时钟偏差窗口内；nonce 用哈希持久化并原子拒绝重放。
- Gateway 限制请求体、并发和每分钟调用量；作业状态存放 SQLite。
- 标准 HTTP 日志被禁用，避免路径或正文意外泄露。生产观测必须另行实现脱敏日志。

### 6.3 网络与密钥

- 生产 Web 推荐 HTTPS；HTTP 仅限可信内网或测试。
- Gateway 必须绑定回环或私有受控网络，不得直接对互联网监听。
- 只有代理先删除用户伪造的转发头、再写入可信客户端 IP 时，才可设置 `TRUST_PROXY_HEADERS=true`。
- 密钥通过 secret manager 或权限为 `0600` 的仓库外环境文件注入；泄露后立即轮换并使相关会话失效。
- Bot API 含 QQ，网络边界应视为管理面；不得经过公开 CDN 缓存或不受控日志系统。

## 7. 接口约定

所有错误响应使用以下形状：

```json
{"error":{"code":"MACHINE_READABLE_CODE","message":"面向用户的说明"}}
```

关键错误包括：`NOT_AUTHENTICATED`、`QQ_REQUIRED`、`ALREADY_IN_ANOTHER_QUEUE`、`NOT_HEAD_OF_QUEUE`、`MACHINE_BUSY`、`ENTRY_VERSION_CONFLICT`、`RATE_LIMITED`、`BOT_UNAUTHORIZED`。成功响应为 JSON 对象；路由参数和请求体均需通过服务端校验。

Web 与 Gateway 契约以 `packages/contracts/schemas/*.v1.schema.json` 为准。破坏性变更必须新建版本或同时提供兼容层，且同步更新 Zod、Python、fixture、单元测试和文档。

## 8. 部署规格

| 项 | 必须满足的条件 |
|---|---|
| 运行时 | Node.js 22.5+、Python 3.11+；生产使用锁定依赖安装。 |
| Web | 单一实例，绑定 `127.0.0.1:3000` 或等价受控网络；数据目录置于仓库外。 |
| Gateway | 单一受控实例，默认 `127.0.0.1:8787`；与 Web 共享 HMAC 参数。 |
| 反向代理 | TLS、Host/Origin 一致、重写转发 IP 头、禁止将 Gateway 代理到公网。 |
| 数据 | 定期 SQLite 备份、恢复演练、备份校验、加密与访问控制。 |
| 定时任务 | 维护、备份和健康检查 timer 按 `infra/server/systemd` 安装并告警。 |

部署前应先替换示例城市、场地、机台、文案、所有 `CHANGE_ME_*` 占位符与 mock 配置。不得把 `.env.local`、数据库、二维码、token、私钥或真实个人资料带入 Git 历史。

## 9. 观测、备份与故障处理

最小监测对象：Web `/api/healthz`、Gateway `/healthz`、systemd 服务状态、SQLite 磁盘空间、备份最近成功时间、维护任务最近成功时间、Bot `429`/发送失败计数。

| 事件 | 处置 |
|---|---|
| Web 健康检查失败 | 停止接收流量，检查磁盘、数据库锁、环境变量与服务日志；恢复后执行只读队列核查。 |
| Gateway 失败 | Web 登录会返回网关错误；不要降级为绕过签名或前端直连上游。检查两端密钥、时间、nonce 库和 provider 授权。 |
| SQLite 损坏或磁盘满 | 停止写入，保全现状，使用已验证备份恢复到隔离路径并执行 `db:verify` 后切换。 |
| 密钥泄露 | 轮换相应密钥；轮换 `SESSION_SECRET` 会使会话失效；审查访问日志与 Git 历史。 |
| Bot 通知异常 | 暂停插件或撤销 `BOT_API_TOKEN`，不开放 QQ 到公开接口；检查群 UMO、冷却和限流。 |

## 10. 测试与质量门禁

| 门禁 | 证明内容 |
|---|---|
| `npm run lint` | Web 代码静态规则。 |
| `npx tsc --noEmit` | Web 类型边界。 |
| `npm test` | 认证、契约、超时、数据保留、QQ/Bot 领域规则。 |
| `npm run test:e2e` | Gateway mock、同源防护、登录、绑定 QQ、入队、管理员操作与健康检查。 |
| `npm run test:browser` | 桌面和移动端关键界面、扫码登录与移动端无横向溢出。 |
| `npm run build` | 生产构建和路由加载。 |
| `PYTHONPATH=src python3 -m pytest -q` | Gateway HMAC、provider、配置和 HTTP 安全。 |
| `node scripts/verify-all.mjs` | Web/Gateway/部署样例的一键组合门禁。 |

浏览器门禁需要安装 Playwright Chromium，或设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向受支持的 Chromium 二进制。生产预检使用临时随机值验证变量形状，不应把临时值写入部署文件。

## 11. 已知架构限制与演进条件

1. SQLite 适合单机单实例，不能以增加 Next.js 副本的方式横向扩容。
2. 超时是惰性处理加维护任务的组合，严格分钟级 SLA 需补充专用可靠任务调度和告警。
3. Bot 轮询为最终一致通知，不能替代用户队头确认或管理员判断。
4. `sdgb_preview` 与任何真实 provider 的可用性、合法性和字段稳定性由上游及运营方决定，必须有授权与故障预案。
5. QQ 是直接个人标识；启用通知前必须完成隐私告知、访问控制和保留期限确认。

## 12. 上线验收清单

- [ ] 已替换模板目录、文案和所有占位符，且 Git 历史未含真实密钥或个人数据。
- [ ] 已完成真实身份 provider 授权、最小数据评审、限流/超时/失败恢复测试。
- [ ] Web 和 Gateway 的 key id、共享密钥、匿名身份 HMAC 密钥完全一致；环境间均不复用。
- [ ] Nginx 已启用 TLS，Gateway 不可从公网访问，可信代理头已验证。
- [ ] Web 为单实例；SQLite、WAL、备份均在受限仓库外路径；恢复演练已完成。
- [ ] 管理员令牌、Bot 令牌分离且不进入浏览器；启用 Bot 前已确认 QQ 隐私处理与群路由。
- [ ] 维护、备份、健康检查 systemd timer 已运行并接入告警。
- [ ] 本文第 10 节门禁全部通过，且 `npm audit --omit=dev --package-lock-only --audit-level=high` 无高危项。

只有全部勾选后，才可将系统视为满足当前版本的生产上线最低条件。
