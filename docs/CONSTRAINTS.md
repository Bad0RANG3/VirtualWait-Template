# 项目约束与红线

本文记录 VirtualWait 重构后必须遵守的约束，防止破坏流程、泄漏密钥或偏离架构。配套清单见[安全与发布清单](SECURITY.md)。

## 一、密钥与敏感文件（不要动、不要提交）

以下文件包含真实密钥、登录验证凭据或运行数据，**不得修改、删除或提交**；它们全部被 `.gitignore` 覆盖，但忽略规则不是安全控制：

| 文件 / 路径 | 内容 | 约束 |
|---|---|---|
| `packages/sdgb-client/sdgb/settings_local.py` | 可选的 SDGB 机厅/版本覆盖（默认已内置公开参数） | 若使用，禁止提交 |
| `services/sdgb-gateway/.env.local` | Gateway 真实密钥与 provider 配置 | 禁止提交 |
| `services/bot/.env` | 机器人配置（含 QQ 账号） | 禁止提交 |
| `apps/web/.env.local` | Web 真实密钥 | 禁止提交 |
| `services/bot/napcat/` | QQ 登录态 / NapCat 配置 | 禁止提交 |
| `data/`、`**/token_cache.json`、`**/records_cache.json`、`**/music_data_cache.json` | 运行数据与缓存（含账号数据） | 禁止提交 |
| SQLite 数据库、WAL/SHM、备份 | 运行数据 | 放仓库之外受限目录，加密备份 |

## 二、登录验证密钥（流程红线，不得破坏）

以下配对值必须**两端完全一致**，否则登录 / 叫号流程会断。轮换时必须两端同步更新并重启：

| 配对 | 说明 |
|---|---|
| `GATEWAY_SHARED_SECRET`（Web）↔ `VW_GATEWAY_SHARED_SECRET`（Gateway） | HMAC 签名 |
| `PUBLIC_ID_HMAC_SECRET`（Web）↔ `VW_PUBLIC_ID_HMAC_SECRET`（Gateway） | 匿名 subject 派生 + 登出恢复加密 |
| `GATEWAY_KEY_ID`（Web）↔ `VW_GATEWAY_KEY_ID`（Gateway） | key ID 协商 |
| `BOT_API_TOKEN`（Web）↔ `QUEUE_NOTIFY_BOT_TOKEN`（Bot） | Bot API Bearer |
| `ADMIN_API_TOKEN`（Web） | 管理台登录令牌，独立 |

生成规则：每个环境独立、随机、长度至少 32 字符；仅通过 secret manager 或权限 `0600` 的环境文件注入；不进入日志、浏览器代码、文档或 shell 历史。

## 三、架构约束

- Web **始终**使用 `GATEWAY_MODE=remote` 的签名远程 Gateway，禁止 in-process mock；
- Gateway 只监听回环或受控私有网络，**禁止直接暴露公网**；
- 持久层为 SQLite，**单机单实例**：不得把同一个数据目录挂到多台 Web 实例，未迁移服务型数据库前不得负载均衡；
- `virtualwait-maintenance` 必须常驻，负责清理临时数据与过期历史；
- 只有反向代理已清除并重写客户端转发 IP 头时，才设置 `TRUST_PROXY_HEADERS=true`；
- 公开队列接口**永不返回 QQ**；Bot API 视为管理面，仅在受控网络路径使用；
- 队列规则固定：队头确认超时 → 整组自动排到队尾；游玩结束 / 游玩超时 → 自动回队尾；玩家可随时取消离开；
- 预构建机器人镜像**内置国服公开的 SDGB 默认参数**（`settings.py`），不包含个人/机厅私有覆盖或运行数据（`settings_local.py`、`.env`、`napcat/`、QQ 登录态均不会打进镜像）；换机厅用 `VW_SDGB_*` 覆盖；根目录 `.dockerignore` 为白名单式，**不得放宽**；
- 原始二维码、token、明文 userID 与完整上游响应**不入库**；登出恢复上下文用 `PUBLIC_ID_HMAC_SECRET` 派生密钥 AES-GCM 加密后持久化。

## 四、高风险命令纪律（B50 / 发票）

- `/b50` 与全部写命令（`/fp` `/giveitem` `/score`）每次使用**新二维码**，
  登录成功即消耗该码，流程走完**必须登出**；
- 同账号 10 分钟内重复查询走本地缓存，不重复登录；
- 中断可能触发小黑屋（`isLogin=1`，约 15 分钟冷却），期间不得反复登录；
- `token_cache.json` / `records_cache.json` 只允许记录 `userID` 与时间，禁止落盘二维码或 token；
- 机器人到 SDGB / AiMe 的请求必须启用 TLS 证书校验，禁止 `verify=False`
  （`node scripts/verify-tls-verification.mjs` 与 CI 步骤会拦截）；
- 群消息里出现机台登录二维码串（`SGWCMAID...`）由 `services/bot/plugins/qr_guard.py`
  撤回（仅当机器人在该群为群主/管理员）；私聊使用命令不受影响。

## 五、发布前检查

- [ ] `git status` 无本地环境文件、数据库、备份或构建产物；
- [ ] `git ls-files` 中无 `napcat/`、`data/`、`token_cache.json`、`records_cache.json`、`webui.json`、`.env*`（`.env.example` 除外）、`settings_local.py`；
- [ ] `node scripts/verify-all.mjs` 通过；
- [ ] 登录验证密钥两端一致，且未出现在提交 diff 中；
- [ ] 已阅读 [SECURITY.md](SECURITY.md) 并完成生产部署清单。