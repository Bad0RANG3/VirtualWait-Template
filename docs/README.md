# 文档索引

| 文档 | 内容 |
|------|------|
| [架构与队列流程](ARCHITECTURE.md) | 拓扑、账号与签到码流程、Web 模块地图、队列规则与 API 概览、升级注意 |
| [技术规格与上线验收](TECHNICAL_SPEC.md) | 系统边界、状态机、数据与保留策略、安全规格、质量门禁与验收清单 |
| [安全与发布清单](SECURITY.md) | 不可提交的数据、口令与签到码、密钥管理、网络与发布检查 |
| [约束与红线](CONSTRAINTS.md) | 不得破坏的配对密钥、账号与签到码纪律、架构与机器人约束 |
| [模块手册](MODULES.md) | 按目录列出各模块职责、API 路由、组件、脚本与测试索引 |
| [运行流程与自托管部署](DEPLOYMENT.md) | 部署方式、systemd/Nginx 步骤、升级与备份、日常维护与故障处置 |
| [模板定制指南](TEMPLATE.md) | 替换目录、品牌文案、身份与队列策略、发布前检查 |
| [队列监听与自动通知](QUEUE_NOTIFY.md) | Bot API 字段映射、通知判定、插件行为、群路由与联调测试矩阵 |

其他入口：

- 仓库根 [README](../README.md)：项目概览与快速开始；
- [apps/web/README](../apps/web/README.md)：Web 目录结构、命令与 API 清单；
- [infra/server/README](../infra/server/README.md)：Nginx / systemd 模板说明；
- [services/bot/README](../services/bot/README.md) 与 [DEPLOY](../services/bot/DEPLOY.md)：机器人配置与部署。

文档与实现冲突时，以代码与测试为准；请同时更新相关文档。
