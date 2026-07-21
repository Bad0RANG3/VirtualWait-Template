# 身份 Gateway

此目录提供 Web 与身份服务之间的签名边界实现：HMAC、时间戳、nonce、请求摘要、限流与 SQLite 作业状态。

Gateway 现在支持三种 provider：

- `mock`：离线测试 provider，只接受 `mock:*` 二维码；
- `http`：真实二维码 provider 适配器，把二维码转发给你自己配置的授权验证服务；
- `sdgb_preview`：无登录预览链路（AiMe 扫码换 `userId/token`，再调 `GetUserPreviewApi`）。**不会**调用 `UserLoginApi` / `UserLogoutApi`，因此不会占用机台登录态。

## 本地 Mock 运行

```bash
cd services/sdgb-gateway
cp .env.example .env.local
PYTHONPATH=src python3 -m virtualwait_gateway
PYTHONPATH=src pytest -q
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

## 真实 provider 安全要求

真实 provider 至少必须：

1. 使用你有权限的验证接口，不要提交未经授权的上游凭据；
2. 对上游请求施加超时、并发限制、重试与脱敏日志；
3. 只返回业务允许公开的最小资料；
4. 不持久化原始二维码、令牌、明文用户 ID 或完整上游响应；
5. 为需要恢复的作业保存经保护的最小状态，并验证进程重启后的行为；
6. 生产环境使用 HTTPS 或本机 loopback，并把环境文件权限设为 `0600`。

安全要求见根目录 [发布清单](../../docs/SECURITY.md)。
