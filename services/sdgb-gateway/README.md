# 身份 Gateway 模板（Mock）

此目录提供 Web 与身份服务之间的签名边界实现：HMAC、时间戳、nonce、请求摘要、限流与 SQLite 作业状态。仓库只实现离线 Mock 提供者，不能用于真实身份认证。

## 本地运行

```bash
cd services/sdgb-gateway
cp .env.example .env.local
PYTHONPATH=src python3 -m virtualwait_gateway
PYTHONPATH=src pytest -q
```

默认仅监听 `127.0.0.1:8787`。若 Web 使用 `GATEWAY_MODE=remote`，两端的 key ID、共享密钥和公开身份 HMAC 密钥必须一致；本地 `.env.local` 不得提交。

## 真实提供者接入要求

在实现、授权和审计完成前，不要把任何真实二维码提交给此服务。真实提供者至少必须：

1. 校验来自 Web 的 HMAC、时间戳、nonce 和请求摘要；
2. 对上游请求施加超时、并发限制、重试与脱敏日志；
3. 只返回业务允许公开的最小资料；
4. 不持久化原始二维码、令牌、明文用户 ID 或完整上游响应；
5. 为需要恢复的作业保存经保护的最小状态，并验证进程重启后的行为；
6. 通过独立安全审计后，才允许生产启动。

模板当前在生产环境会拒绝启动，防止 Mock 被误用。安全要求见根目录 [发布清单](../../docs/SECURITY.md)。
