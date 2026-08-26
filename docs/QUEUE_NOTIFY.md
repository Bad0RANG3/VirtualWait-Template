# 队列监听与自动通知

本文描述 VirtualWait Web 与 QQ 机器人插件（`services/bot`，NoneBot2）之间的**机台空闲 → 群内 @ 队首**联动：数据模型、Bot API、插件行为、限流与联调计划。实现以代码为准。

## 1. 目标与边界

| 项 | 说明 |
|----|------|
| 目标 | 机台无 `PLAYING` 且存在等待队首时，向配置/下发的群 UMO 发送 @ 消息 |
| 非目标 | 不在公开 `/public` 接口暴露 QQ；不做 Web 内嵌 IM；不替代队头确认超时逻辑 |
| 身份 | 玩家在 `/me` 绑定 QQ（**排队必填**）；Bot 侧若仍遇无 QQ 队首则跳过通知并计入统计 |
| 路由 | 优先使用场地 `groupUmo`（后台配置），配置文件作兜底 |

## 2. 数据映射（逆向结论 + 扩展）

### 2.1 既有公开队列（浏览器）

| 项 | 值 |
|----|-----|
| 接口 | `GET /api/queues/{venueSlug}/{machineSlug}/public` |
| 机台编号/名 | `queue.slug` / `queue.name` |
| 队首 | `slots` 中 `status=="WAITING" && position==1` |
| 机台空闲 | 不存在 `status=="PLAYING"` 的 slot |
| 玩家展示 | `entries[].profile.displayName` / nickname；**无 QQ** |

插件**不要**轮询该公开接口获取 QQ。

### 2.2 用户 QQ 绑定

| 项 | 值 |
|----|-----|
| 存储 | `app_user.qq`（可空，唯一；空串视为 NULL） |
| 校验 | `^\d{5,12}$` 或清空 |
| 读写 | `GET/PATCH /api/auth/me` 字段 `qq`；冲突 `QQ_TAKEN` 409；`POST .../join` 无 QQ 返回 `QQ_REQUIRED` 409 |
| UI | `/me` 资料表单 |

### 2.3 场地群路由

| 项 | 值 |
|----|-----|
| 存储 | `venue.group_umo` |
| 语义 | 群标识。兼容纯数字群号 `123456789` 与 AstrBot UMO 格式 `aiocqhttp:GroupMessage:123456789`（NoneBot 插件归一化为纯数字群号） |
| 管理 | 管理员场地保存接口字段 `groupUmo` |
| 下发 | Bot catalog / queue 详情中的 `groupUmo` |

### 2.4 Bot API 字段映射（插件主路径）

| 语义 | 字段 |
|------|------|
| 目录接口 | `GET /api/bot/catalog` |
| 队列详情 | `GET /api/bot/queues/{venueSlug}/{machineSlug}` |
| 机台标识 | `machineSlug` / `machineName` |
| 队首组 | `head`（空闲且有等待时非 null） |
| 队首玩家 | `head.players[]`：`entryId`, `displayName`, `qq` |
| 完整等待队列 | `waitingQueue[]`：当前机台的等待槽位；双人组同一排位，按公开队列顺序返回 |
| 机台空闲 | `machineIdle` |
| 活跃/热集 | catalog：`activeCount`, `hasPlaying` |
| 群 UMO | `groupUmo`（可空） |
| 区县展示 | `districtName` |

## 3. 通知判定

```text
machine_idle := 无 PLAYING 条目
notify       := machine_idle AND head 存在
head_key     := "{machineSlug}_" + "_".join(sorted(有效 qq 列表))
```

- **热集（拉详情）**：`activeCount > 0 OR hasPlaying`；冷机台只吃 catalog，不拉详情。
- **空队列**：`head is null` 时插件清空该机台 last_head，不发消息。
- **无 QQ**：队首玩家全部无 `qq` 时不发通知，计入 `skipped_no_qq_count`；有部分 QQ 则只 @ 有 QQ 的人。

## 4. Web：Task 分工

### 4.1 Task1 — QQ + group_umo

- Schema / 迁移：`app_user.qq`、`venue.group_umo`
- Session / `PATCH /api/auth/me` / 个人资料 UI
- `venue-meta` + 管理后台场地字段 `groupUmo`

### 4.2 Task2 — Bot API + 限流

鉴权：`Authorization: Bearer $BOT_API_TOKEN`（与 `ADMIN_API_TOKEN` 分离）。

| 路径 | 限流默认 | 说明 |
|------|----------|------|
| `GET /api/bot/catalog` | 20 次/分钟 | 全市机台摘要 |
| `GET /api/bot/queues/...` | 120 次/分钟 | 单机台详情（含 QQ） |

超限：`429` + `error.retryAfterSec`（与现有 `RATE_LIMITED` 风格一致）。

