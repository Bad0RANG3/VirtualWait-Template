# VirtualWait Template

一个可复用的城市级虚拟排队 Web 模板。目录按 **城市 → 区/县 → 场地 → 机台** 组织；仓库不含真实用户、二维码、令牌、密钥或运行数据库。

> 身份 Gateway 支持：`mock`（离线）、`http`（自有验证服务）、`sdgb_preview`（无登录二维码预览：AiMe 换 token + GetUserPreviewApi，不调 UserLoginApi）。接入真实上游前请自行完成授权、审计与安全测试。

## 包含内容

- Next.js 队列应用：城市分区导航、公开队列、单人/双人队列、用户会话和管理员运维；
- SQLite 持久化、审计日志、限流、同源写入校验和数据保留任务；
- 运行时可配置的超时、场地元数据与机台硬币数；
- Python 签名 Gateway：Mock / HTTP 适配器 / SDGB 无登录预览 provider；
- JSON Schema、E2E/浏览器测试和自托管配置样例。

默认示例：`示例市` → `示例区`/`示例县` → `示例中心店`（机台 A/B）与 `示例东城店`（机台 1）。请在首次部署前替换它们，位置见 [模板定制说明](docs/TEMPLATE.md)。

## 快速开始

需要 Node.js 22.5+。本地 Web 始终走签名 Gateway；Gateway 默认用 mock provider 接受 `mock:*` 二维码，不请求真实上游。

```bash
# 终端 1：签名 Gateway（mock provider）
cd services/sdgb-gateway
cp .env.example .env.local
PYTHONPATH=src python3 -m virtualwait_gateway

# 终端 2：Web
cd apps/web
cp .env.example .env.local
npm install
npm run dev
```

访问 <http://localhost:3000>，可用以下**示例**二维码登录：

```text
mock:demo-user:示例玩家:12000:示例称号
```

Web 与 Gateway 的 `GATEWAY_KEY_ID` / 共享密钥 / `PUBLIC_ID_HMAC_SECRET` 必须一致。运行数据会写入 `apps/web/data/` 与 Gateway 的 `data/`，均被 Git 忽略。

## 仓库结构

```text
apps/web/                Next.js 应用、队列 API 与 SQLite
services/sdgb-gateway/   签名 Gateway 与离线 Mock 提供者
packages/contracts/      Gateway JSON Schema 与测试夹具
infra/server/            Nginx、systemd 和环境变量样例
scripts/                 一键验证（verify-all.mjs）
docs/                    架构、模板定制与安全发布文档
```

## 文档

- [架构与队列流程](docs/ARCHITECTURE.md)：拓扑、模块地图、队列规则与 API 概览；
- [模板定制](docs/TEMPLATE.md)：替换场地、机台、文案和身份接入；
- [安全与发布清单](docs/SECURITY.md)：密钥、数据、日志和部署要求；
- [文档索引](docs/README.md)；
- [Web 应用说明](apps/web/README.md)；
- [Gateway 说明](services/sdgb-gateway/README.md)；
- [契约说明](packages/contracts/README.md)；
- [自托管说明](infra/server/README.md)。

## 发布模板前的检查

推荐一条命令跑完主要门禁（Web 单元/E2E/浏览器/构建 + Gateway 测试 + 部署样例检查）：

```bash
node scripts/verify-all.mjs
```

也可分步执行：

```bash
cd apps/web
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e
npm run test:browser
```

不要提交 `.env.local`、二维码原文、访问令牌、密钥、SQLite 数据库、备份或构建产物。发布前请执行 [安全清单](docs/SECURITY.md)。

免责声明：项目里面所有有关的API，均为互联网上获取的，使用者需要在下载后24小时内删除，相关责任不由项目主负责。
