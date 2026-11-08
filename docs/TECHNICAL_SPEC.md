# VirtualWait 技术规格与上线验收

本文是 VirtualWait 当前实现的技术规格。它定义系统边界、业务规则、接口和运行要求；
实现细节以代码和测试为准。

## 1. 结论与适用范围

VirtualWait 可以作为 **单城市或少量场地、单实例部署** 的虚拟排队系统上线，前提是完成第 12 节的上线验收。
它适用于现场机台排队、用户自行确认上机、管理员兜底操作以及可选的 QQ 群通知。

当前版本不适合直接作为多区域高可用平台：Web 使用本地 SQLite，数据库文件必须由同一台主机上的
单个 Web 实例独占写入。需要多实例、跨机房或高可用时，必须先将持久层迁移到具备事务、锁和备份方案的
服务型数据库，并重新进行并发与故障转移测试。

身份完全由本部署自己承担：玩家用**本地账号**（用户名 + 口令）登录，注册时用**场地签到码**证明本人在现场。
系统不与任何外部身份服务、游戏服务器或第三方平台通信。

## 2. 系统目标与非目标

| 类别 | 内容 |
|---|---|
| 核心目标 | 让用户查看机台状态、加入单人或双人队列、在队头确认上机，并由管理员处理异常情况。 |
| 身份目标 | 每个玩家一个本地账号；口令只以 scrypt 加盐哈希存储；注册需现场签到码；会话可服务端吊销。 |
| 运维目标 | 提供健康检查、审计事件、保留清理、备份验证和 systemd/Nginx 样例。 |
| 通知目标 | 机台空闲时，由独立 Bot API 向已绑定 QQ 的队首发送群内提醒。 |
| 非目标 | 支付、储值、机台物联网控制、Web 内即时通讯、跨城市多租户隔离、分布式高可用、任何游戏账号操作。 |

## 3. 组件与信任边界

```text
浏览器
  | HTTPS
  v
Nginx / 受控反向代理
  | 127.0.0.1:3000
  v
Next.js Web + 本地 SQLite  <---- Bearer (可选 Bot 专用令牌) ----  QQ 机器人（services/bot）
                                                                          ^
                                                                          | OneBot v11 WS
                                                                        NapCat
```

| 组件 | 职责 | 不应承担的职责 |
|---|---|---|
| Web | 页面、账号与会话、签到码、队列状态机、管理员 API、SQLite、Bot API | 调用任何外部身份服务或游戏接口。 |
| Nginx | TLS、代理、可信客户端 IP 头重写 | 暴露内部端点或健康检查到公网。 |
| QQ 机器人（services/bot） | 轮询受保护 Bot API、去重、冷却、发送群消息 | 使用公开队列接口获取 QQ；读写 Web 数据库。 |

Web、管理员和 Bot 使用不同的密钥或会话。管理员令牌不能复用为 Bot 令牌，Bot 令牌不能进入浏览器代码。

## 4. 功能规格

### 4.1 目录与公开查看

静态目录按 `城市 -> 区/县 -> 场地 -> 机台` 配置，来源为 `apps/web/src/lib/constants/catalog.ts`。
场地地址、营业时间、群 UMO 和机台硬币数可由管理员写入 SQLite 覆盖默认值。

公开队列仅返回展示所需的昵称、等待位置和状态；不得返回 QQ、用户名、会话、IP、口令相关字段或管理配置。

### 4.2 账号与签到码

| 步骤 | 规则 |
|---|---|
| 注册 | 需 `REGISTRATION_ENABLED=true`；用户名 3–20 位 `[A-Za-z0-9_-]` 且大小写不敏感唯一；口令 8–128 位；昵称 2–20 个可见字符且大小写不敏感唯一 |
| 签到码 | `CHECKIN_REQUIRED=true` 时必须提供某场地当前有效（或处于宽限窗口内）的 6 位码；校验失败 `CHECKIN_INVALID`，缺失 `CHECKIN_REQUIRED`，场地不存在 `CHECKIN_VENUE_UNKNOWN` |
| 配额 | 每 IP 每日最多注册 `IP_ACCOUNT_QUOTA_PER_DAY` 个账号；超限 `IP_ACCOUNT_BOUND` 并回滚新建账号 |
| 登录 | 用户名 + 口令；失败统一 `INVALID_CREDENTIALS`（401），不区分「用户不存在」与「口令错误」 |
| 登录限流 | 账号维度统计**所有**尝试（防定向爆破）；客户端 IP 维度只统计**失败**尝试，避免 NAT 共享出口误伤整场玩家 |
| 限流 | 注册按 IP + 全局；登录按 IP + 账号名；超限 `RATE_LIMITED`（429） |
| 会话 | `vw_session` 签名 Cookie + `session` 表行；登出吊销服务端行；命中校验 IP 哈希连续性 |
| 资料 | `/me` 可改昵称与 QQ 号；QQ 5–12 位数字且唯一，`QQ_TAKEN` 冲突 |

