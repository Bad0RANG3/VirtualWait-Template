# -*- coding: utf-8 -*-
"""sdgb.write_ops 写路径测试：机台实测时序（先结算本局再整包落库）与各入参解析。"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

_PKG_DIR = Path(__file__).resolve().parents[1]
if str(_PKG_DIR) not in sys.path:
    sys.path.insert(0, str(_PKG_DIR))

from sdgb.payload import CHARA_SLOT_API_TYPE  # noqa: E402
from sdgb.settings import musicData as _FB  # noqa: E402
from sdgb.write_ops import (  # noqa: E402
    _charge_list_patcher,
    _check_write_response,
    build_music_detail,
    derive_score_rank,
    normalize_items,
    normalize_scores,
    parse_item_specs,
    parse_score_specs,
    pick_session_music,
)

#: playlog / 结算包的版本（与 sdgb.payload.build_playlog 默认值一致）
VERSION = 1053000


# ---------------------------------------------------------------
# 入参解析
# ---------------------------------------------------------------

def test_parse_item_specs():
    assert parse_item_specs(["3:250103", "10:350001:2"]) == [
        (3, 250103, 1), (10, 350001, 2)
    ]


def test_parse_item_specs_rejects_bad_input():
    for bad in (["3"], ["3:1:2:3"], ["a:1"], ["99:1"], ["3:1:0"]):
        with pytest.raises(ValueError):
            parse_item_specs(bad)
    assert parse_item_specs(None) == []


def test_normalize_items_from_tuples_and_dicts():
    rows = normalize_items([
        (3, 250103),
        {"itemKind": 10, "itemId": 350001, "stock": 2},
    ])
    assert rows == [
        {"itemKind": 3, "itemId": 250103, "stock": 1, "isValid": True},
        {"itemKind": 10, "itemId": 350001, "stock": 2, "isValid": True},
    ]


def test_normalize_items_single_tuple():
    assert normalize_items((5, 123)) == [
        {"itemKind": 5, "itemId": 123, "stock": 1, "isValid": True}
    ]


def test_normalize_items_single_dict():
    assert normalize_items({"item_kind": 1, "item_id": 9}) == [
        {"itemKind": 1, "itemId": 9, "stock": 1, "isValid": True}
    ]


def test_normalize_items_dedupes():
    rows = normalize_items([(3, 1, 1), (3, 1, 9)])
    assert rows == [{"itemKind": 3, "itemId": 1, "stock": 9, "isValid": True}]


def test_normalize_items_empty_and_invalid():
    assert normalize_items(None) == []
    assert normalize_items([]) == []
    with pytest.raises(ValueError):
        normalize_items([123])


def test_check_write_response():
    _check_write_response({"returnCode": 1}, "Api")
    _check_write_response({"returnCode": 0}, "Api")
    with pytest.raises(RuntimeError, match="returnCode=500"):
        _check_write_response({"returnCode": 500}, "Api")
    with pytest.raises(RuntimeError, match="空响应"):
        _check_write_response({"_emptyResponse": True, "returnCode": 0}, "UpsertUserAllApi")


def test_charge_list_patcher_updates_and_appends():
    merge = _charge_list_patcher(3, stock=1)
    data = {"userChargeList": [{"chargeId": 3, "stock": 0}]}
    merge(data)
    assert data["userChargeList"][0]["stock"] == 1
    assert data["userChargeList"][0]["extNum1"] == 0

    data2: dict = {}
    merge(data2)
    assert data2["userChargeList"][0]["chargeId"] == 3


def test_parse_score_specs_accepts_percent_and_stored():
    assert parse_score_specs(["417:3:1010000"]) == [
        {"musicId": 417, "level": 3, "achievement": 1010000,
         "comboStatus": 0, "syncStatus": 0}
    ]
    assert parse_score_specs(["417:3:101.0000:4:4"])[0]["achievement"] == 1010000
    assert parse_score_specs(["417:3:100.5%:3"])[0] == {
        "musicId": 417, "level": 3, "achievement": 1005000,
        "comboStatus": 3, "syncStatus": 0,
    }


def test_parse_score_specs_rejects_bad_input():
    for bad in (["417:3"], ["417:3:1010000:9"], ["417:9:1010000"],
                ["417:3:2000000"], ["a:3:1010000", "417:3:0:1:9"]):
        with pytest.raises(ValueError):
            parse_score_specs(bad)
    assert parse_score_specs(None) == []


def test_normalize_scores_from_strings_dicts_and_dedup():
    rows = normalize_scores([
        "417:3:101.0000:4:4",
        {"music_id": 999, "level": 2, "achievement": 990000},
        "417:3:1000000",  # 同曲同难度，后者覆盖
    ])
    assert len(rows) == 2
    got = {r["musicId"]: r for r in rows}
    assert got[417]["achievement"] == 1000000
    assert got[999]["level"] == 2
    assert normalize_scores(None) == []
    with pytest.raises(ValueError):
        normalize_scores([123])


def test_derive_score_rank_and_build_music_detail():
    assert derive_score_rank(1010000) == 13
    assert derive_score_rank(990000) == 9
    assert derive_score_rank(0) == 0
    detail = build_music_detail(417, 1005000, level=4, combo_status=3, sync_status=5,
                                deluxscore_max=2277)
    assert detail == {
        "musicId": 417, "level": 4, "playCount": 1, "achievement": 1005000,
        "comboStatus": 3, "syncStatus": 5, "deluxscoreMax": 2277,
        "scoreRank": 12, "extNum1": 0,
    }
    assert build_music_detail(417, 1010000)["scoreRank"] == 13


def test_resolve_deluxscore_uses_machine_dx_scale():
    """deluxscoreMax 必须是机台刻度（音符数 * 3），否则成绩包会被丢弃。"""
    from sdgb.write_ops import _resolve_deluxscore

    db = {"853": {"charts": [{"notes": [1, 1, 1, 1]}, {"notes": [2, 2, 2, 2]},
                             {"notes": [384, 30, 37, 14]}]}}
    assert _resolve_deluxscore({"musicId": 853, "level": 2}, db) == 465 * 3
    assert _resolve_deluxscore({"musicId": 853, "level": 2, "deluxscoreMax": 1000}, db) == 1000
    assert _resolve_deluxscore({"musicId": 999, "level": 0}, db) == 0
    assert _resolve_deluxscore({"musicId": 853, "level": 2}, None) == 0


# ---------------------------------------------------------------
# 「本局」伪装
# ---------------------------------------------------------------

_DB = {"853": {"charts": [{"notes": [1, 1, 1, 1]}, {"notes": [2, 2, 2, 2]},
                          {"notes": [384, 30, 37, 14]}]}}

#: 账号自己的 B50 行（写道具时拿来伪装本局，避免伪造新成绩）
_RATING_ROWS = [{"musicId": 853, "level": 2, "romVersion": 24006, "achievement": 1010000}]


def test_pick_session_music_replays_own_record():
    """伪装的本局必须是账号已有记录：成绩不变，但判定/DX 自洽。"""
    snapshot = {"GetUserRatingApi": {"userRating": {"ratingList": _RATING_ROWS}}}
    known = {(853, 2): {"comboStatus": 4, "syncStatus": 4, "deluxscoreMax": 1395,
                        "scoreRank": 13, "playCount": 7}}
    row = pick_session_music(snapshot, _DB, fallback={"musicId": 417, "level": 3},
                              known=known)
    assert (row["musicId"], row["level"], row["achievement"]) == (853, 2, 1010000)
    assert (row["comboStatus"], row["syncStatus"], row["playCount"]) == (4, 4, 7)
    assert row["deluxscoreMax"] == 1395


def test_pick_session_music_skips_unknown_chart_and_falls_back():
    snapshot = {"GetUserRatingApi": {"userRating": {"ratingList": [
        {"musicId": 999999, "level": 3, "achievement": 1000000}, *_RATING_ROWS]}}}
    # 曲库里有音符数的谱面才会被选中（判定要能填满）
    assert pick_session_music(snapshot, _DB, fallback=_FB)["musicId"] == 853
    # 没有 B50 记录时退回配置曲目
    assert pick_session_music({}, _DB, fallback=_FB)["musicId"] == 417
    # 曲库缺失时无从判断音符数，取第一条已有记录（仍不会伪造新成绩）
    assert pick_session_music(snapshot, None, fallback=_FB)["musicId"] == 999999
    # 配置曲目残缺时宁可报错，也不发半成的包
    with pytest.raises(RuntimeError, match="musicData"):
        pick_session_music({}, _DB, fallback={"musicId": 417})


# ---------------------------------------------------------------
# 假客户端：记录所有 call_api，按实机行为回 canned 响应
# ---------------------------------------------------------------

class _NullCtx:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeClient:
    """假 MaimaiClient（只保留整包落库前置需要的读接口）。"""

    calls: list = []
    queries: list = []
    music: list = []
    rating_rows: list = []
    cookies: str | None = None   # 真实 client 登录前也是 None，登录后才有 JSESSIONID
    slots: list = []        # 服务器当前的 charaSlot
    locks: list = []        # 服务器当前的 charaLockSlot
    logged_in = False       # 登录前的 GetGameKaleidxScopeApi 不返回 userData（实测行为）
    user_data_read = False  # 本会话是否已 call 过 GetUserDataApi（机台报文：没读过就不回 userData）

    async def call_api(self, h, api, data, user_id, **kw):
        _FakeClient.calls.append((api, data))
        if api == "UserLoginApi":
            _FakeClient.logged_in = True
        if api == "UpsertUserAllApi":
            return {"returnCode": 1}
        if api == "GetUserDataApi":
            _FakeClient.user_data_read = True
            return {"userData": {"playerRating": 16355}}
        if api == "GetGameKaleidxScopeApi":
            #: 实机 + 机台报文规则：登录后 + 空请求体 + 本会话先 call 过 GetUserDataApi
            if not _FakeClient.logged_in or data or not _FakeClient.user_data_read:
                return {"userId": user_id, "gameKaleidxScopeList": []}
            return {"userId": user_id, "banState": 0, "userData": {
                "charaSlot": list(_FakeClient.slots),
                "charaLockSlot": list(_FakeClient.locks),
            }}
        return {
            "GetUserPreviewApi": {"isLogin": 0},
            "UserLoginApi": {"returnCode": 1, "loginId": 555,
                             "lastLoginDate": "2026-01-01 00:00:00.0"},
            "UploadUserPlaylogListApi": {"returnCode": 1},
            "UpsertUserChargelogApi": {"returnCode": 1},
            "GetUserNewItemListApi": {"userId": 42, "userItemList": []},
            "GetUserItemApi": {"userItemList": [], "nextIndex": 0},
            "GetUserChargeApi": {"userChargeList": [], "nextIndex": 0},
            "GetUserMusicApi": {
                "userMusicList": [{"userMusicDetailList": list(_FakeClient.music)}],
                "nextIndex": 0,
            },
            "UserLogoutApi": {"returnCode": 1},
        }.get(api, {})

    async def query(self, user_id, token, api_types=None, **kw):
        api_types = api_types or []
        _FakeClient.queries.append(list(api_types))
        out = {t: {} for t in api_types}
        if "GetUserDataApi" in out:
            out["GetUserDataApi"] = {"userData": {"playerRating": 16355}}
        if "GetUserRatingApi" in out:
            out["GetUserRatingApi"] = {"userRating": {"ratingList": list(_FakeClient.rating_rows)}}
        if CHARA_SLOT_API_TYPE in out:
            out[CHARA_SLOT_API_TYPE] = {"userData": {
                "charaSlot": list(_FakeClient.slots),
                "charaLockSlot": list(_FakeClient.locks),
            }}
        return out

    async def logout(self, user_id, **kw):
        _FakeClient.calls.append(("UserLogoutApi", kw))
        return {"returnCode": 1}


def _patch_write_env(monkeypatch, w):
    """把写流程的外部依赖（客户端 / 换码 / HTTP / 曲库 / 成绩缓存）换成假的。"""
    _FakeClient.calls = []
    _FakeClient.queries = []
    _FakeClient.music = []
    _FakeClient.slots = [101, 102, 103, 104, 105]
    _FakeClient.locks = [0, 0, 0, 0, 0]
    _FakeClient.logged_in = False
    _FakeClient.user_data_read = False
    _FakeClient.rating_rows = _RATING_ROWS
    # write_ops 在函数内 `from .sdgb import MaimaiClient`，所以要 patch 源模块属性
    monkeypatch.setattr("sdgb.sdgb.MaimaiClient", lambda *a, **kw: _FakeClient())
    monkeypatch.setattr(w, "_exchange", lambda qr: (42, "TOK"))
    monkeypatch.setattr(w.httpx, "AsyncClient", lambda **kw: _NullCtx())
    monkeypatch.setattr(w, "load_music_db", lambda: dict(_DB))
    monkeypatch.setattr(w, "cached_music_index", lambda uid: {})

    async def _nosleep(_seconds):
        return None

    monkeypatch.setattr(w.asyncio, "sleep", _nosleep)


def _upsert_packets():
    return [d for api, d in _FakeClient.calls if api == "UpsertUserAllApi"]


def _apis():
    return [api for api, _ in _FakeClient.calls]


# ---------------------------------------------------------------
# 写链路
# ---------------------------------------------------------------

def test_write_paths_query_chara_slot_api(monkeypatch):
    """整包落库前必须读角色槽位，否则会把账号的旅行伙伴写成默认值。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    asyncio.run(w.give_items_with_qr("QR", [(3, 250103)], sleep_seconds=0))

    assert _FakeClient.queries and all(CHARA_SLOT_API_TYPE in q for q in _FakeClient.queries)


