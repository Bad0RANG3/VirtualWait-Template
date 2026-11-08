# 安全与发布清单

## 不可提交的数据

- `.env.local`、服务器环境文件和任何有效密钥；
- SQLite 数据库、WAL/SHM 文件、备份和导出（含口令哈希与 QQ 绑定）；
- 会话 Cookie、场地签到码、真实用户昵称或任何可识别个人的资料；
- 真实场地名称、地址、内部域名、管理员账号或截图中的个人资料。

根目录 `.gitignore` 已覆盖常见运行文件，但忽略规则不是安全控制。提交前必须人工检查
`git status` 和待提交 diff。

## 账号与口令

- 口令使用 Node 内置 scrypt（N=16384, r=8, p=1, 64 字节输出）+ 每用户 16 字节随机盐，
  存储为 `password_hash`/`password_salt`/`password_algo`（见 `apps/web/src/lib/auth/password.ts`）；
- 口令策略：8–128 位，拒绝全同字符与纯空白；`PASSWORD_TOO_SHORT`/`PASSWORD_TOO_LONG`/`PASSWORD_TOO_WEAK` 为固定错误码；
- 校验使用 `timingSafeEqual` 常量时间比较；用户名不存在时执行等价 scrypt 计算
  （`burnPasswordWork`），登录失败统一返回 `INVALID_CREDENTIALS`；
- 注册与登录分别限流：`REGISTER_IP_LIMIT` / `REGISTER_GLOBAL_LIMIT` / `LOGIN_IP_LIMIT` / `LOGIN_ACCOUNT_LIMIT`；
- 每 IP 每日注册配额 `IP_ACCOUNT_QUOTA_PER_DAY`（默认 5）只作用于注册；
- 不得新增明文口令、可逆加密或弱哈希存储路径；
- 昵称唯一性先做 NFKC 归一（全角/兼容字符折叠）再按 `COLLATE NOCASE` 比较；
  跨语系同形字（如西里尔字母 А）仍是已知残余风险：本系统不是身份提供者，
  公开队列板与群消息中的昵称仅供展示，账号身份始终以用户名为准。

## 场地签到码

- 6 位码由 `HMAC-SHA256(venue.checkin_secret, "vw-checkin:<windowIndex>")` 派生，
  默认 600 秒轮换，接受 `CHECKIN_GRACE_WINDOWS`（默认 1）个历史窗口；
- `checkin_secret` 为每场地 32 字节随机值，仅存于 SQLite，不进入日志或前端；
- 签到码会展示在现场，属于「证明在场」的弱凭据：不得把它当作账号口令，也不得长期张贴；
- 码外泄（例如被转发到公开群）时在管理台立即轮换，旧码即刻失效；
- 仅在封闭内网部署时才考虑 `CHECKIN_REQUIRED=false`。

## 密钥管理

- 为 `SESSION_SECRET`、`ADMIN_API_TOKEN` 分别生成随机值，并按需为 Bot 生成 `BOT_API_TOKEN`；
- 每个环境使用不同值，长度不少于 32 字符；
- 仅通过受控的 secret manager 或权限为 `0600` 的服务器环境文件注入；
- 发生泄露时立即轮换：轮换 `SESSION_SECRET` 会使全部会话失效；轮换 `BOT_API_TOKEN` 会同时
  要求更新机器人侧 `QUEUE_NOTIFY_BOT_TOKEN`；
- 禁止把值复制到文档、CI 输出、浏览器环境变量或 shell 历史。

## 数据与日志

- 将运行数据库和备份放在仓库之外的受限目录；
- 对备份实施加密、访问控制、保留期限和恢复演练；
- 保持 `npm run maintenance` 常驻运行，按配置清理限流桶、过期 IP 配额、不活跃登录元数据与历史数据；
- 运行时设置（超时、场地元数据、机台硬币、签到码密钥）与队列/会话同库，纳入同一备份与访问控制范围；
- 日志仅记录脱敏的操作结果，绝不记录口令、Cookie、签到码或 QQ 号原文；
- `session` 表的吊销状态必须保留到 Cookie 自然过期，不能提前清理。

## 网络与部署

- 推荐仅通过 HTTPS 暴露 Web；若使用 HTTP，应限定在受控内网/测试环境并接受登录 Cookie 非 `Secure` 的风险；
- 代理必须删除客户端伪造的转发 IP 头后再写入可信值；生产设置 `TRUST_PROXY_HEADERS=true`；
- 生产环境 `APP_BASE_URL` 必须为 HTTPS（`ALLOW_INSECURE_APP_URL=true` 仅供受控内网例外）；
- 应用必须只监听回环（`npm run start` 默认 `HOST=127.0.0.1`）并在宿主机防火墙上封禁该端口：
  生产强制 `TRUST_PROXY_HEADERS=true`，一旦有人绕过代理直连端口就能伪造客户端 IP，
  从而绕过每 IP 注册配额、登录限流与会话 IP 绑定；
- Bot API 会返回队首 QQ，网络边界应视为管理面：不得经过公开 CDN 缓存或不受控日志系统；
- 生产 CSP 保持严格（`next.config.ts` 仅在开发模式放行 `unsafe-eval` 以支持 HMR）；
- 管理端写接口同时接受 `ADMIN_API_TOKEN` Bearer；带 Bearer 的请求跳过同源校验
  （跨站脚本无法在不触发 CORS 预检的情况下设置该头），因此运维脚本可直接调用；
- 执行 `npm run preflight -- --production`，并使用 `infra/server/` 中的静态检查。

## 发布前确认

- [ ] `git status` 中没有本地环境文件、数据库、备份或构建产物；
- [ ] `git ls-files` 中没有 `napcat/`、`data/`、`webui.json` 或 `.env*`（`.env.example` 除外）；
- [ ] 仓库内不存在任何被 CI 拒绝的旧身份配置字面量（见 `.github/workflows/verify.yml`）；
- [ ] 默认场地、机台、文案均已替换；`ADMIN_API_TOKEN` 已更换为强随机值；
- [ ] 已公告玩家重新注册（若从旧版本升级：旧账号无本地口令，无法迁移）；
- [ ] lint、类型检查、单元测试、E2E 和浏览器测试均通过；
- [ ] 管理员权限、备份恢复、签到码轮换和数据删除流程已演练；
- [ ] 已审阅公开仓库的历史提交；若曾提交过密钥，应视为泄露并轮换。