同一用户在任一队列中只能有一条 `WAITING` 或 `PLAYING` 记录。数据库的部分唯一索引是该不变量的最终保护。

### 4.3 队列与状态机

`queue_entry.status`：`WAITING`、`PLAYING`、`DONE`、`CANCELLED`、`EXPIRED`。

`queue_party.status`：`SEEKING`、`PENDING`、`CONFIRMED`、`DISBANDED`。

| 触发 | 前置条件 | 结果 |
|---|---|---|
| 加入 | 已登录、满足 QQ 要求（`REQUIRE_QQ_FOR_QUEUE`）、队列 `OPEN`、营业中、无活跃条目 | 新建 `WAITING` 记录；双人发起方为 `SEEKING`。 |
| 取消 / 超时竞争 | 同一记录被 web 进程取消、同时被维护进程判定队头超时 | 事务与状态守卫保证只有一方生效；已取消的条目**不会**被重排复活。 |
| 加入拼机 | 目标为同一队列 `SEEKING` 队伍且未满 | 双方变为 `PENDING`。 |
| 双方确认 | 两名成员分别确认 | 队伍变为 `CONFIRMED`。 |
| 确认上机 | 机台无 `PLAYING`、请求者为等待队头；双人已确认 | 整组变为 `PLAYING`。 |
| 结束 | 条目为 `PLAYING` | 整组回到 `WAITING` 队尾（继续排队，可取消离开）。 |
| 用户取消 | 自己的条目为 `WAITING` | 条目 `CANCELLED`；双人队按成员关系拆分或解散。 |
| 游玩超时 | `playing_at` 超过 `PLAYING_TIMEOUT_SEC` | 整组回到等待队尾。 |
| 队头确认超时 | 空闲机台，队首未在 `HEAD_CONFIRM_TIMEOUT_SEC`（默认 180 秒）内确认上机 | 整组自动**排到队尾**，下一位队首重新计时，不卸卡。 |

默认 `PLAYING_TIMEOUT_SEC=1500`、`HEAD_CONFIRM_TIMEOUT_SEC=180`。管理员可写入 `app_settings` 覆盖环境默认值。
超时处理由用户动作、管理员动作和维护过程共同触发；不能仅依赖单一 cron。

### 4.4 管理员能力

管理员通过 `ADMIN_API_TOKEN` 建立 HttpOnly 管理会话，可修改：

- 队列开关：`OPEN`、`PAUSED`、`CLOSED`；
- 活跃条目：开始、重排、取消、结束；
- 运行时超时、场地地址/区县/营业时间/群 UMO、机台硬币数；
- 场地签到码：查看当前码、剩余时间与一键轮换；
- 审计事件列表。

管理员动作采用 `version` 乐观并发控制。版本不一致时必须返回 `ENTRY_VERSION_CONFLICT`，客户端刷新后重试，不能盲写。

### 4.5 Bot 通知

启用条件为设置非空的 `BOT_API_TOKEN`。API 使用独立 Bearer 鉴权：

| 接口 | 数据 | 默认限流 |
|---|---|---|
| `GET /api/bot/catalog` | 全市机台热集摘要 | 20 次/分钟 |
| `GET /api/bot/queues/{venueSlug}/{machineSlug}` | 单机台详情、队首显示名和 QQ | 240 次/分钟 |

插件只对 `machineIdle && head != null` 的机台尝试通知。群路由优先级为后端 `groupUmo`、场地映射、区县映射、默认 UMO。
通知按 `machineSlug + 已排序 QQ 集合` 去重，默认冷却 300 秒；启动前两轮只预热缓存，不发消息。
公开 `/public` 接口禁止输出 QQ。

## 5. 数据规格与保留策略

| 表 | 主要数据 | 数据等级 |
|---|---|---|
| `venue`、`queue`、`app_settings` | 场地、机台、运行时配置、签到码密钥 | 内部运营数据 |
| `app_user` | 用户名、昵称、口令哈希与盐、可选 QQ、签到场地 | 个人数据 + 凭据 |
| `queue_party`、`queue_entry` | 排队关系、状态、时间、版本 | 运营与个人数据 |
| `audit_event` | 管理/用户/系统动作、资源、时间、元数据 | 安全审计数据 |
| `session` | 会话行与吊销状态 | 安全数据 |
| `ip_day_binding`、`rate_limit_bucket` | 防滥用派生数据 | 安全数据 |

