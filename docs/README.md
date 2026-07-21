# 文档索引

| 文档 | 内容 |
|------|------|
| [架构与队列流程](ARCHITECTURE.md) | 拓扑、Web 模块地图、队列规则与 API 概览 |
| [模板定制](TEMPLATE.md) | 替换城市/场地/文案、身份接入、规则与测试 |
| [安全与发布清单](SECURITY.md) | 密钥、数据、日志、部署与发布检查项 |
| [Web 应用说明](../apps/web/README.md) | 本地开发、页面、模块结构、管理能力、环境变量 |
| [Gateway 说明](../services/sdgb-gateway/README.md) | Mock / HTTP / `sdgb_preview` 与签名边界 |
| [契约说明](../packages/contracts/README.md) | Gateway JSON Schema 与测试夹具 |
| [自托管说明](../infra/server/README.md) | Nginx、systemd、环境样例与拓扑 |

一键门禁（仓库根目录）：

```bash
node scripts/verify-all.mjs
```
