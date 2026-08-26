# 文档索引

| 文档 | 内容 |
|------|------|
| [架构与队列流程](ARCHITECTURE.md) | 拓扑、Web 模块地图、队列规则与 API 概览 |
| [模块手册](MODULES.md) | 全模块参考：lib/API 路由/页面/组件/脚本/Gateway/Infra/测试 |
| [模板定制](TEMPLATE.md) | 替换城市/场地/文案、身份接入、规则与测试 |
| [约束与红线](CONSTRAINTS.md) | 不得破坏的流程、密钥与敏感文件、架构和行为约束 |
| [安全与发布清单](SECURITY.md) | 密钥、数据、日志、部署与发布检查项 |
| [技术规格与上线验收](TECHNICAL_SPEC.md) | 系统边界、状态机、数据、安全、运维和验收标准 |
| [队列通知联动](QUEUE_NOTIFY.md) | QQ 绑定、Bot API、NoneBot2 插件与联调计划 |
| [运行流程与自托管部署](DEPLOYMENT.md) | 运行流程图、部署前准备、systemd/Nginx/QQ 机器人上线步骤 |
| [Web 应用说明](../apps/web/README.md) | 本地开发、页面、模块结构、管理能力、环境变量 |
| [Gateway 说明](../services/sdgb-gateway/README.md) | Mock / HTTP / `sdgb_preview` / `sdgb_full` 与签名边界 |
| [契约说明](../packages/contracts/README.md) | Gateway JSON Schema 与测试夹具 |
| [QQ 机器人说明](../services/bot/README.md) | NoneBot2 命令、队列通知插件与部署 |
| [共享 SDGB 客户端](../packages/sdgb-client/README.md) | 加密管道、二维码换码、B50 与写操作 |
| [自托管说明](../infra/server/README.md) | Nginx、systemd、环境样例与拓扑 |

一键门禁（仓库根目录）：

```bash
node scripts/verify-all.mjs
```
