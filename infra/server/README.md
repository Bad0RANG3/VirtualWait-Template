# 自托管模板

本目录提供 Nginx、systemd 和环境变量样例。它们是部署起点，不是可直接复制到生产环境的成品配置。

## 拓扑

```text
Internet → HTTPS 反向代理 → Web (127.0.0.1:3000)
                          ↘ Gateway (127.0.0.1:8787)
```

Gateway 不应直接暴露到公网。模板中的 Gateway 只实现 Mock，因此真实生产接入必须先完成提供者实现与安全审计。

## 部署步骤

1. 使用非 root 运行用户，代码目录、数据目录、备份目录和环境文件分别授予最小权限；
2. 从 `env/*.example` 复制环境文件到仓库外的受控路径，例如 `/etc/virtualwait/`；
3. 替换每一个 `CHANGE_ME_*` 值，并保证 staging 与 production 不复用任何密钥、域名或数据目录；
4. 设置 HTTPS `APP_BASE_URL`、受控备份目录、可信代理头和数据保留期限；
5. 执行静态检查、构建和恢复演练；
6. 最后安装 systemd service/timer 与 Nginx 配置。

示例环境文件中的占位值故意不可运行。不要把服务器环境文件、私钥、数据库或备份复制回仓库。

## 必做检查

```bash
node infra/server/scripts/verify-server-env-examples.mjs
node infra/server/scripts/verify-nginx-template.mjs
cd apps/web
npm run preflight -- --production
npm run build
```

`systemd/` 中包含 Web、维护任务、备份和健康检查服务。执行前请根据本机用户、路径、端口、备份策略和告警方式修改配置，再运行：

```bash
systemd-analyze verify infra/server/systemd/virtualwait-*.service infra/server/systemd/virtualwait-*.timer
```

## 安全要求

- 仅通过 HTTPS 公开 Web；
- Gateway 仅绑定回环或私有受控网络；
- 代理必须覆盖客户端提交的 `X-Forwarded-For`、`X-Real-IP` 和同类头；
- 数据库与备份需要加密、访问控制、保留清理和恢复演练；
- 维护进程必须持续运行，以清理临时数据和过期历史；
- 管理员令牌只能从受控 secret 注入，不能进入日志、浏览器代码或 shell 历史。

完整模板发布要求见 [安全与发布清单](../../docs/SECURITY.md)。
