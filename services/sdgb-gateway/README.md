# 身份 Gateway

此目录提供 Web 与身份服务之间的签名边界实现：HMAC、时间戳、nonce、请求摘要、限流与 SQLite 作业状态。

Gateway 现在支持四种 provider：

- `mock`：离线测试 provider，只接受 `mock:*` 二维码；
- `http`：真实二维码 provider 适配器，把二维码转发给你自己配置的授权验证服务；
- `sdgb_preview`：无登录预览链路（AiMe 扫码换 `userId/token`，再调 `GetUserPreviewApi`）。**不会**调用 `UserLoginApi` / `UserLogoutApi`，因此不会占用机台登录态；
- `sdgb_full`：**真实登录验证**（AiMe 换码 → `GetUserPreviewApi` 探测 isLogin → `UserLoginApi` → 取公开资料 → 立即 `UserLogoutApi`）。登出失败时保留 AES-GCM 加密恢复上下文，由 `LOGGING_OUT` 作业状态与恢复线程后台重试，确保“必登出”。

## 本地 Mock 运行

需要 Python 3.11+（`pyproject.toml` 的 `requires-python`）：

```bash
cd services/sdgb-gateway
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[test]"   # Windows；Linux/macOS 用 .venv/bin/python -m pip
cp .env.example .env.local
.venv\Scripts\python.exe -m virtualwait_gateway
.venv\Scripts\python.exe -m pytest -q
```

默认仅监听 `127.0.0.1:8787`。Web 始终使用 `GATEWAY_MODE=remote` 调用本服务；两端的 key ID、共享密钥和公开身份 HMAC 密钥必须一致。本地 `.env.local` 不得提交。

## 接入真实二维码

Web 侧保持远程 Gateway（开发与生产相同接口）：

```env
GATEWAY_MODE=remote
GATEWAY_BASE_URL=http://127.0.0.1:8787
GATEWAY_KEY_ID=production-web-1
GATEWAY_SHARED_SECRET=<必须和 Gateway 的 VW_GATEWAY_SHARED_SECRET 一致>
PUBLIC_ID_HMAC_SECRET=<必须和 Gateway 的 VW_PUBLIC_ID_HMAC_SECRET 一致>
```

Gateway 侧启用 HTTP provider：

```env
VW_GATEWAY_PROVIDER=http
VW_GATEWAY_HTTP_VERIFY_URL=https://verifier.example.com/v1/maimai/verify-qr
VW_GATEWAY_HTTP_AUTH_HEADER=Authorization
VW_GATEWAY_HTTP_AUTH_VALUE=Bearer <你的验证服务 token>
```

`VW_GATEWAY_HTTP_VERIFY_URL` 指向你拥有授权的真实验证服务。Gateway 会向它发送：

```json
{"qrCode":"<用户提交的二维码内容>"}
```

验证服务成功时返回以下任一 JSON 形状：

```json
{
  "status": "SUCCEEDED",
  "identityId": "stable-private-user-id",
  "profile": {
    "displayName": "Player",
    "rating": 12345,
    "title": "Title"
  }
}
```

或如果上游已经生成了 VirtualWait 可用的匿名 subject：

```json
{
  "status": "SUCCEEDED",
  "identitySubject": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "profile": { "displayName": "Player" }
}
```

失败时返回：

```json
{"status":"FAILED","errorCode":"QR_EXCHANGE_FAILED"}
```

如果不带 `status`，Gateway 会把响应当作成功处理，并兼容顶层字段：

```json
{"identityId":"stable-private-user-id","displayName":"Player","rating":12345,"title":"Title"}
```

Gateway 不会持久化原始二维码、上游 token、明文用户 ID 或完整上游响应；`identityId` 会在 Gateway 内用 `VW_PUBLIC_ID_HMAC_SECRET` HMAC 成匿名 subject 后再返回给 Web。


## 无登录 SDGB 预览（推荐用于排队身份）

```env
VW_GATEWAY_PROVIDER=sdgb_preview
VW_SDGB_AIME_URL=http://ai.sys-allnet.cn/wc_aime/api/get_data
VW_SDGB_TITLE_SERVER_URL=https://maimai-gm.wahlap.com:42081/Maimai2Servlet
VW_SDGB_AIME_SALT=<aime salt>
VW_SDGB_AES_KEY=<title server aes key>
VW_SDGB_AES_IV=<title server aes iv>
VW_SDGB_OBFUSCATE_PARAM=<api hash salt>
VW_SDGB_KEYCHIP_ID=<keychip id>
VW_SDGB_CLIENT_ID=<client id>
VW_SDGB_TIMEOUT_SEC=10
```

流程：

1. 截取二维码末 64 位（如需要）；
2. 调用 AiMe `get_data` 得到临时 `userID` + `token`；
3. 调用标题服 `GetUserPreviewApi` 读取 `userName` / `playerRating` 等公开字段；
4. 用 `VW_PUBLIC_ID_HMAC_SECRET` 把 `userID` 打成匿名 subject 后返回 Web。

原始二维码、token、完整上游响应都不会入库。

## 真实登录 SDGB provider（sdgb_full）

与 `sdgb_preview` 相同的一组 `VW_SDGB_*` 配置，额外指定机厅位置：

