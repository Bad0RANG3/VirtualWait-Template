# -*- coding: utf-8 -*-
"""NapCat 守护进程：QQ/NapCat 崩溃后自动重启（快速登录）。

- Windows：注入桌面 QQ 启动（NapCatWinBootMain.exe）
- Linux / macOS：node 运行 napcat.mjs（需预装 NapCat shell 目录）
用法: python napcat_guard.py
"""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHELL = ROOT / "napcat" / "shell"
LOG = ROOT / "napcat_guard.log"
ACCOUNT = "3873569766"  # 机器人 QQ 号（NapCat 快速登录账号）
IS_WINDOWS = sys.platform.startswith("win")


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def env() -> dict:
    e = os.environ.copy()
    e["NAPCAT_PATCH_PACKAGE"] = str(SHELL / "qqnt.json")
    e["NAPCAT_LOAD_PATH"] = str(SHELL / "loadNapCat.js")
    if IS_WINDOWS:
        e["NAPCAT_INJECT_PATH"] = str(SHELL / "NapCatWinBootHook.dll")
        e["NAPCAT_LAUNCHER_PATH"] = str(SHELL / "NapCatWinBootMain.exe")
        e["NAPCAT_MAIN_PATH"] = str(SHELL / "napcat.mjs").replace("\\", "/")
    else:
        e["NAPCAT_MAIN_PATH"] = str(SHELL / "napcat.mjs")
    e["NAPCAT_QUICK_ACCOUNT"] = ACCOUNT
    return e


def kill_qq() -> None:
    """清理残留进程（QQ NT 单实例限制 / NapCat 旧进程）。"""
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/f", "/im", "QQ.exe"],
                       capture_output=True, check=False)
        subprocess.run(["taskkill", "/f", "/im", "QQEX.exe"],
                       capture_output=True, check=False)
    else:
        subprocess.run(["pkill", "-f", "napcat.mjs"], check=False)


def launch_cmd() -> list:
    if IS_WINDOWS:
        return [str(SHELL / "NapCatWinBootMain.exe"),
                r"C:\Program Files\Tencent\QQNT\QQ.exe",
                str(SHELL / "NapCatWinBootHook.dll")]
    return ["node", str(SHELL / "napcat.mjs")]


def main() -> None:
    while True:
        kill_qq()
        time.sleep(2)

        log("启动 NapCat...")
        try:
            proc = subprocess.Popen(
                launch_cmd(),
                cwd=str(SHELL), env=env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:  # noqa: BLE001
            log(f"启动失败: {e}，10 秒后重试")
            time.sleep(10)
            continue
        log(f"NapCat PID={proc.pid} 运行中")
        proc.wait()
        log(f"NapCat 退出 (code={proc.returncode})，10 秒后自动重启")
        time.sleep(10)


if __name__ == "__main__":
    main()
