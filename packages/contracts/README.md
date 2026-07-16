# Shared Contracts

此目录保存跨组件可共享的 JSON Schema，而不是上游身份服务的原始协议模型。

当前已落盘：

- `schemas/public-profile.schema.json`：公开资料的基础形状；
- `schemas/queue-entry-status.schema.json`：排队记录状态枚举。

此目录保存远程 Gateway 的 v1 JSON Schema 与正常、失败、处理中测试夹具。Web Zod 校验和 Python Gateway 测试共同验证这些文件；修改契约时必须同步更新两端实现、夹具与测试。

模板不包含真实二维码、用户资料或上游响应。新增夹具只能使用虚构的、不可识别的数据。

契约不得包含二维码、token、明文 userID、设备密钥或上游完整响应。破坏性字段变更必须提升版本或同时提供兼容层。
