# 安全与发布清单

## 不可提交的数据

- `.env.local`、服务器环境文件和任何有效密钥；
- SQLite 数据库、WAL/SHM 文件、备份和导出；
- 原始二维码、身份令牌、Cookie、用户 ID、IP 地址和完整上游响应；
- 真实场地名称、地址、内部域名、管理员账号或截图中的个人资料。

根目录 `.gitignore` 已覆盖常见运行文件，但忽略规则不是安全控制。提交前必须人工检查 `git status` 和待提交 diff。

## 密钥管理

- 为 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN` 分别生成随机值；
- 每个环境使用不同值，长度不少于 32 字符；
- 仅通过受控的 secret manager 或权限为 `0600` 的服务器环境文件注入；
- 发生泄露时立即轮换，并使受影响会话失效；
- 禁止把值复制到文档、CI 输出、浏览器环境变量或 shell 历史；
- `packages/sdgb-client` 内置默认值不得包含任何真实 SDGB 密钥/机厅信息（AES Key/IV、
  ObfuscateParam、AIME Salt、KeychipID、ClientID 等），一律通过环境变量或
  gitignored 的 `sdgb/settings_local.py` 注入；缺少密钥必须 fail-fast；
- `token_cache.json` / `records_cache.json` 只允许记录 `userID` 与时间，禁止落盘
  原始二维码或 token；`services/bot/napcat/`、仓库根 `data/` 等运行时目录禁止入库；
- 机器人到 SDGB/AiMe 的请求必须启用 TLS 证书校验，禁止 `verify=False`
  （`scripts/verify-tls-verification.mjs` 已把这条做成门禁，CI 同步校验）。

## 数据与日志

- 将运行数据库和备份放在仓库之外的受限目录；
- 对备份实施加密、访问控制、保留期限和恢复演练；
- 保持 `npm run maintenance` 常驻运行，按配置清理临时和历史数据；
- 运行时设置（超时、场地元数据、机台硬币）与队列/会话同库，纳入同一备份与访问控制范围；
- 日志仅记录脱敏的操作结果，绝不记录二维码、令牌、Cookie 或原始身份响应。

## 传分接口（`POST /v1/score-write-jobs`）

- 这是对真实账号的**写入**，默认关闭；只在部署方确实被授权操作目标账号时开启
  `VW_SDGB_WRITE_ENABLED=1`，并且只让 Gateway 签名方（Web 服务端）调用，不暴露给浏览器；
- 机台二维码一次一码：Gateway 不重试已提交的作业，进程重启时残留的写入作业直接判
  `JOB_INTERRUPTED`，绝不自动重放；
- 二维码与成绩条目只存在于内存队列，不入库、不入日志；数据库仅保存作业状态行与
  公开回执（写入条数、是否回查确认）；
- 两次写入之间必须保持 `VW_SDGB_WRITE_MIN_INTERVAL_SEC`（默认 900 秒 = 机台 15 分钟
  小黑屋）以上，调小会导致登录被拒并白白消耗二维码；
- 写入路径复用 `packages/sdgb-client` 的实机时序，TLS 校验同样不允许关闭。

## 网络与部署

- 推荐仅通过 HTTPS 暴露 Web；若使用 HTTP，应限定在受控内网/测试环境并接受登录 Cookie 非 `Secure` 的风险；
- Gateway 只监听受信任网络或回环地址，不能直接暴露到公网；
- 代理必须删除客户端伪造的转发 IP 头后再写入可信值；
- 生产环境设置 `TRUST_PROXY_HEADERS=true` 前，先验证上述代理行为；
- 执行 `npm run preflight -- --production`，并使用 `infra/server/` 中的静态检查。

## 发布前确认

- [ ] `git status` 中没有本地环境文件、数据库、备份或构建产物；
- [ ] `git ls-files` 中没有 `napcat/`、`data/`、`token_cache.json`、`records_cache.json`、
      `webui.json` 或 `.env`；`preflight` 的仓库泄露扫描通过；
- [ ] 默认场地、机台、文案和示例账户均已替换；
- [ ] 真实身份提供者已授权、审计并完成故障测试；
- [ ] lint、类型检查、单元测试、E2E 和浏览器测试均通过；
- [ ] 管理员权限、备份恢复和数据删除流程已演练；
- [ ] 已审阅公开仓库的历史提交；若曾提交过密钥，应视为泄露并轮换。