默认维护策略由 `npm run maintenance` 执行：限流桶 1 小时、IP 日绑定 2 天、登录元数据 180 天、
终态队列与拼机 180 天、审计 365 天、会话行按 `SESSION_MAX_AGE_DAYS`（默认 30 天）。
实际保留期由环境变量控制，应按所在地隐私法规、场地运营需求和最小化原则调整。

SQLite 数据目录、WAL/SHM、备份与导出均属于受保护数据。数据库访问、备份访问和环境文件应使用独立非 root
账户与最小权限；不得提交仓库。

## 6. 安全规格

### 6.1 Web

- 写操作要求同源 `Origin`；生产环境缺失 Origin 即拒绝。
- 会话 Cookie 为 `HttpOnly`；生产环境启用 `Secure` 与 `SameSite=Strict`。
- 所有 JSON API 响应使用 `Cache-Control: no-store`。
- 请求 JSON 默认上限为 4 KiB；输入使用 Zod 校验。
- 注册、登录与 Bot API 均有固定窗口限流；超限返回 `429` 和可选 `retryAfterSec`。
- 生产环境要求随机且互不复用的 `SESSION_SECRET`、`ADMIN_API_TOKEN`，每项至少 32 字符。
- 未定义的内部异常统一折叠为 `INTERNAL_ERROR`（500）并只在服务端记录原文，绝不把
  SQLite 文本或文件路径当 `error.code` 返回。
- 带 `Authorization: Bearer` 的管理请求跳过同源校验（浏览器无法在不触发 CORS 预检的情况下
  设置该头），因此运维脚本可用；Cookie 会话仍要求同源。
- 生产 CSP 严格；开发模式仅为支持 HMR 放行 `unsafe-eval`（见 `next.config.ts`）。

### 6.2 口令与签到码

- 口令：scrypt（N=16384, r=8, p=1）+ 每用户随机盐，常量时间比较，账号不存在时执行等价计算。
- 签到码：`HMAC-SHA256(checkin_secret, "vw-checkin:<window>")` 取 6 位；默认 600 秒轮换并接受 1 个宽限窗口；
  密钥仅存于 SQLite，轮换立即失效。
- 口令、Cookie、签到码与 QQ 号不得进入日志。

### 6.3 网络与密钥

- 生产 Web 推荐 HTTPS；HTTP 仅限可信内网或测试。
- 只有代理先删除用户伪造的转发头、再写入可信客户端 IP 时，才可设置 `TRUST_PROXY_HEADERS=true`。
- 密钥通过 secret manager 或权限为 `0600` 的仓库外环境文件注入；泄露后立即轮换并使相关会话失效。
- Bot API 含 QQ，网络边界应视为管理面；不得经过公开 CDN 缓存或不受控日志系统。

## 7. 接口约定

所有错误响应使用以下形状：

```json
{"error":{"code":"MACHINE_READABLE_CODE","message":"面向用户的说明"}}
```

关键错误包括：`NOT_AUTHENTICATED`、`REGISTRATION_DISABLED`、`USERNAME_TAKEN`、`NICKNAME_TAKEN`、
`INVALID_USERNAME`、`INVALID_PASSWORD`、`INVALID_CREDENTIALS`、`CHECKIN_REQUIRED`、`CHECKIN_INVALID`、
`CHECKIN_VENUE_UNKNOWN`、`IP_ACCOUNT_BOUND`、`RATE_LIMITED`、`QQ_REQUIRED`、`QQ_TAKEN`、
`ALREADY_IN_ANOTHER_QUEUE`、`NOT_HEAD_OF_QUEUE`、`MACHINE_BUSY`、`ENTRY_VERSION_CONFLICT`、`BOT_UNAUTHORIZED`。

成功响应为 JSON 对象；路由参数和请求体均需通过服务端校验。

破坏性变更必须同步更新实现、测试与文档。

## 8. 部署规格

| 项 | 必须满足的条件 |
|---|---|
| 运行时 | Node.js 22.5+（Web 使用 `node:sqlite`）；Python 3.10+ 仅机器人需要。 |
| Web | 单一实例，`npm run start` 默认绑定 `127.0.0.1:3000`（`HOST`/`PORT` 可覆盖）；数据目录置于仓库外。 |
| SQLite | `DB_BUSY_TIMEOUT_MS`（默认 5000）>0：web 与维护进程是两个写入者，写冲突应等待而不是立刻失败。 |
| 反向代理 | TLS、Host/Origin 一致、重写转发 IP 头、隐藏 `/api/healthz`。 |
| 数据 | 定期 SQLite 备份、恢复演练、备份校验、加密与访问控制。 |
| 定时任务 | 维护、备份和健康检查 timer 按 `infra/server/systemd` 安装并告警。 |
| 机器人（可选） | Docker（推荐）或本机 venv；`BOT_API_TOKEN` 两端一致。 |

