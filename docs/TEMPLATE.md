# 模板定制指南

## 1. 城市、区县、场地与机台

编辑 `apps/web/src/lib/constants/catalog.ts`：

- `CITIES`：城市 id / name / slug；
- `districts`：区或县（`kind: "district" | "county"`）；
- `venues`：场地 id / name / slug / timezone / hours，以及可选 `regionName` / `regionKind` / `address` / `machineCount`；
- `machines`：机台 id / name / slug / subtitle / accent，以及可选默认 `coinCost`。

默认示例为 `示例市 → 示例区/示例县 → 示例中心店/示例东城店`。更改 slug 后，同时更新 `apps/web/README.md`、E2E 路径和任何外部链接。

静态 catalog 决定导航与默认展示。部署后管理员仍可在运维台覆盖：

- 场地地址、区县展示名、开放时间（SQLite + `lib/settings/venue-meta.ts`）；
- 机台单次游玩硬币数 `coin_cost`；
- 游玩超时与队头确认超时（环境变量默认 + `app_settings`）。

## 2. 品牌与文案

至少检查以下位置：

- `apps/web/src/app/layout.tsx`：页面标题和描述；
- `apps/web/src/app/page.tsx`：首页说明；
- `apps/web/src/components/QrLoginForm.tsx` 与 `QrBindForm.tsx`：登录提示；
- `services/sdgb-gateway` 的 mock provider：开发用 `mock:*` 输入格式；真实二维码由 Gateway 的 `http` 或 `sdgb_preview` provider 处理。

不要在任何文案、截图、测试夹具或示例二维码中放入真实用户 ID、昵称、场地地址、访问令牌或内部域名。

## 3. 身份服务

Web 始终使用签名远程 Gateway（`GATEWAY_MODE=remote`）。身份 mock 只存在于 Gateway provider：

1. 选择 Gateway provider：
   - `mock`：本地开发，接受 `mock:*` 二维码；
   - `http`：转发到你自己的验证服务；
   - `sdgb_preview`：无登录二维码预览（AiMe `get_data` + 标题服 `GetUserPreviewApi`，**不调用** `UserLoginApi` / `UserLogoutApi`）；
2. 配置对应环境变量（`VW_GATEWAY_HTTP_*` 或 `VW_SDGB_*`）；
3. 保持 Web 与 Gateway 的 HMAC、时间戳、nonce 与请求摘要校验；
4. 只向 Web 返回允许公开的最小资料；
5. 禁止将原始二维码、上游令牌、完整上游响应写入数据库或日志；
6. 完成威胁建模、失败恢复、限流和独立安全审计后，再切换到真实 provider。

## 4. 队列规则

实现按模块拆分，稳定导入入口为 `apps/web/src/lib/queue/service.ts`（仅 re-export）。主要文件：

| 文件 | 职责 |
|------|------|
| `queue/user-actions.ts` | 加入、拼机确认、取消、队头确认上机、结束游玩 |
| `queue/timeouts.ts` | 游玩超时回队尾、队头确认超时（后移/卸卡） |
| `queue/core.ts` | 上机、重排、结束/过期、审计辅助 |
| `queue/public.ts` | 公开队列与活跃人数统计 |
| `queue/admin.ts` | 管理员队列与条目操作 |
| `queue/views.ts` | 展示槽位组装 |
| `queue/maintenance.ts` | 数据保留清理 |
| `settings/timeouts.ts` | 超时读写（env 默认 + DB） |
| `settings/venue-meta.ts` | 场地元数据与机台硬币 |

默认流程：

1. 用户加入等待队列（单人，或发起/加入双人）；
2. 机台空闲且自己在队头时，用户点击「确认上机」开始游玩（管理员仍可代点开始）；
3. 队头在 `HEAD_CONFIRM_TIMEOUT_SEC`（默认 180 秒，可在管理台覆盖）内未确认：
   - 第一次：整组后移 1 组（单刷/拼机都算一组）；
   - 第二次：直接卸卡（自动取消）；
4. 用户或管理员结束游玩；
5. 超过 `PLAYING_TIMEOUT_SEC`（默认 1500 秒，可覆盖）的游玩记录自动回到队尾。

管理员运维台（`/admin`）还可：开闭/暂停机台队列、代操作条目、编辑场地信息与机台硬币、查看审计。

修改规则时应同步更新 UI、API 契约、自动化测试和管理员操作说明。更完整的模块地图与 API 列表见 [架构说明](ARCHITECTURE.md)。不要恢复依赖现场叫号或展示屏的流程，除非先明确可执行的运营方案与隐私边界。

## 5. 测试与发布

```bash
# 或一条命令：node scripts/verify-all.mjs
cd apps/web
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e
npm run test:browser
npm run preflight -- --production
```

生产部署前还应执行：

```bash
node infra/server/scripts/verify-server-env-examples.mjs
node infra/server/scripts/verify-nginx-template.mjs
```

完整安全要求见 [SECURITY.md](SECURITY.md)。
