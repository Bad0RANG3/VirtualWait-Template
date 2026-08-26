# -*- coding: utf-8 -*-
"""VirtualWait QQ 机器人入口（NoneBot2 + OneBot v11）。

运行:
    python bot.py            # Windows：或双击 start_bot.bat
                             # Linux / macOS：bash start.sh

依赖 NapCat（OneBot 协议端）先启动并监听 ws://127.0.0.1:3001。
加载 plugins/ 下的全部插件：
- b50：/b50 成绩图、/fp 发票、/help
- queue_notify：VirtualWait 机台空闲排队 @ 通知
"""
import sys
from pathlib import Path

# Windows 控制台默认 GBK 无法输出 emoji/部分 UTF-8 字符（loguru 会报
# UnicodeEncodeError）；统一用 UTF-8 + replace 容错。
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE = Path(__file__).resolve().parent           # services/bot
REPO_ROOT = BASE.parent.parent                    # 仓库根
SDGB_CLIENT = REPO_ROOT / "packages" / "sdgb-client"

# 保证能 import 共享 sdgb 包（packages/sdgb-client）与本目录
for _p in (str(REPO_ROOT), str(SDGB_CLIENT), str(BASE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import nonebot
from nonebot.adapters.onebot.v11 import Adapter

nonebot.init()
driver = nonebot.get_driver()
driver.register_adapter(Adapter)
nonebot.load_plugins(str(BASE / "plugins"))

if __name__ == "__main__":
    nonebot.run()