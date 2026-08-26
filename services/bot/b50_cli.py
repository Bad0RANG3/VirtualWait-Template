# -*- coding: utf-8 -*-
"""B50 成绩图 CLI（调试用；日常使用走 QQ 机器人 /b50）。

用法:
    python b50_cli.py --uid 1234567          # 免登录：直接按 userId 拉取渲染（推荐）
    python b50_cli.py --qr "<二维码字符串>"  # 扫码拉取（--full 加徽标）
    python b50_cli.py --full --qr "<二维码>" # 增强渲染：带 FC/AP/同步/DX 徽标（登录态，查完必登出）
    python b50_cli.py --out b50.png          # 指定输出路径
    python b50_cli.py --version "PRiSM PLUS" # 指定渲染版本标签
    python b50_cli.py --region cn            # jp|intl|cn|_generic

凭证纪律：登录态拉取必须 --qr 新二维码换新 token；查询结束必登出。
"""
import argparse
import asyncio
import sys

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

_BOT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BOT_DIR.parent.parent
for _p in (str(_BOT_DIR), str(_REPO_ROOT / "packages" / "sdgb-client")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import httpx

from sdgb.b50 import (
    fetch_b50_payload_public,
    load_music_db,
    render_oneshot,
    save_png,
)
from sdgb.records import (
    exchange_qr,
    fetch_b50_payload_full,
    login_with_token,
    logout_session,
)
from sdgb.sdgb import MaimaiClient


async def render_public(db: dict, user_id: int, args) -> None:
    """免登录：按 userId 直查（无需二维码）。"""
    client = MaimaiClient()
    async with httpx.AsyncClient() as http:  # 启用 TLS 证书校验
        payload = await fetch_b50_payload_public(client, http, user_id, db)
        b35 = len(payload["calculatedEntries"]["b35"])
        b15 = len(payload["calculatedEntries"]["b15"])
        print(f"[免登录] userId={user_id}: B35={b35} 条, B15={b15} 条, 渲染中...")
        img = await render_oneshot(payload)
        save_png(img, args.out)
    print("完成 ✅")


async def render_live(db: dict, args) -> None:
    """扫码拉取：--qr 换 token；--full 时登录 -> 查询 -> 登出。"""
    if not args.qr:
        raise SystemExit(
            "扫码拉取需要 --qr <新二维码>；免登录查询请用 --uid <userId>"
        )
    client = MaimaiClient()
    async with httpx.AsyncClient() as http:  # 启用 TLS 证书校验
        user_id, token, _preview = await exchange_qr(client, http, args.qr)
        print(f"[换token] userID={user_id}（仅本次使用）")

        if args.full:
            print("[full] 增强模式：B50 将合并 FC/AP/同步/DX 徽标")
            login_ts = await login_with_token(client, http, user_id, token)
            try:
                payload = await fetch_b50_payload_full(
                    client, http, user_id, token, db,
                    version=args.version, region=args.region,
                )
            finally:
                # 查询结束必登出（回传登录时刻，服务器按此校验会话）
                await logout_session(client, http, user_id, timestamp=login_ts)
                print("[登出] ✅")
        else:
            from sdgb.b50 import fetch_b50_payload

            payload = await fetch_b50_payload(client, http, user_id, token, db)

        b35 = len(payload["calculatedEntries"]["b35"])
        b15 = len(payload["calculatedEntries"]["b15"])
        print(f"[拉取] B35={b35} 条, B15={b15} 条, 渲染中...")
        img = await render_oneshot(payload)
        save_png(img, args.out)
        print("完成 ✅")


def main():
    ap = argparse.ArgumentParser(description="B50 成绩图生成")
    ap.add_argument("--uid", type=int, help="maimai userId（免登录直接查询，推荐）")
    ap.add_argument("--qr", help="二维码字符串（扫码拉取；--full 时登录态）")
    ap.add_argument("--full", action="store_true", help="增强渲染（FC/AP/同步/DX 徽标，需登录）")
    ap.add_argument("--out", default="b50.png", help="输出图片路径（默认 b50.png）")
    ap.add_argument("--version", default="PRiSM PLUS", help="渲染版本标签")
    ap.add_argument("--region", default="cn", choices=["jp", "intl", "cn", "_generic"])
    args = ap.parse_args()

    db = load_music_db()
    print(f"[曲库] {len(db)} 首")
    if args.uid:
        asyncio.run(render_public(db, args.uid, args))
    else:
        asyncio.run(render_live(db, args))


if __name__ == "__main__":
    main()
