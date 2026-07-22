# VirtualWait

VirtualWait 是一套面向机台场地的虚拟排队系统。用户通过网页查看队列、单人或双人排队并在队头确认上机；管理员负责场地和队列运营；内置 AstrBot 插件可在机台空闲时向队首发送 QQ 群 @ 提醒。

本仓库以一个完整项目发布，而非仅包含 Web 前端：Web、签名身份 Gateway、共享契约、自托管样例与 AstrBot 通知插件均是正式组成部分。

> 生产使用前必须完成真实身份服务的授权与安全审计。`mock` provider 仅用于本地开发和测试；不要提交二维码、令牌、密钥、运行数据库或真实用户资料。

## 能力概览

- 城市、区县、场地、机台四级目录与公开队列板；
- 单人/双人队列、队头确认上机、游玩超时回队尾、两次队头超时卸卡；
- 二维码身份流程、HttpOnly 会话、管理员运维台、审计和数据保留；
- Python 签名 Gateway：`mock`、自有 `http` provider、`sdgb_preview` 无登录预览；
- QQ 绑定和独立 Bot API，内置 AstrBot 队列空闲通知插件；
- SQLite、Nginx、systemd、备份/健康检查样例，以及单元、HTTP E2E、浏览器测试。

## 架构

```text
浏览器 -- HTTPS --> Web (Next.js + SQLite)
                         | HMAC
                         v
                  Gateway (Python)
                         |
                  已授权身份 provider

AstrBot 插件 -- Bearer --> Web Bot API -- QQ 群提醒 --> 队首
```

Web、Gateway、管理员和 Bot 使用独立的会话或密钥。Gateway 默认仅监听回环地址，不应直接暴露到公网。

## 仓库组成

| 路径 | 发布内容 |
|---|---|
| `apps/web/` | Next.js 应用、队列 API、管理员台、SQLite、Bot API |
| `services/sdgb-gateway/` | HMAC 签名身份 Gateway 与 provider 实现 |
| `plugins/astrbot_plugin_virtualwait_queue/` | AstrBot 队列空闲 QQ 通知插件 |
| `packages/contracts/` | Web 与 Gateway 的 JSON Schema、fixture |
| `infra/server/` | Nginx、systemd、环境变量与运维样例 |
| `docs/` | 架构、技术规格、安全、模板定制和联动文档 |
| `scripts/` | 全项目验证入口 |

## 运行要求

- Node.js `22.5+`
- Python `3.11+`
- SQLite（通过 Node 内置 `node:sqlite` 使用）
- 可选：AstrBot 与 `aiohttp`，用于 QQ 群通知
- 生产环境：TLS 反向代理、受限数据目录、备份和已授权的身份 provider

当前持久层为 SQLite，适合单城市或少量场地的**单机单实例**部署。多实例、高可用或跨机房部署前，需要先迁移到服务型数据库并重新进行并发和故障转移验证。

## 本地启动

默认链路完全离线：Web 调用本地 Gateway，Gateway 使用 `mock` provider 接受 `mock:*` 测试二维码。

```bash
# 终端 1：Gateway
cd services/sdgb-gateway
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
cp .env.example .env.local
PYTHONPATH=src python3 -m virtualwait_gateway
```

```bash
# 终端 2：Web
cd apps/web
cp .env.example .env.local
npm ci
npm run dev
```

访问 <http://localhost:3000>，使用以下虚构二维码登录：

```text
mock:demo-user:示例玩家:12000:示例称号
```

Web 与 Gateway 的 `GATEWAY_KEY_ID`、`GATEWAY_SHARED_SECRET`、`PUBLIC_ID_HMAC_SECRET` 必须保持一致。运行数据默认写入 `apps/web/data/` 和 `services/sdgb-gateway/data/`，均已被 Git 忽略。

## 启用 AstrBot 通知插件

插件随本仓库发布，路径为 `plugins/astrbot_plugin_virtualwait_queue/`。它不会读取公开队列接口中的个人信息，而是使用独立的 Bot API 获取队首 QQ。

