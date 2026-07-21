# Shared Contracts

跨组件可共享的 JSON Schema 与测试夹具，描述 **Web ↔ Gateway** 边界，而不是上游身份服务的原始协议。

Web（Zod）与 Python Gateway 测试共同校验这些文件。修改契约时必须同步更新两端实现、夹具与测试。

## Schemas（`schemas/`）

| 文件 | 用途 |
|------|------|
| `verification-job-create-request.v1.schema.json` | 创建验证作业请求 |
| `verification-job-create-response.v1.schema.json` | 创建验证作业响应 |
| `verification-job-response.v1.schema.json` | 作业查询响应（处理中/成功/失败） |
| `gateway-error.v1.schema.json` | Gateway 错误体 |
| `public-profile.schema.json` | 允许公开的最小资料形状 |
| `queue-entry-status.schema.json` | 排队记录状态枚举 |

## Fixtures（`fixtures/`）

| 文件 | 场景 |
|------|------|
| `verification-job-create-request.v1.json` | 合法创建请求样例 |
| `verification-job-create-response.v1.json` | 创建成功响应 |
| `verification-job-processing.v1.json` | 处理中 |
| `verification-job-succeeded.v1.json` | 成功（含匿名 subject + profile） |
| `verification-job-failed.v1.json` | 失败 |
| `gateway-error-replay.v1.json` | 重放/校验类错误 |

## 约束

- 模板不包含真实二维码、用户资料或上游响应；夹具只能使用虚构、不可识别的数据。
- 契约不得包含二维码、token、明文 userID、设备密钥或上游完整响应。
- 破坏性字段变更必须提升版本（如 `v2`）或同时提供兼容层。
