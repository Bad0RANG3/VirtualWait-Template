# 项目约束与红线

本文记录 VirtualWait 重构后必须遵守的约束，防止破坏流程、泄漏密钥或偏离架构。
配套清单见[安全与发布清单](SECURITY.md)。

## 一、密钥与敏感文件（不要动、不要提交）

以下文件包含真实密钥或运行数据，**不得修改、删除或提交**；它们全部被 `.gitignore` 覆盖，
但忽略规则不是安全控制：

| 文件 / 路径 | 内容 | 约束 |
|---|---|---|
| `apps/web/.env.local` | Web 真实密钥 | 禁止提交 |
| `services/bot/.env` | 机器人配置（含 Bot token） | 禁止提交 |
| `services/bot/napcat/` | QQ 登录态 / NapCat 配置 | 禁止提交 |
| `data/`、`**/*.log` | 运行数据与日志 | 禁止提交 |
| SQLite 数据库、WAL/SHM、备份 | 运行数据（含账号与口令哈希） | 放仓库之外受限目录，加密备份 |
| `/etc/virtualwait/web.env` | 服务器环境文件 | 权限 `0600`，仅从 secret manager 或受控注入 |

## 二、配对密钥（流程红线，不得破坏）

以下配对值必须**两端完全一致**，否则叫号流程会断。轮换时必须两端同步更新并重启：

| 配对 | 说明 |
|---|---|
| `BOT_API_TOKEN`（Web）↔ `QUEUE_NOTIFY_BOT_TOKEN`（Bot） | Bot API Bearer |
| `SESSION_SECRET`（Web） | 会话 Cookie 签名，独立 |
| `ADMIN_API_TOKEN`（Web） | 管理台登录令牌，独立，且不得复用为 Bot 令牌 |

生成规则：每个环境独立、随机、长度至少 32 字符；仅通过 secret manager 或权限 `0600` 的环境文件注入；
不进入日志、浏览器代码、文档或 shell 历史。轮换 `SESSION_SECRET` 会使所有会话失效。

## 三、账号与签到码纪律

- 口令只以 scrypt 加盐哈希入库（`password_hash`/`password_salt`/`password_algo`）；
  禁止新增明文、可逆或弱哈希（MD5/SHA1/无盐 SHA256）存储路径；
- 注册必须校验场地签到码（除非显式设置 `CHECKIN_REQUIRED=false`，且仅限封闭内网）；
- 签到码只通过管理台轮换，不要硬编码到脚本、长期张贴或写进文档示例；
  发现外泄立即轮换（轮换后旧码立即失效）；
- 每 IP 每日注册配额 `IP_ACCOUNT_QUOTA_PER_DAY` **只作用于注册**：不要把登录也纳入该配额，
  否则场馆共享 Wi-Fi 会把常客挡在门外；
- 用户名不存在时也必须执行等价的 scrypt 计算，保持 `INVALID_CREDENTIALS` 恒定响应。

## 四、架构约束

- 持久层为 SQLite，**单机单实例**：不得把同一个数据目录挂到多台 Web 实例，
  未迁移服务型数据库前不得负载均衡；
- `virtualwait-maintenance` 必须常驻，负责清理限流桶、过期 IP 配额、登录元数据与历史数据；
- 只有反向代理已清除并重写客户端转发 IP 头时，才设置 `TRUST_PROXY_HEADERS=true`；
- 公开队列接口**永不返回 QQ、用户名、IP 或身份内部字段**；Bot API 视为管理面，仅在受控网络路径使用；
- 队列规则固定：队头确认超时 → 整组自动排到队尾；游玩结束 / 游玩超时 → 自动回队尾；玩家可随时取消离开；
- **不得重新引入**任何外部身份服务、游戏服务器或第三方协议客户端（历史版本曾包含一个独立身份
  Gateway 服务与共享客户端包，均已删除）。新增出站依赖必须在 PR 中说明必要性、凭据与隐私影响；
- 机器人镜像 `.dockerignore` 为白名单式，**不得放宽**；镜像内不得包含 `.env`、`napcat/`、数据或登录态。

## 五、机器人纪律

- 机器人只与本部署 Web 的 `/api/bot/*` 通信，不得直接读写 Web 的 SQLite；
- 机器人不得实现任何写账号数据、成绩或道具的命令；
- 群消息日志不得包含 QQ 号或群号原文（`queue_notify` 已按此实现，勿改回）；
- NapCat 端口（3001/6099/8080）不得暴露公网。

## 六、发布前检查

- [ ] `git status` 无本地环境文件、数据库、备份或构建产物；
- [ ] `git ls-files` 中无 `napcat/`、`data/`、`webui.json`、`.env*`（`.env.example` 除外）；
- [ ] `node scripts/verify-all.mjs` 通过；
- [ ] `BOT_API_TOKEN` 两端一致，且未出现在提交 diff 中；
- [ ] 已公告玩家重新注册（若从旧版本升级），并完成一次签到码轮换演练；
- [ ] 已阅读 [SECURITY.md](SECURITY.md) 并完成生产部署清单。