部署前应先替换示例城市、场地、机台、文案与所有 `CHANGE_ME_*` 占位符。
不得把 `.env.local`、数据库、口令、管理员令牌或真实个人资料带入 Git 历史。

## 9. 观测、备份与故障处理

最小监测对象：Web `/api/healthz`、systemd 服务状态、SQLite 磁盘空间、备份最近成功时间、
维护任务最近成功时间、Bot `429`/发送失败计数。

| 事件 | 处置 |
|---|---|
| Web 健康检查失败 | 停止接收流量，检查磁盘、数据库锁、环境变量与服务日志；恢复后执行只读队列核查。 |
| SQLite 损坏或磁盘满 | 停止写入，保全现状，使用已验证备份恢复到隔离路径并执行 `db:verify` 后切换。 |
| 密钥泄露 | 轮换相应密钥：`SESSION_SECRET` 使全部会话失效；`BOT_API_TOKEN` 需两端同步更新。 |
| 签到码外泄 | 在管理台立即轮换；轮换后旧码失效，不影响已登录用户。 |
| 账号滥用（批量注册） | 调低 `IP_ACCOUNT_QUOTA_PER_DAY` / `REGISTER_*`；必要时关闭 `REGISTRATION_ENABLED` 改为现场开户。 |
| Bot 通知异常 | 暂停插件或撤销 `BOT_API_TOKEN`，不开放 QQ 到公开接口；检查群 UMO、冷却和限流。 |

## 10. 测试与质量门禁

| 门禁 | 证明内容 |
|---|---|
| `npm run lint` | Web 代码静态规则。 |
| `npm run account:create` | 关闭自助注册后的现场开户路径（校验规则与注册一致）。 |
| `npx tsc --noEmit` | Web 类型边界。 |
| `npm test` | 口令、账号、签到码、限流（含混合窗口不误删）、IP 配额、旧库迁移、备份无副作用、队列超时与取消/超时竞争、数据保留、Bot 领域规则。 |
| `npm run test:e2e` | 同源防护、注册（含错误签到码）、重复用户名、口令登录与失败、绑定 QQ、入队、管理员操作、审计、登出吊销。 |
| `npm run test:browser` | 桌面和移动端注册/登录界面、管理台签到码面板与移动端无横向溢出。 |
| `npm run build` | 生产构建和路由加载。 |
| `PYTHONPATH=. python3 -m pytest -q tests`（`services/bot`） | 机器人通知逻辑。 |
| `node scripts/verify-all.mjs` | 上述门禁与部署样例的一键组合。 |

浏览器门禁需要安装 Playwright Chromium，或设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向受支持的 Chromium 二进制。
生产预检使用临时随机值验证变量形状，不应把临时值写入部署文件。

## 11. 已知架构限制与演进条件

1. SQLite 适合单机单实例，不能以增加 Next.js 副本的方式横向扩容。
2. 超时是惰性处理加维护任务的组合，严格分钟级 SLA 需补充专用可靠任务调度和告警。
3. Bot 轮询为最终一致通知，不能替代用户队头确认或管理员判断。
4. 签到码是「在场证明」而非强身份：同一场地内的人可以互相告知，这是设计取舍；
   若需要更强证明，应引入现场工作人员核验或实名登记流程，而不是复用账号口令。
5. QQ 是直接个人标识；启用通知前必须完成隐私告知、访问控制和保留期限确认。
6. 旧版本数据库中的扫码账号无法迁移（没有本地口令），升级时必须公告玩家重新注册。

## 12. 上线验收清单

- [ ] 已替换模板目录、文案和所有占位符，且 Git 历史未含真实密钥或个人数据。
- [ ] `SESSION_SECRET`、`ADMIN_API_TOKEN` 为每环境独立的强随机值；`BOT_API_TOKEN` 与机器人端一致。
- [ ] Nginx 已启用 TLS，`/api/healthz` 未暴露，可信代理头已验证，`TRUST_PROXY_HEADERS=true`。
- [ ] Web 为单实例；SQLite、WAL、备份均在受限仓库外路径；恢复演练已完成。
- [ ] 管理台可读取并轮换签到码；现场张贴流程与轮换纪律已确定。
- [ ] `IP_ACCOUNT_QUOTA_PER_DAY` 与注册/登录限流已按场地客流调整。
- [ ] 若从旧版本升级：已公告玩家重新注册，并确认迁移后队列/会话为空是预期行为。
- [ ] 管理员令牌、Bot 令牌分离且不进入浏览器；启用 Bot 前已确认 QQ 隐私处理与群路由。
- [ ] 维护、备份、健康检查 systemd timer 已运行并接入告警。
- [ ] 本文第 10 节门禁全部通过。

只有全部勾选后，才可将系统视为满足当前版本的生产上线最低条件。