def test_give_items_settles_then_writes_item_rows(monkeypatch):
    """写道具链路：同样先结算本局；isNewItemList 按行给标志，不伪造成绩行。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    msg = asyncio.run(w.give_items_with_qr(
        "QR", [(3, 250103), (10, 350001)], sleep_seconds=0,
    ))

    apis = _apis()
    assert apis.index("GetUserNewItemListApi") < apis.index("UpsertUserAllApi")
    upsert = _upsert_packets()[0]
    inner = upsert["upsertUserAll"]
    assert inner["userItemList"] == [
        {"itemKind": 3, "itemId": 250103, "stock": 1, "isValid": True},
        {"itemKind": 10, "itemId": 350001, "stock": 1, "isValid": True},
    ]
    assert inner["isNewItemList"] == "11"
    assert inner["userMusicDetailList"][0]["musicId"] == 853   # 不是伪造的 417
    assert upsert["userPlaylogList"][0]["tapCriticalPerfect"] == 384
    # 结算包用「本局之前」的计数，落库包才累加
    settle = next(d for api, d in _FakeClient.calls if api == "GetUserNewItemListApi")
    assert settle["userData"][0]["playCount"] == 0
    assert inner["userData"][0]["playCount"] == 1
    # 整包必须带账号真实的旅行伙伴，不能写回默认值
    assert inner["userData"][0]["charaSlot"] == [101, 102, 103, 104, 105]
    assert apis.count("UserLogoutApi") == 1
    assert "2 条道具" in msg


def test_give_items_merge_existing_marks_only_new_rows(monkeypatch):
    """merge_existing 时读回的既有道具按 "0" 镜像，只有本次新增标 "1"。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    _existing = [{"itemKind": 3, "itemId": 111, "stock": 1, "isValid": True}]

    async def _fake_fetch_items(client, h, user_id, token, kinds, cookie=None):
        return list(_existing)

    monkeypatch.setattr(w, "fetch_items", _fake_fetch_items)
    asyncio.run(w.give_items_with_qr(
        "QR", [(3, 250103)], sleep_seconds=0, merge_existing=True,
    ))
    inner = _upsert_packets()[0]["upsertUserAll"]
    assert inner["isNewItemList"] == "01"
    assert [r["itemId"] for r in inner["userItemList"]] == [111, 250103]


