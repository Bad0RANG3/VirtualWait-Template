# VirtualWait Web

VirtualWait 的 Next.js 15 前端与队列 API。该目录是模板代码：不包含有效令牌、用户资料或 SQLite 数据库。

## 本地开发

要求 Node.js 22 LTS（`>=22.5 <23`），项目使用 `node:sqlite`。

```bash
cp .env.example .env.local
npm install
npm run dev
```

`.env.example` 只含不可用于生产的占位值。开发模式不需要真实 Gateway；使用 Mock 二维码 `mock:demo-user:示例玩家:12000:示例称号` 即可验证完整流程。

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

## 模板默认页面

- `/`：示例场地首页；
- `/login`：二维码登录；
- `/bind`：刷新已登录用户的公开资料；
- `/queue/sample-venue/machine-a`、`/queue/sample-venue/machine-b`：示例队列；
- `/me`：当前用户的活动记录；
- `/admin`：管理员运维台。

场地、机台和开放时间定义在 `src/lib/constants/venue.ts`。复制模板后应先替换这些示例值；详细步骤见根目录的 [模板定制文档](../../docs/TEMPLATE.md)。

## 环境变量

`.env.example` 说明了全部本地配置。生产环境至少需要：

- 独立且随机的 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN`；每项长度至少 32 字符；
- HTTPS `APP_BASE_URL`；
- 已实现并审计的远程身份 Gateway，且 `GATEWAY_MODE=remote`；
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
- 维护任务会按配置清理临时验证数据、历史队列记录和不活动的公开资料快照。

发布前请同时阅读 [安全与发布清单](../../docs/SECURITY.md) 和 [部署说明](../../infra/server/README.md)。