1. 在 Web 的 `.env.local` 设置随机的 `BOT_API_TOKEN`，然后重启 Web。
2. 在 Web 管理台为每个需要通知的场地设置群 `UMO`。
3. 玩家在 `/me` 绑定 QQ 后才可加入队列。
4. 将插件目录安装或复制到 AstrBot 的插件目录，并在 AstrBot 环境安装其依赖：

```bash
cd plugins/astrbot_plugin_virtualwait_queue
pip install -r requirements.txt
```

5. 在 AstrBot 配置中填写 `base_url`、与 Web 完全相同的 `bot_token`，以及可选的 `default_umo` / `routing`。

插件按“目录摘要 -> 热机详情 -> 通知”三层轮询。它有启动预热、队首组合冷却、网络/429 指数退避和无 QQ 统计；同一队首不会在默认 5 分钟冷却期内被重复提醒。

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `poll_interval_sec` | `8` | 基础轮询间隔（秒） |
| `cooldown_sec` | `300` | 同一 QQ 组合的提醒冷却（秒） |
| `warmup_rounds` | `2` | 启动时仅建立缓存的轮数 |
| `default_umo` | 空 | 无场地路由时的兜底群 |

完整的字段映射、路由优先级、限流和测试矩阵见[队列通知联动文档](docs/QUEUE_NOTIFY.md)，插件安装细节见[插件 README](plugins/astrbot_plugin_virtualwait_queue/README.md)。

## 生产部署要点

1. 替换 `catalog.ts` 中全部示例城市、场地、机台和文案。
2. 使用独立随机值配置 `SESSION_SECRET`、`PUBLIC_ID_HMAC_SECRET`、`GATEWAY_SHARED_SECRET`、`ADMIN_API_TOKEN`、`BOT_API_TOKEN`；每项至少 32 字符，且不同环境不得复用。
3. 设置生产 `APP_BASE_URL`，通过 HTTPS 暴露 Web；Gateway 仅监听回环或私有受控网络。
4. 只有反向代理已清除并重写客户端转发 IP 头时，才设置 `TRUST_PROXY_HEADERS=true`。
5. 将 SQLite、WAL、备份和环境文件移出仓库并施加最小权限；安装维护、备份和健康检查 timer。
6. 接入真实 provider 前，完成接口授权、数据最小化、限流、超时与故障恢复测试。

部署文件和 systemd 安装步骤见[自托管说明](infra/server/README.md)，完整安全要求见[安全与发布清单](docs/SECURITY.md)。

## 验证

在仓库根目录运行一键门禁：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node scripts/verify-all.mjs
python3 -m unittest plugins/astrbot_plugin_virtualwait_queue/test_helpers.py
```

若 Playwright Chromium 已由 Playwright 管理，可省略 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。一键门禁包含 Web 生产预检、单元测试、HTTP E2E、浏览器测试、构建、Gateway 测试和部署样例检查；第二条命令验证插件的路由、冷却键和通知文案纯逻辑。

## 文档

- [技术规格与上线验收](docs/TECHNICAL_SPEC.md)：系统边界、状态机、数据、安全、运维与验收标准；
- [架构与队列流程](docs/ARCHITECTURE.md)：模块地图、队列规则和 API 概览；
- [队列通知联动](docs/QUEUE_NOTIFY.md)：QQ、Bot API、AstrBot 插件的完整联调规范；
- [模板定制](docs/TEMPLATE.md)：替换目录、品牌、规则和身份 provider；
- [安全与发布清单](docs/SECURITY.md)：密钥、数据、网络和发布要求；
- [文档索引](docs/README.md)：所有子模块文档入口。

## 安全与合规

本项目不会替你取得第三方接口或用户数据的使用授权。运营方负责确认身份服务、二维码处理、QQ 群通知和个人信息处理符合适用法律、平台规则与场地政策。公开接口不得包含 QQ；Bot API 应视为管理面并仅在受控网络路径使用。
