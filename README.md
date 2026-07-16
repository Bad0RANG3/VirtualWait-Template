# VirtualWait

河源坚基动漫E族的舞萌虚拟排队 Web 应用。仓库不包含真实用户、二维码、令牌、密钥或运行数据库。

> 当前身份 Gateway 只提供离线 Mock，用于本地开发和集成测试。接入任何真实身份服务前，必须自行完成授权、实现、审计和安全测试。

## 包含内容

- Next.js 队列应用：公开队列、单人/双人队列、用户会话和管理员运维；
- SQLite 持久化、审计日志、限流、同源写入校验和数据保留任务；
- Python 签名 Gateway 与离线 Mock 提供者；
- JSON Schema、E2E/浏览器测试和自托管配置样例。

当前场地为 `河源坚基动漫E族`，包含 `旧机`、`新机`；两者仅按引进时间先后区分，不代表规则或性能差异。

## 快速开始

需要 Node.js 22 LTS（`>=22.5 <23`）。本地默认使用 Mock，不会请求真实上游服务。

```bash
cd apps/web
cp .env.example .env.local
npm install
npm run dev
```

访问 <http://localhost:3000>，可用以下**示例**二维码登录：

```text
mock:demo-user:示例玩家:12000:示例称号
```

运行数据会写入 `apps/web/data/`，该目录及所有 SQLite 文件均被 Git 忽略。

## 仓库结构

```text
apps/web/                Next.js 应用、队列 API 与 SQLite
services/sdgb-gateway/   签名 Gateway 与离线 Mock 提供者
packages/contracts/      Gateway JSON Schema 与测试夹具
infra/server/            Nginx、systemd 和环境变量样例
docs/                    模板定制与安全发布文档
```

## 文档

- [模板定制](docs/TEMPLATE.md)：场地、机台、文案和身份接入配置；
- [安全与发布清单](docs/SECURITY.md)：密钥、数据、日志和部署要求；
- [Web 应用说明](apps/web/README.md)；
- [Gateway 说明](services/sdgb-gateway/README.md)；
- [自托管说明](infra/server/README.md)。

## 部署前检查

```bash
cd apps/web
npm run lint
npx tsc --noEmit
npm test
```

不要提交 `.env.local`、二维码原文、访问令牌、密钥、SQLite 数据库、备份或构建产物。发布前请执行 [安全清单](docs/SECURITY.md)。

免责声明：项目里面所有有关的API，均为互联网上获取的，使用者需要在下载后24小时内删除，相关责任不由项目主负责。
