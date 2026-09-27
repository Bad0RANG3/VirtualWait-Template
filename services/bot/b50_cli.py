# -*- coding: utf-8 -*-
"""B50 成绩图 + 写操作 CLI（调试用；日常使用走 QQ 机器人）。

用法:
    python b50_cli.py --uid 1234567          # 免登录：直接按 userId 拉取渲染（推荐）
    python b50_cli.py --qr "<二维码字符串>"  # 扫码拉取（--full 加徽标）
    python b50_cli.py --full --qr "<二维码>" # 增强渲染：带 FC/AP/同步/DX 徽标（登录态，查完必登出）
    python b50_cli.py --out b50.png          # 指定输出路径
    python b50_cli.py --version "PRiSM PLUS" # 指定渲染版本标签
    python b50_cli.py --region cn            # jp|intl|cn|_generic

写操作（真实写入账号，只对自己的账号使用；每次都要新二维码）:
    python b50_cli.py --qr "<码>" --give-item 3:250103 --give-item 10:350001:2
    python b50_cli.py --qr "<码>" --score 417:3:101.0000:4:4 --dx-max --verify
    python b50_cli.py --qr "<码>" --complete-map 200001 --map-plays 3 --map-rounds 4
    python b50_cli.py --qr "<码>" --chara 302          # 让 302 占满 5 个槽位
    python b50_cli.py --qr "<码>" --chara first        # 用当前第一个伙伴占满 5 槽

凭证纪律：登录态拉取必须 --qr 新二维码换新 token；查询结束必登出。
写命令同理：一旦 UserLoginApi 成功，这个码就废了（哪怕后面没发写包）；
只在换 token 阶段就失败（还没登录）时可以试着重用同一个码。
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


def _progress(text: str) -> None:
    print(f"  · {text}", flush=True)


async def give_items(args) -> None:
    from sdgb.write_ops import give_items_with_qr, parse_item_specs

    try:
        items = parse_item_specs(args.give_item)
    except ValueError as e:
        raise SystemExit(f"--give-item 格式错误：{e}") from e
    print(f"[写道具] {len(items)} 条（真实写操作，请确认是自己的账号）")
    print(await give_items_with_qr(
        args.qr, items, merge_existing=args.merge_existing, verify=args.verify,
        progress=_progress,
    ))


async def transfer_scores(args) -> None:
    from sdgb.write_ops import transfer_score_with_qr

    print(f"[传分] {len(args.score)} 个谱面（真实写操作，请确认是自己的账号）")
    print(await transfer_score_with_qr(
        args.qr, args.score, verify=args.verify, dx_max=args.dx_max, progress=_progress,
    ))


async def complete_maps(args) -> None:
    from sdgb.write_ops import complete_maps_with_qr, parse_map_specs

    try:
        specs = parse_map_specs(args.complete_map)
    except ValueError as e:
        raise SystemExit(f"--complete-map 格式错误：{e}") from e
    print(f"[跑区域] {len(specs)} 个 -> "
          + ("直接构建地图数据（一次写成目标值，不认换新增行）"
             if args.map_jump else "分档推进距离到终点")
          + "，不写收藏品（真实写操作）")
    print(await complete_maps_with_qr(
        args.qr, args.complete_map, verify=not args.no_verify,
        is_new_map_flag=args.map_flag,
        plays=args.map_plays, rounds=args.map_rounds, jump=args.map_jump,
        progress=_progress,
    ))


async def set_charas(args) -> None:
    from sdgb.write_ops import is_current_first, parse_chara_ids, set_chara_slots_with_qr

    if is_current_first(args.chara):
        target = "账号当前第一个伙伴 ×5（登录后读回）"
    else:
        try:
            target = str(parse_chara_ids(args.chara))
        except ValueError as e:
            raise SystemExit(f"--chara 格式错误：{e}") from e
    print(f"[写伙伴] 目标槽位 {target}（真实写操作，请确认是自己的账号）")
    print(await set_chara_slots_with_qr(
        args.qr, args.chara, verify=not args.no_verify, progress=_progress,
    ))


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="B50 成绩图生成 / 写操作")
    ap.add_argument("--uid", type=int, help="maimai userId（免登录直接查询，推荐）")
    ap.add_argument("--qr", help="二维码字符串（扫码拉取；--full / 写命令时必需）")
    ap.add_argument("--full", action="store_true", help="增强渲染（FC/AP/同步/DX 徽标，需登录）")
    ap.add_argument("--out", default="b50.png", help="输出图片路径（默认 b50.png）")
    ap.add_argument("--version", default="PRiSM PLUS", help="渲染版本标签")
    ap.add_argument("--region", default="cn", choices=["jp", "intl", "cn", "_generic"])
    ap.add_argument("--give-item", action="append", metavar="KIND:ID[:STOCK]",
                    help="给账号写入道具/收藏品（可重复；需配合 --qr）")
    ap.add_argument("--score", action="append", metavar="MUSICID:LEVEL:ACH[:COMBO[:SYNC]]",
                    help="传分：写入成绩（可重复；需配合 --qr）")
    ap.add_argument("--dx-max", action="store_true",
                    help="传分时按曲库音符数把 DX 分补成该谱面上限")
    ap.add_argument("--complete-map", action="append", metavar="MAPID|区域名[:目标距离]",
                    help="跑区域：按档把指定区域的距离推到终点（可重复；需配合 --qr）")
    ap.add_argument("--map-flag", default="0", choices=["0", "1"],
                    help='isNewMapList 标志：0=更新已有区域（默认），1=按新增行写入')
    ap.add_argument("--map-plays", type=int, default=3, metavar="N",
                    help="跑区域每档伪装几局（默认 3；每档幅度 N*10000）")
    ap.add_argument("--map-rounds", type=int, default=4, metavar="N",
                    help="一次登录内最多跑几档（默认 4，每档都要结算 + 落库 + 回查）")
    ap.add_argument("--map-jump", action="store_true",
                    help="直接构建地图数据：distance 一次写成目标值并置 isComplete，"
                         "不被采纳时换 isNewMapList=1 再试一次")
    ap.add_argument("--chara", action="append", metavar="CHARAID[,...]|first",
                    help="写旅行伙伴槽位：给 1 个 ID 占满 5 槽，给 5 个按槽序，"
                         "first=用当前第一个伙伴占满 5 槽")
    ap.add_argument("--merge-existing", action="store_true",
                    help="写入前读回现有道具并合并（更贴近完整快照）")
    ap.add_argument("--no-verify", action="store_true",
                    help="跑区域/写伙伴时跳过写后回查（默认回查）")
    ap.add_argument("--verify", action="store_true",
                    help="写后回查确认（--give-item / --score 时）")
    return ap


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.give_item or args.score or args.complete_map or args.chara:
        if not args.qr:
            raise SystemExit(
                "--give-item / --score / --complete-map / --chara 需要 --qr <新二维码>"
            )
        if args.give_item:
            asyncio.run(give_items(args))
        if args.score:
            asyncio.run(transfer_scores(args))
        if args.complete_map:
            asyncio.run(complete_maps(args))
        if args.chara:
            asyncio.run(set_charas(args))
        return
    db = load_music_db()
    print(f"[曲库] {len(db)} 首")
    if args.uid:
        asyncio.run(render_public(db, args.uid, args))
    else:
        asyncio.run(render_live(db, args))


if __name__ == "__main__":
    main()
