#!/bin/sh
set -eu

# SDGB 配置检查：允许 settings_local.py 或 VW_SDGB_* 环境变量任一方式。
if [ ! -f /app/packages/sdgb-client/sdgb/settings_local.py ] && [ -z "${VW_SDGB_AES_KEY:-}" ]; then
    echo >&2 "[VirtualWait Bot] Missing SDGB config."
    echo >&2 "Copy packages/sdgb-client/sdgb/settings_local.example.py to packages/sdgb-client/sdgb/settings_local.py"
    echo >&2 "(or set VW_SDGB_* environment variables), then start the container again."
    exit 64
fi

mkdir -p "${B50_DATA_DIR:-/data}"
exec "$@"