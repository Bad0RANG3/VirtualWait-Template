# 模板定制指南

当前部署配置为“河源坚基动漫E族 / 旧机 / 新机”。仓库不包含运行数据和本地配置；如复制到其他场地，请完成以下替换后再向真实用户开放。

## 1. 场地与机台

编辑 `apps/web/src/lib/constants/venue.ts`：

- `VENUE.id`、`VENUE.name`、`VENUE.slug`；
- `VENUE_HOURS` 的营业时间与时区实现；
- `MACHINES` 中的机台 ID、名称、路由 slug、说明和配色。

旧机与新机当前仅表示引进时间先后，不应据此设置不同的队列规则。更改 slug 后，同时更新 `apps/web/README.md`、E2E 路径和任何外部链接。

## 2. 品牌与文案

至少检查以下位置：

- `apps/web/src/app/layout.tsx`：页面标题和描述；
- `apps/web/src/app/page.tsx`：首页说明；
- `apps/web/src/components/QrLoginForm.tsx` 与 `QrBindForm.tsx`：登录提示；
- `apps/web/src/lib/gateway/mock.ts`：仅限开发的 Mock 输入格式。

不要在任何文案、截图、测试夹具或示例二维码中放入真实用户 ID、昵称、场地地址、访问令牌或内部域名。

## 3. 身份服务

Web 的 `mock` 模式仅用于开发。若要接入真实身份服务：

1. 在 `services/sdgb-gateway` 实现经过授权的提供者；
2. 保持 Web 与 Gateway 的 HMAC、时间戳、nonce 与请求摘要校验；
3. 只向 Web 返回允许公开的最小资料；
4. 禁止将原始二维码、上游令牌、完整上游响应写入数据库或日志；
5. 完成威胁建模、失败恢复、限流和独立安全审计后，才设置 `GATEWAY_MODE=remote`。

模板中的 Gateway 会拒绝生产模式启动，避免 Mock 被误用于真实认证。

## 4. 队列规则

核心规则位于 `apps/web/src/lib/queue/service.ts`。默认流程为：

1. 用户加入等待队列；
2. 管理员从运维台将一组记录标记为“开始游玩”；
3. 用户或管理员结束游玩；
4. 超过 `PLAYING_TIMEOUT_SEC` 的游玩记录自动回到队尾。

修改规则时应同步更新 UI、API 契约、自动化测试和管理员操作说明。不要恢复依赖现场叫号或展示屏的流程，除非先明确可执行的运营方案与隐私边界。

## 5. 测试与发布

```bash
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
