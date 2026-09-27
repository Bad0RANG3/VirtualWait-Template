# services/bot — VirtualWait QQ 机器人（NoneBot2）

统一后的 QQ 机器人：B50 成绩图 + 写操作命令（来自 MaidXTool）+ VirtualWait 队列空闲 @ 通知
（由 AstrBot 插件移植，插件全部统一到 NoneBot2）。

## 架构

```
QQ ⇄ NapCat（OneBot v11 WS，127.0.0.1:3001）
     ⇄ NoneBot2（本目录 bot.py，加载 plugins/）
         ├─ plugins/b50.py         /help、/b50 与写命令 /fp /giveitem /score /map /chara
         └─ plugins/queue_notify.py  轮询 VirtualWait Web Bot API，机台空闲 @ 队首
```

共享 SDGB 客户端位于 `../../packages/sdgb-client`（自动注入 PYTHONPATH）。

## 安装

```bash
# Windows（PowerShell）
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# Linux / macOS
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 配置

复制 `.env.example` 为 `.env` 并填写：

- `ONEBOT_WS_URLS`：NapCat 正向 WebSocket 地址（默认 `ws://127.0.0.1:3001`）；
- `QUEUE_NOTIFY_BASE_URL` / `QUEUE_NOTIFY_BOT_TOKEN`：VirtualWait Web 地址与 Bot API token；
- `QUEUE_NOTIFY_DEFAULT_GROUP` / `QUEUE_NOTIFY_ROUTING`：提醒目标群（群号）。

SDGB 机厅配置：复制 `../../packages/sdgb-client/sdgb/settings_local.example.py`
为 `../../packages/sdgb-client/sdgb/settings_local.py` 并填写（或在环境变量中设置
`VW_SDGB_*`）。**本包不内置真实密钥**，缺失配置会直接报错；对 SDGB/AiMe 的请求
默认启用 TLS 证书校验；`token_cache.json`/`records_cache.json` 不落盘二维码与 token。

## 启动

```bash
python bot.py          # 或 start_bot.bat / start.sh / start_wrapper.py
```

NapCat 需先就绪（见根 README 与 infra 部署文档）。

## 命令

| 命令 | 说明 |
|------|------|
| `/help` | 全部命令说明 |
| `/b50 <二维码>` | 完整 B50 成绩图（每次新码，查完自动登出） |
| `/fp <二维码> [2~5]` | 发票（写操作，真实改账号数据；库存为 0 才下发） |
| `/giveitem <二维码> KIND:ID [...]` | 写道具 / 收藏品（写操作，一次最多 10 条） |
| `/score <二维码> MUSIC:LEVEL:ACH [...]` | 传分（写操作，一次最多 5 个谱面） |
| `/map <二维码> 区域ID\|区域名 [...]` | 跑区域（写操作；实机已证距离推不动，只用于量服务器幅度） |
| `/chara <二维码> 角色ID\|first [...]` | 写旅行伙伴槽位（写操作；1 个 ID 占满 5 槽） |
| `/vw_queue_status` | 队列通知插件轮询状态 |

> 全部写命令的格式示例、实机边界与小黑屋（isLogin=1）说明见 `./README_commands.md`，
> 写时序的机制说明见 `../../packages/sdgb-client/README.md`。