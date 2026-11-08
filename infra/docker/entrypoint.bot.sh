#!/bin/sh
set -eu

# VirtualWait 机器人启动前无需任何配置准备：只通过环境变量读取
# VirtualWait Web 地址与 Bot API token，然后连接 NapCat 的 OneBot WebSocket。
exec "$@"
