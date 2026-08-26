# -*- coding: utf-8 -*-
"""NoneBot 守护进程：崩溃（含 WS 断开）后自动重启，日志落盘。

Windows / Linux / macOS 通用。用法: python start_wrapper.py（建议在当前目录的 .venv 里运行）
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "bot_wrapper.log"


def _venv_python() -> str:
    """优先当前解释器（已在 venv 里运行）；否则找当前目录 .venv 里的 python。"""
    if Path(sys.executable).resolve().parent.name in ("Scripts", "bin"):
        return sys.executable
    for cand in (
        ROOT / ".venv" / "bin" / "python",          # Linux / macOS
        ROOT / ".venv" / "Scripts" / "python.exe",  # Windows
    ):
        if cand.exists():
            return str(cand)
    return sys.executable


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def main() -> None:
    py = _venv_python()
    while True:
        log(f"启动 NoneBot（{py}）...")
        try:
            proc = subprocess.Popen(
                [py, "bot.py"],
                cwd=str(ROOT),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:  # noqa: BLE001
            log(f"启动失败: {e}，5 秒后重试")
            time.sleep(5)
            continue
        log(f"NoneBot PID={proc.pid} 运行中")
        proc.wait()
        code = proc.returncode
        log(f"NoneBot 退出 (code={code})，5 秒后自动重启")
        time.sleep(5)


if __name__ == "__main__":
    main()