def test_transfer_score_writes_self_consistent_playlog(monkeypatch):
    """传分链路：成绩包必须带满判定 + 机台刻度 DX，回查达标才算成功。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    _FakeClient.music = [{"musicId": 853, "level": 2, "achievement": 1010000,
                          "comboStatus": 4, "syncStatus": 4, "deluxscoreMax": 1395,
                          "scoreRank": 13, "playCount": 1}]

    msg = asyncio.run(w.transfer_score_with_qr(
        "QR", ["853:2:101.0000:4:4"], sleep_seconds=0, verify=True,
        dx_max=True, music_db=dict(_DB),
    ))

    upsert = _upsert_packets()[0]
    playlog = upsert["userPlaylogList"][0]
    assert playlog["version"] == VERSION
    assert (playlog["musicId"], playlog["level"], playlog["achievement"]) == (853, 2, 1010000)
    assert playlog["tapCriticalPerfect"] == 384
    assert playlog["breakCriticalPerfect"] == 14
    assert (playlog["maxCombo"], playlog["totalCombo"], playlog["deluxscore"]) == (465, 465, 1395)

    # 机台实测时序：先 GetUserNewItemListApi 结算本局，再 UpsertUserAllApi 落库
    apis = _apis()
    assert apis.index("GetUserNewItemListApi") < apis.index("UpsertUserAllApi")
    settle = next(d for api, d in _FakeClient.calls if api == "GetUserNewItemListApi")
    assert settle["version"] == VERSION
    assert settle["userPlaylogList"] == upsert["userPlaylogList"]
    assert settle["userData"][0]["playCount"] == 0        # 结算包用「本局之前」的计数

    inner = upsert["upsertUserAll"]
    row = inner["userMusicDetailList"][0]
    assert (row["musicId"], row["level"], row["deluxscoreMax"]) == (853, 2, 1395)
    assert (row["comboStatus"], row["syncStatus"], row["scoreRank"]) == (4, 4, 13)
    assert inner["isNewMusicDetailList"] == "1"
    # 结算后累加本局计数（机台在两步之间做的事）
    ud = inner["userData"][0]
    assert (ud["playCount"], ud["currentPlayCount"], ud["lastPlayCredit"]) == (1, 1, 1)
    assert ud["totalAchievement"] == 1010000
    assert ud["totalExpertAchievement"] == 1010000        # level 2 = Expert
    assert ud["totalDeluxscore"] == ud["totalExpertDeluxscore"] == 1395
    assert msg.startswith("✅")


def test_query_sends_empty_body_for_chara_slot_api(monkeypatch):
    """MaimaiClient.query 对空体接口不能带 userId/token（带了服务器就不回 userData）。"""
    from sdgb import sdgb as sdgb_mod

    captured: list = []

    async def _spy(client, api, data, user_id, **kw):
        captured.append((api, data))
        return {"returnCode": 1}

    # 真实密钥只存在于本地 settings_local；测试里只需绕过构造期的加密封装
    monkeypatch.setattr(sdgb_mod, "aes_pkcs7", lambda *a, **kw: object())
    client = sdgb_mod.MaimaiClient()
    client.call_api = _spy
    asyncio.run(client.query(42, "TOK", api_types=[CHARA_SLOT_API_TYPE, "GetUserDataApi"]))
    got = dict(captured)
    assert got[CHARA_SLOT_API_TYPE] == {}
    assert got["GetUserDataApi"].get("userId") == 42


def test_snapshot_general_aborts_when_query_failed():
    """任一前置查询失败都必须中止：带伤上传会把 version 等字段写成兜底值导致 500。"""
    from sdgb.write_ops import _snapshot_general

    info = {t: {} for t in ["GetUserDataApi", CHARA_SLOT_API_TYPE]}
    info["GetUserDataApi"] = {"error": "boom"}
    import sdgb.write_ops as w

    with pytest.raises(RuntimeError, match="前置查询失败"):
        _snapshot_general({t: {"error": "boom"} if t == "GetUserDataApi" else {}
                           for t in w.API_ORDER})
    assert json.dumps({"a": 1})


def test_issue_ticket_still_writes_three_steps(monkeypatch):
    """发票链路保持原有三步组合：Chargelog -> playlog -> UpsertUserAll（库存镜像）。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    msg = asyncio.run(w.issue_ticket_with_qr("QR", charge_id=3, sleep_seconds=0))

    apis = _apis()
    assert apis.index("UpsertUserChargelogApi") < apis.index("UploadUserPlaylogListApi")
    assert apis.index("UploadUserPlaylogListApi") < apis.index("UpsertUserAllApi")
    charges = _upsert_packets()[0]["upsertUserAll"]["userChargeList"]
    assert charges and charges[0]["chargeId"] == 3 and charges[0]["stock"] == 1
    assert apis.count("UserLogoutApi") == 1
    assert "✅" in msg