```env
VW_GATEWAY_PROVIDER=sdgb_full
VW_SDGB_AIME_URL=http://ai.sys-allnet.cn/wc_aime/api/get_data
VW_SDGB_TITLE_SERVER_URL=https://maimai-gm.wahlap.com:42081/Maimai2Servlet
VW_SDGB_AIME_SALT=<aime salt>
VW_SDGB_AES_KEY=<title server aes key>
VW_SDGB_AES_IV=<title server aes iv>
VW_SDGB_OBFUSCATE_PARAM=<api hash salt>
VW_SDGB_KEYCHIP_ID=<keychip id>
VW_SDGB_CLIENT_ID=<client id>
VW_SDGB_REGION_ID=1403
VW_SDGB_PLACE_ID=1
VW_SDGB_TIMEOUT_SEC=10
```

流程：

1. AiMe `get_data` 换临时 `userId/token`（二维码截取末 64 位）；
2. `GetUserPreviewApi` 探测：`isLogin=1`（小黑屋）或硬封禁（`banState>=2`）直接拒绝，不硬闯；
3. `UserLoginApi` 登录（捕获 JSESSIONID 会话与登录时刻）；
4. 从预览提取 `userName` / `playerRating` / `trophyId` 等最小公开字段；
5. 立即 `UserLogoutApi` 登出（回传登录时刻）；若登出失败，把 `{userId, loginTs, cookie}`
   用 `VW_PUBLIC_ID_HMAC_SECRET` 派生密钥做 AES-GCM 加密后存入 `pending_logout`，
   由恢复线程重试，成功后作业才转为 `SUCCEEDED`。

原始二维码、token、完整上游响应不会入库；`pending_logout` 只保存加密恢复上下文。


## 传分接口（真实写操作，默认关闭）

`POST /v1/score-write-jobs` 把一张机台二维码 + 最多 5 条成绩交给
`packages/sdgb-client` 的 `transfer_score_with_qr`（与机器人命令、CLI 同一条实机验证过的
写入时序：换 token → isLogin 探测 → 登录 → 整包快照 → 模拟游玩等待 → `GetUserNewItemListApi`
结算 → `UpsertUserAllApi` → 登出）。Gateway 不另写一份实现。

```env
VW_SDGB_WRITE_ENABLED=1              # 需要 provider=sdgb_preview 或 sdgb_full（共用凭据组）
VW_SDGB_WRITE_MIN_INTERVAL_SEC=900   # 两次写入之间的最小间隔（机台 15 分钟小黑屋）
VW_SDGB_WRITE_JOB_TTL_SEC=1800       # 回执保留时长，必须覆盖整条写入链路
VW_SDGB_WRITE_QUEUE_CAPACITY=2       # 内存排队深度，满了返回 WRITE_QUEUE_FULL
```

请求（与验身接口同样的 HMAC 签名头）：

```json
{"qrCode":"<机台登录二维码字符串>","scores":["1234:4:1005000:4:5"],"confirm":true}
```

- `scores` 为 1~5 条 `MUSICID:LEVEL:ACHIEVEMENT[:COMBO[:SYNC]]`；`ACHIEVEMENT` 可写
  `1005000`、`100.5000` 或 `100.5%`。契约层只做形状校验，数值上下界由共享包
  `parse_score_specs` 在**换 token 之前**把守，非法成绩不会烧掉二维码。
- `confirm`（默认 `false`）为真时写入后回查账号谱面，确认达标才报 `SUCCEEDED`；
  共享包里的同名参数叫 `verify`，Gateway 侧改叫 `confirm` 以免和 TLS 校验开关混淆。

响应：`202 {"jobId":"…"}`，随后 `GET /v1/score-write-jobs/{jobId}` 轮询：

```json
{"status":"PROCESSING"}
{"status":"SUCCEEDED","writtenCount":2,"verified":true}
{"status":"FAILED","errorCode":"LOGIN_COOLDOWN"}
```

`verified=false` 表示“服务器已采纳提交但未回查”，不是失败。写入回执不含任何身份字段，
传分作业也无法通过 `/v1/verification-jobs/{id}` 读到（回执形状不同，按 `kind` 隔离）。

失败错误码：`LOGIN_COOLDOWN`（小黑屋）、`QR_EXCHANGE_FAILED`（换 token 失败/码无效）、
`UPSTREAM_REJECTED`（写接口返回空响应或异常 `returnCode`）、`SNAPSHOT_INCOMPLETE`
（前置快照查询失败，已中止上传）、`WRITE_NOT_CONFIRMED`（提交成功但回查未达标）、
`JOB_EXPIRED`、`JOB_INTERRUPTED`、`WRITE_QUEUE_FULL`、`SCORE_WRITE_DISABLED`。

运维纪律：

1. **一次一码**：每张机台二维码只够一次写入，成功登录即作废，因此队列**不重试**已提交的作业；
2. 作业按 `VW_SDGB_WRITE_MIN_INTERVAL_SEC` 串行执行（默认 900 秒），队列只在内存里持有二维码；
3. 进程重启时残留的 `PROCESSING` 写作业直接判 `JOB_INTERRUPTED`，绝不自动重放；
4. 原始二维码与成绩条目都不入库、不入日志，数据库只有作业状态行与公开回执；
5. 这是对真实账号的写入，只对有权操作的账号开放，且默认关闭。

## 真实 provider 安全要求

真实 provider 至少必须：

1. 使用你有权限的验证接口，不要提交未经授权的上游凭据；
2. 对上游请求施加超时、并发限制、重试与脱敏日志；
3. 只返回业务允许公开的最小资料；
4. 不持久化原始二维码、令牌、明文用户 ID 或完整上游响应；
5. 为需要恢复的作业保存经保护的最小状态，并验证进程重启后的行为；
6. 生产环境使用 HTTPS 或本机 loopback，并把环境文件权限设为 `0600`。

安全要求见根目录 [发布清单](../../docs/SECURITY.md)。