环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOT_API_TOKEN` | 空（未配置则 Bot API 503） | 生产建议 >=32 字符唯一密钥 |
| `BOT_CATALOG_RATE_LIMIT` | 20 | catalog 每分钟上限 |
| `BOT_QUEUE_RATE_LIMIT` | 120 | queue 详情每分钟上限 |

## 5. QQ 机器人插件（services/bot，NoneBot2）

路径：`services/bot/plugins/queue_notify.py`（辅助函数 `services/bot/plugins/helpers.py`）。
由原 AstrBot 插件移植，插件已统一到 NoneBot2，不再依赖 AstrBot / aiohttp。

### 5.1 轮询漏斗（三层）

1. **Catalog**：`/api/bot/catalog` 全量摘要，筛热集（`activeCount>0 || hasPlaying`）。
2. **Detail**：仅热集拉 `/api/bot/queues/{venue}/{machine}` 详情。
3. **Notify**：`machineIdle && head`，且通过冷却 / warmup / QQ 检查后发送。

### 5.2 冷却与 headKey

```text
cooldown_key = f"{machineSlug}_{'_'.join(sorted(qqs))}"
```

- 内存维护 `last_head_by_machine`。
- 队首 QQ 组合变化且非空 -> 尝试通知；成功后写 last_head，**同一队首只 @ 一次**（不再重复）。
- 用 **QQ 组合** 而非 entry/party id，避免重排后误判。
- 队首 **3 分钟**（`HEAD_CONFIRM_TIMEOUT_SEC`）未确认上机时，Web 将其自动排到队尾，新队首会再次被 @。

### 5.3 群路由优先级

1. 详情/目录中的 `groupUmo`（后端 `venues.group_umo`；兼容 UMO 字符串与纯数字群号）
2. 插件配置 `QUEUE_NOTIFY_ROUTING[venueSlug]`
3. 插件配置 `QUEUE_NOTIFY_DISTRICT_ROUTING["district:"+districtSlug]`（若配置）
4. `QUEUE_NOTIFY_DEFAULT_GROUP`

### 5.4 文案与双人

通知正文先展示当前被叫号机台的完整等待队列（队列数据在机台维度维护，不能与其他机台混排），再 @ 队首：

```text
示例市示例区示例中心店队伍情况：

1、玩家 A
2、玩家 B、玩家 C

@玩家 A，请在3分钟内上机游玩
```

双人组同一条消息 @ 所有已绑定 QQ 的成员；`@` 由 OneBot v11
`MessageSegment.at(user_id=...)` 发送（`bot.send_group_msg`），不是普通文本。

### 5.5 冷启动 / 限流 / 日志

| 机制 | 行为 |
|------|------|
| Warmup | 进程启动后前 **2** 轮完整轮询只填缓存，不通知 |
| 429 / 网络错误 | 指数退避（上限可配），再恢复基础间隔 |
| 通知日志 | 一行 JSON：`event=queue_notify`，字段含 `venueSlug, machineSlug, recipients`（脱敏，不含 QQ/群号） |
| 无 QQ 统计 | 每 **10 分钟** 打 `skipped_no_qq_stats`（累计次数） |

### 5.6 配置项（.env，NoneBot 读取为小写属性）

| 键 | 说明 |
|----|------|
| `QUEUE_NOTIFY_ENABLED` | 默认 true；false 关闭轮询 |
| `QUEUE_NOTIFY_BASE_URL` | Web 根地址 |
| `QUEUE_NOTIFY_BOT_TOKEN` | 与 `BOT_API_TOKEN` 一致 |
| `QUEUE_NOTIFY_POLL_INTERVAL_SEC` | 默认 3 |
| `QUEUE_NOTIFY_COOLDOWN_SEC` | 默认 300（同一队首只 @ 一次，冷却仅作兜底） |
| `QUEUE_NOTIFY_REMINDER_MINUTES` | 默认 3 |
| `QUEUE_NOTIFY_WARMUP_ROUNDS` | 默认 2 |
| `QUEUE_NOTIFY_DEFAULT_GROUP` | 兜底群号 |
| `QUEUE_NOTIFY_ROUTING` | `venueSlug -> 群号` JSON |
| `QUEUE_NOTIFY_DISTRICT_ROUTING` | `district:<slug> -> 群号` JSON |
| `QUEUE_NOTIFY_STATS_INTERVAL_SEC` | 默认 600 |
| `QUEUE_NOTIFY_MAX_BACKOFF_SEC` | 默认 120 |

依赖：`httpx`（已包含在 `services/bot/requirements.txt`）。

## 6. Test Plan（Task4）

| ID | 场景 | 期望 |
|----|------|------|
| T1 | 绑定合法 QQ | `PATCH /me` 成功，session 带回 `qq` |
| T2 | 重复 QQ | `QQ_TAKEN` 409 |
| T3 | 清空 QQ | 存 NULL；之后无法 join |
| T4 | 管理员写 `groupUmo` | list/get/catalog 可见 |
| T5 | 无 `BOT_API_TOKEN` | Bot API 503 `BOT_DISABLED` |
| T6 | 错误 Bearer | 401 `BOT_UNAUTHORIZED` |
| T7 | catalog 限流 | 第 21 次/分钟 429 |
| T8 | 空闲 + 队首有 QQ | 插件发 @ |
| T9 | 重排同一 QQ 组 | cooldown 内不重复 @ |
| T10 | 双人双方有 QQ | 一条消息双 At + 队友文案 |
| T11 | 仅一端有 QQ | 只 @ 有 QQ 者 |
| T12 | 后端 `groupUmo` 优先于配置 routing | 消息发到后端 UMO |
| T13 | 启动 warmup 2 轮 | 不通知 |
| T14 | 公开 `/public` | body 无 `qq` 字段 |

## 7. 安全注意

- `BOT_API_TOKEN` 不得写入前端或公开仓库真实值。
- Bot queue 详情含 QQ，仅给机器人；网络路径需等同管理面信任边界。
- 公开 API / SSR 页面禁止附带 `qq`。

## 8. 配置速查

**Web `.env`：**

```bash
BOT_API_TOKEN=your-long-random-bot-token
BOT_CATALOG_RATE_LIMIT=20
BOT_QUEUE_RATE_LIMIT=120
```

**管理后台：** 场地 -> 填写「群 UMO」。

**玩家：** `/me` -> 绑定 QQ。

**QQ 机器人（services/bot/.env）：** `QUEUE_NOTIFY_BASE_URL` + `QUEUE_NOTIFY_BOT_TOKEN` +（可选）`QUEUE_NOTIFY_DEFAULT_GROUP` / `QUEUE_NOTIFY_ROUTING`。
