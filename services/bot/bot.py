# -*- coding: utf-8 -*-
"""VirtualWait QQ 机器人入口（NoneBot2 + OneBot v11）。

运行:
    python bot.py            # Windows：或双击 start_bot.bat
                             # Linux / macOS：bash start.sh

依赖 NapCat（OneBot 协议端）先启动并监听 ws://127.0.0.1:3001。
加载 plugins/ 下的全部插件：
- queue_notify：VirtualWait 机台空闲排队 @ 通知

机器人只与本部署内的 VirtualWait Web（`/api/bot/*`，Bearer token）通信，
不连接任何游戏服务器，也不处理登录二维码或写账号数据。
"""
import sys
from pathlib import Path

# Windows 控制台默认 GBK 无法输出 emoji/部分 UTF-8 字符（loguru 会报
# UnicodeEncodeError）；统一用 UTF-8 + replace 容错。
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE = Path(__file__).resolve().parent  # services/bot

if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

import nonebot
from nonebot.adapters.onebot.v11 import Adapter

nonebot.init()
driver = nonebot.get_driver()
driver.register_adapter(Adapter)
nonebot.load_plugins(str(BASE / "plugins"))

if __name__ == "__main__":
    nonebot.run()
