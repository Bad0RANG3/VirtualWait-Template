# services/bot — VirtualWait QQ 机器人（NoneBot2）

只做一件事：轮询 VirtualWait Web 的 Bot API，机台空闲时在对应 QQ 群里 @ 队首提醒。
机器人**不连接任何游戏服务器**，不处理登录二维码，也不会读写任何账号数据。

## 架构

```
QQ ⇄ NapCat（OneBot v11 WS，127.0.0.1:3001）
     ⇄ NoneBot2（本目录 bot.py，加载 plugins/）
         └─ plugins/queue_notify.py  轮询 VirtualWait Web Bot API，机台空闲 @ 队首
```

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
- `QUEUE_NOTIFY_BASE_URL` / `QUEUE_NOTIFY_BOT_TOKEN`：VirtualWait Web 地址与 Bot API token
  （token 必须与 Web 的 `BOT_API_TOKEN` 一致）；
- `QUEUE_NOTIFY_DEFAULT_GROUP` / `QUEUE_NOTIFY_ROUTING`：提醒目标群（群号）。

## 启动

```bash
python bot.py          # 或 start_bot.bat / start.sh / start_wrapper.py
```

NapCat 需先就绪（见 [DEPLOY.md](DEPLOY.md) 与根 README）。

## 命令

| 命令 | 说明 |
|------|------|
| `/vw_queue_status` | 队列通知插件轮询状态 |

通知行为、路由优先级、冷却与限流细节见 [../../docs/QUEUE_NOTIFY.md](../../docs/QUEUE_NOTIFY.md)。
