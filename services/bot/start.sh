#!/usr/bin/env bash
# B50 机器人 - 启动 NoneBot2（Linux / macOS）
set -e
cd "$(dirname "$0")"

PY="$PWD/.venv/bin/python"
if [ ! -x "$PY" ]; then
    PY="$(command -v python3 || command -v python || true)"
fi
if [ -z "$PY" ]; then
    echo "[B50 Bot] 未找到 Python：请先按 DEPLOY.md 建好 .venv" >&2
    exit 1
fi

echo "[B50 Bot] 启动 NoneBot2（Ctrl+C 停止）..."
exec "$PY" bot.py
