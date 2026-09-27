#!/bin/sh
set -eu

# 开箱即用：SDGB 默认参数已内置在 packages/sdgb-client/sdgb/settings.py，
# 无需任何配置即可启动；只需扫码登录机器人 QQ。
# 换机厅/换版本时可用 VW_SDGB_* 环境变量覆盖，或挂载 settings_local.py。
mkdir -p "${B50_DATA_DIR:-/data}"
exec "$@"