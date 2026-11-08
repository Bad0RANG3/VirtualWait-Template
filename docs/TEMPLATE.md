# 模板定制指南

VirtualWait 以「模板仓库」形式发布：示例城市、场地、机台与文案都是占位内容，
复制后按下面的顺序替换即可上线。改动前建议先读 [架构与队列流程](ARCHITECTURE.md)
和 [约束与红线](CONSTRAINTS.md)。

## 1. 城市、区县、场地与机台

编辑 [`apps/web/src/lib/constants/catalog.ts`](../apps/web/src/lib/constants/catalog.ts)：

1. 替换 `CITIES`：城市 `slug`、区县 `slug`/`kind`、场地 `slug`/`name`/`hours`/`address`/`regionName`；
2. 替换每个场地的 `machines`：机台 `slug`、`name`、`subtitle`、`accent`、可选 `coinCost`；
3. **slug 一旦发布就不要再改**（它出现在队列 URL 与数据库行里）。

数据库里的场地与机台由 `lib/db/seed.ts` 在首次启动时按 catalog 补齐：

- 已存在的场地/机台不会被覆盖（管理员在后台改过的值会保留）；
- 新增场地/机台会自动插入；
- 删除 catalog 条目不会自动删除数据库行，需要手工清理或重建数据库。

管理员还可以在 `/admin` 运行时覆盖场地地址、区县展示、营业时间、群 UMO 与机台硬币数。

## 2. 品牌与文案

| 位置 | 内容 |
|------|------|
| `apps/web/src/components/AppShell.tsx` | 顶部标识与站点名 |
| `apps/web/src/app/page.tsx` | 首页标题与统计文案 |
| `apps/web/src/components/AuthPanel.tsx` | 登录 / 注册说明文案 |
| `apps/web/src/components/QueueBoard.tsx`、`components/queue/*` | 队列状态与提示文案 |
| `apps/web/src/app/globals.css`、`tailwind.config.ts` | 配色与圆角等视觉变量 |
| `services/bot/plugins/queue_notify.py`（经 `helpers.py`） | 群内叫号文案 |

`ADMIN_API_TOKEN`、`SESSION_SECRET` 等密钥不要写进代码，只放环境文件。

## 3. 身份与注册策略

系统只使用本地账号，没有外部身份服务可切换。可按场地策略调整：

| 变量 | 作用 | 建议 |
|------|------|------|
| `REGISTRATION_ENABLED` | 是否开放自助注册 | 需要人工开户时设为 `false`，再用 `npm run account:create` 现场开户 |
| `CHECKIN_REQUIRED` | 注册是否必须提供场地签到码 | 生产保持 `true`；封闭内网才考虑 `false` |
| `CHECKIN_WINDOW_SEC` | 签到码轮换周期（秒） | 客流大用 300–600；小型场地可放宽到 900 |
| `CHECKIN_GRACE_WINDOWS` | 额外接受的上一窗口数 | 默认 1；网络慢或用户手慢可调到 2 |
| `IP_ACCOUNT_QUOTA_PER_DAY` | 每 IP 每日注册账号上限 | 默认 5；共享 Wi-Fi 场地可调高 |
| `REGISTER_*` / `LOGIN_*` | 注册与登录限流 | 按客流与风控需要调整 |
| `REQUIRE_QQ_FOR_QUEUE` | 排队是否必须绑定 QQ | 默认 `true`（保证能被 @）；不用机器人时可设 `false` |

签到码通过管理台「场地签到码」面板轮换，不需要改代码。

## 4. 队列规则

| 变量 | 默认 | 说明 |
|------|------|------|
| `PLAYING_TIMEOUT_SEC` | 1500 | 单次游玩上限，超时回队尾 |
| `HEAD_CONFIRM_TIMEOUT_SEC` | 180 | 队头确认窗口，超时整组回队尾 |

两者都可在 `/admin` 运行时覆盖（写入 `app_settings`，优先级高于环境变量）。
行为规则（回队尾而不是出队、双人按组判定、一人同时只有一条记录）在
[`apps/web/src/lib/queue/`](../apps/web/src/lib/queue/) 中实现，修改前请先看现有测试：

- `head-timeout.test.ts` / `head-timeout-duo.test.ts`：队头确认超时；
- `finish-requeue.test.ts`：结束游玩回队尾；
- `join-concurrency.test.ts`：并发入队与唯一约束；
- `public-snapshot.test.ts`：公开快照截断行为。

## 5. 机器人（可选）

保持 `BOT_API_TOKEN`（Web）与 `QUEUE_NOTIFY_BOT_TOKEN`（机器人）一致即可启用。
群路由优先级：场地 `groupUmo` → `QUEUE_NOTIFY_ROUTING[venueSlug]` →
`QUEUE_NOTIFY_DISTRICT_ROUTING` → `QUEUE_NOTIFY_DEFAULT_GROUP`。
不需要机器人时，把 `BOT_API_TOKEN` 留空即可关闭 `/api/bot/*`。

## 6. 部署与发布

1. 替换 catalog、品牌与文案，确认没有遗留示例名称；
2. 生成新的 `SESSION_SECRET` 与 `ADMIN_API_TOKEN`（以及 `BOT_API_TOKEN`）；
3. 按 [部署文档](DEPLOYMENT.md) 安装 Web、维护、备份与健康检查单元；
4. 首次上线后立即读取并张贴签到码，跑一次完整排队流程；
5. 发布前执行：

```bash
node scripts/verify-all.mjs
# 或分步
cd apps/web && npm run lint && npx tsc --noEmit && npm test && npm run test:e2e && npm run test:browser && npm run build
```

## 7. 不要做的事

- 不要把真实场地名称、地址、口令、令牌或用户资料提交到仓库；
- 不要放宽 `.dockerignore` 或把 `.env`、`napcat/`、数据库打进镜像；
- 不要重新引入外部身份服务或游戏服务器调用（见 [约束与红线](CONSTRAINTS.md) 第四节）；
- 不要跳过 `npm run db:verify` 就恢复备份。
