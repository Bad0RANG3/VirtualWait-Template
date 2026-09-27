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
    map_step_rows,
    normalize_items,
    normalize_scores,
    parse_chara_ids,
    parse_item_specs,
    parse_map_specs,
    parse_score_specs,
    pick_session_music,
    plan_map_goals,
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


def test_parse_chara_ids_fills_or_rejects():
    assert parse_chara_ids(["302"]) == [302] * 5
    assert parse_chara_ids(["300103,350103", "302 350706 150104"]) == [
        300103, 350103, 302, 350706, 150104
    ]
    with pytest.raises(ValueError, match="不是角色 ID"):
        parse_chara_ids(["abc"])
    with pytest.raises(ValueError, match="占满"):
        parse_chara_ids(["1", "2"])


# ---------------------------------------------------------------
# 区域（userMapList）
# ---------------------------------------------------------------

_EXISTING = [
    {"mapId": 200001, "distance": 0, "isLock": False,
     "isClear": False, "isComplete": False, "unlockFlag": 0},
    {"mapId": 550001, "distance": 30000, "isLock": True,
     "isClear": False, "isComplete": False, "unlockFlag": 2},
    {"mapId": 999001, "distance": 1234, "isLock": False,
     "isClear": False, "isComplete": False, "unlockFlag": 0},
]


def test_parse_map_specs_resolves_machine_goal_and_dedupe():
    assert parse_map_specs(["200001", "550001:900000"]) == [
        {"mapId": 200001, "distance": 800000},
        {"mapId": 550001, "distance": 900000},
    ]
    assert parse_map_specs(["200001:1", "200001"]) == [{"mapId": 200001, "distance": 800000}]
    assert parse_map_specs(None) == []
    # 机台距离表没收录的区域：保持 None，只能一步置完成标志
    assert parse_map_specs(["999001"]) == [{"mapId": 999001, "distance": None}]


def test_parse_map_specs_rejects_bad_input():
    for bad in (["a"], ["200001:1:2"], ["-1"], ["200001:-5"], ["12.5"]):
        with pytest.raises(ValueError):
            parse_map_specs(bad)


def test_parse_map_specs_resolves_region_name():
    assert parse_map_specs(["龙之区域4"]) == [{"mapId": 550002, "distance": 1200000}]
    assert parse_map_specs(["龙之区域4:1200000"]) == [{"mapId": 550002, "distance": 1200000}]


def test_plan_map_goals_uses_machine_goal_and_skips_completed():
    existing = [
        *_EXISTING,
        {"mapId": 39, "distance": 200000, "isLock": False,
         "isClear": False, "isComplete": True, "unlockFlag": 0},
    ]
    goals, done = plan_map_goals(existing, parse_map_specs(["200001", "999001", "39"]))
    assert goals == {200001: 800000, 999001: None}   # 999001 不在机台数据里：只置完成
    assert done == [39]


def test_plan_map_goals_rejects_unknown_map():
    with pytest.raises(RuntimeError, match="777"):
        plan_map_goals(_EXISTING, parse_map_specs(["777"]))


def test_map_step_rows_caps_one_step():
    current = {r["mapId"]: r for r in _EXISTING}
    first, = map_step_rows(current, {200001: 800000}, 90000)
    assert (first["distance"], first["isComplete"]) == (90000, False)
    near, = map_step_rows({200001: {**current[200001], "distance": 750000}},
                          {200001: 800000}, 90000)
    assert (near["distance"], near["isComplete"]) == (800000, True)  # 到终点才置完成


def test_map_step_rows_mirrors_fields_and_keeps_unknown_distance():
    current = {r["mapId"]: r for r in _EXISTING}
    locked, = map_step_rows(current, {550001: None}, 90000)
    assert locked == {"mapId": 550001, "distance": 30000, "isLock": True,
                      "isClear": False, "isComplete": True, "unlockFlag": 2}


# ---------------------------------------------------------------
# 「本局」伪装
# ---------------------------------------------------------------

_DB = {"853": {"charts": [{"notes": [1, 1, 1, 1]}, {"notes": [2, 2, 2, 2]},
                          {"notes": [384, 30, 37, 14]}]}}

#: 账号自己的 B50 行（写道具/跑区域时拿来伪装本局，避免伪造新成绩）
_RATING_ROWS = [{"musicId": 853, "level": 2, "romVersion": 24006, "achievement": 1010000}]

#: GetUserCharacterApi 的角色行（写伙伴时要拿它校验归属并镜像等级/觉醒度）
_CHARAS = [
    {"characterId": 302, "point": 0, "useCount": 3, "level": 10353,
     "nextAwake": 0, "nextAwakePercent": 0, "awakening": 6},
    {"characterId": 101, "point": 0, "useCount": 0, "level": 153,
     "nextAwake": 0, "nextAwakePercent": 0, "awakening": 3},
]


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
    """假 MaimaiClient。

    maps 会随 UpsertUserAllApi 里的 userMapList 更新，用来模拟「服务器收下区域行」，
    让分档跑区域的循环能真的往前推。charaSlot 同理，由 accept_chara_slot 决定认不认。
    """

    calls: list = []
    queries: list = []
    music: list = []
    rating_rows: list = []
    maps: list = []
    accept_maps = True      # True=全部收下；False=整行忽略；整数=服务器自己的单档幅度上限
    slots: list = []        # 服务器当前的 charaSlot
    locks: list = []        # 服务器当前的 charaLockSlot
    charas: list = []       # GetUserCharacterApi 的角色行
    accept_chara_slot = True  # True=收下；False=永不改；"with_lock"=只认槽位与锁位一致的包
    logged_in = False       # 登录前的 GetGameKaleidxScopeApi 不返回 userData（实测行为）

    async def call_api(self, h, api, data, user_id, **kw):
        _FakeClient.calls.append((api, data))
        if api == "UserLoginApi":
            _FakeClient.logged_in = True
        if api == "UpsertUserAllApi":
            inner = (data or {}).get("upsertUserAll") or {}
            cap = _FakeClient.accept_maps
            if cap is not False:
                for row in inner.get("userMapList") or []:
                    old = next(
                        (m for m in _FakeClient.maps if m.get("mapId") == row.get("mapId")),
                        None,
                    )
                    if old is None:
                        continue
                    gain = int(row.get("distance") or 0) - int(old.get("distance") or 0)
                    if cap is not True and gain > cap:
                        continue   # 声明幅度超过服务器记的账 -> 整行忽略（实机行为）
                    _FakeClient.maps = [
                        {**m, **row} if m.get("mapId") == row.get("mapId") else m
                        for m in _FakeClient.maps
                    ]
            row = (inner.get("userData") or [{}])[0]
            want, lock = row.get("charaSlot"), row.get("charaLockSlot")
            mode = _FakeClient.accept_chara_slot
            if mode is True or (mode == "with_lock" and want == lock):
                _FakeClient.slots = list(want or _FakeClient.slots)
                _FakeClient.locks = list(lock or _FakeClient.locks)
            return {"returnCode": 1}
        if api == "GetGameKaleidxScopeApi":
            #: 实机 + 机台报文规则：只有「登录后 + 空请求体」才回 userData
            if not _FakeClient.logged_in or data:
                return {"userId": user_id, "gameKaleidxScopeList": []}
            return {"userId": user_id, "banState": 0, "userData": {
                "charaSlot": list(_FakeClient.slots),
                "charaLockSlot": list(_FakeClient.locks),
            }}
        if api == "GetUserCharacterApi":
            return {"userId": user_id, "length": len(_FakeClient.charas),
                    "userCharacterList": list(_FakeClient.charas), "nextIndex": 0}
        return {
            "GetUserPreviewApi": {"isLogin": 0},
            "UserLoginApi": {"returnCode": 1, "loginId": 555,
                             "lastLoginDate": "2026-01-01 00:00:00.0"},
            "GetUserMapApi": {"userMapList": _FakeClient.maps, "nextIndex": 0},
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
    _FakeClient.maps = [dict(r) for r in _EXISTING]
    _FakeClient.accept_maps = True
    _FakeClient.slots = [101, 102, 103, 104, 105]
    _FakeClient.locks = [0, 0, 0, 0, 0]
    _FakeClient.charas = _CHARAS
    _FakeClient.accept_chara_slot = True
    _FakeClient.logged_in = False
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
    asyncio.run(w.complete_maps_with_qr("QR", ["200001:10000"], sleep_seconds=0, plays=1))

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


def test_complete_maps_settles_then_writes_only_map_rows(monkeypatch):
    """跑区域链路：先结算本局再落库；不写 userItemList（不发收藏品），finally 必登出。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001:10000"], sleep_seconds=0, plays=1,
    ))

    apis = _apis()
    assert apis.index("GetUserNewItemListApi") < apis.index("UpsertUserAllApi")

    upsert = _upsert_packets()[0]
    inner = upsert["upsertUserAll"]
    assert inner["userMapList"] == [
        {"mapId": 200001, "distance": 10000, "isLock": False,
         "isClear": False, "isComplete": True, "unlockFlag": 0}
    ]
    assert inner["isNewMapList"] == "0"
    assert inner["userItemList"] == []   # 不发收藏品
    # 本局伪装成账号自己那条记录：判定填满，DX 用机台刻度（465 音符 * 3）
    playlog = upsert["userPlaylogList"][0]
    assert (playlog["musicId"], playlog["level"]) == (853, 2)
    assert (playlog["tapCriticalPerfect"], playlog["breakCriticalPerfect"]) == (384, 14)
    assert playlog["deluxscore"] == 1395
    assert inner["userMusicDetailList"][0]["achievement"] == 1010000
    settle = next(d for api, d in _FakeClient.calls if api == "GetUserNewItemListApi")
    assert settle["userData"][0]["playCount"] == 0
    assert inner["userData"][0]["playCount"] == 1
    assert apis.count("UserLogoutApi") == 1
    assert "✅" in msg and "200001" in msg


def test_complete_maps_advances_one_step_per_round(monkeypatch):
    """目标比一档幅度远：每档只推进 plays*MAP_DISTANCE_PER_PLAY，跑到终点才置完成。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001:90000"], sleep_seconds=0, plays=3, rounds=4,
    ))

    written = [d["upsertUserAll"]["userMapList"][0] for d in _upsert_packets()]
    assert [(r["distance"], r["isComplete"]) for r in written] == [
        (30000, False), (60000, False), (90000, True),
    ]
    assert "✅" in msg


def test_complete_maps_probes_smaller_step_when_rejected(monkeypatch):
    """服务器只认更小的幅度：同一码内折半试探，探到能落的幅度就继续推。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    _FakeClient.accept_maps = 12000      # 服务器每档只给记 12000（机台实测 11000~13000）

    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001:90000"], sleep_seconds=0, plays=3, rounds=4,
    ))

    written = [d["upsertUserAll"]["userMapList"][0]["distance"] for d in _upsert_packets()]
    # 30000 / 15000 被拒 -> 折半到 7500 才被采纳，最后一档接着 15000
    assert written == [30000, 15000, 7500, 15000]
    assert _FakeClient.maps[0]["distance"] == 15000
    assert "已采纳的最大幅度 7500/档" in msg


def test_complete_maps_stops_when_server_ignores_map_rows(monkeypatch):
    """实机结论：假局可能根本不记距离 —— 折半探到底还不行就停手，不谎报成功。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    _FakeClient.accept_maps = False      # 服务器收下包但整行忽略区域

    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001"], sleep_seconds=0, plays=1, rounds=4,
    ))

    # 10000 -> 5000 试过后，再折半就低于 MAP_STEP_FLOOR，停手
    assert len(_upsert_packets()) == 2
    assert "一次都没被采纳" in msg and "800000" in msg
    assert "✅" not in msg


def test_complete_maps_jump_writes_goal_distance_in_one_round(monkeypatch):
    """jump：不试探幅度，一次把 distance 写成目标值并置完成。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001"], sleep_seconds=0, plays=1, jump=True,
    ))

    upserts = _upsert_packets()
    assert len(upserts) == 1
    row = upserts[0]["upsertUserAll"]["userMapList"][0]
    assert (row["distance"], row["isComplete"]) == (800000, True)
    assert upserts[0]["upsertUserAll"]["isNewMapList"] == "0"
    assert "✅" in msg


def test_complete_maps_jump_retries_as_new_row_then_reports(monkeypatch):
    """jump 不被采纳时：换 isNewMapList="1" 再赌一次，仍不认就如实报失败。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    _FakeClient.accept_maps = False      # 服务器整行忽略

    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001"], sleep_seconds=0, plays=1, rounds=4, jump=True,
    ))

    inner = [d["upsertUserAll"] for d in _upsert_packets()]
    assert [i["isNewMapList"] for i in inner] == ["0", "1"]     # 更新行 -> 新增行
    assert all(i["userMapList"][0]["distance"] == 800000 for i in inner)
    assert "直接构建地图数据" in msg and "0/1" in msg and "✅" not in msg


def test_complete_maps_jump_declares_target_as_select_map(monkeypatch):
    """jump 写全新区域时把 selectMapId 换成目标区域：机台只给「正在跑的区域」记账。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    _FakeClient.accept_maps = False      # 服务器照旧忽略区域行，只为看我们发了什么

    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["550001"], sleep_seconds=0, plays=1, jump=True,
    ))

    inner = [d["upsertUserAll"] for d in _upsert_packets()]
    assert len(inner) == 2
    assert {i["userData"][0]["selectMapId"] for i in inner} == {550001}
    assert "selectMapId" in msg


def test_complete_maps_accepts_sync_progress_callback(monkeypatch):
    """CLI 传的是同步 print：进度回调不是协程也不能炸（实机踩过 TypeError）。"""
    from sdgb import write_ops as w

    _patch_write_env(monkeypatch, w)
    seen: list = []
    msg = asyncio.run(w.complete_maps_with_qr(
        "QR", ["200001:10000"], sleep_seconds=0, plays=1, progress=seen.append,
    ))

    assert "✅" in msg
    assert any("读取区域进度" in t for t in seen) and any("回查" in t for t in seen)


# ---------------------------------------------------------------
# 旅行伙伴（角色槽位）
# ---------------------------------------------------------------

def _chara_setup(monkeypatch, w, accept=True):
    """写伙伴流程的假环境：服务器是否采纳 charaSlot 由 accept 控制。"""
    _patch_write_env(monkeypatch, w)
    _FakeClient.accept_chara_slot = accept


def test_chara_slots_need_login_and_empty_body(monkeypatch):
    """读槽位的两个硬条件（实机结论）：UserLoginApi 之后 + 请求体为 `{}`。"""
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w)
    fake = _FakeClient()
    with pytest.raises(RuntimeError, match="没返回 userData"):   # 登录前读不到
        asyncio.run(w.fetch_chara_slots(fake, None, 42))
    assert _apis() == ["GetGameKaleidxScopeApi"]
    assert _FakeClient.calls[0][1] == {}                     # 请求体必须为空
    _FakeClient.logged_in = True
    assert asyncio.run(w.fetch_chara_slots(fake, None, 42)) == (
        [101, 102, 103, 104, 105], [0, 0, 0, 0, 0]
    )


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


def test_set_chara_slots_fills_five_slots_with_one_partner(monkeypatch):
    """1 个 ID -> 五槽同一个伙伴；角色表与本局 playlog 镜像账号自己的数值。"""
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w)
    msg = asyncio.run(w.set_chara_slots_with_qr("QR", [302], sleep_seconds=0))

    inner = _upsert_packets()[0]["upsertUserAll"]
    assert inner["userData"][0]["charaSlot"] == [302] * 5
    assert inner["userData"][0]["charaLockSlot"] == [0, 0, 0, 0, 0]  # 第一轮锁位保持原值
    assert inner["userCharacterList"] == [
        {"characterId": 302, "level": 10353, "awakening": 6, "useCount": 3}
    ]
    assert inner["isNewCharacterList"] == "0"                 # 更新已有角色，不造新伙伴
    playlog = _upsert_packets()[0]["userPlaylogList"][0]
    assert [playlog[f"characterId{i}"] for i in range(1, 6)] == [302] * 5
    assert [playlog[f"characterAwakening{i}"] for i in range(1, 6)] == [6] * 5

    apis = _apis()
    assert apis.index("UserLoginApi") < apis.index("GetGameKaleidxScopeApi")
    assert apis.index("GetUserCharacterApi") < apis.index("GetUserNewItemListApi")
    assert apis.index("GetUserNewItemListApi") < apis.index("UpsertUserAllApi")
    assert apis.count("UserLogoutApi") == 1
    assert "✅" in msg and "第 1 轮生效" in msg


def test_set_chara_slots_uses_current_first_partner_for_alias(monkeypatch):
    """first / 当前第一个 = 登录后拿账号现在第一个槽位的伙伴占满 5 槽。"""
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w)
    assert w.is_current_first(["first"]) and w.is_current_first("现在第一个")
    msg = asyncio.run(w.set_chara_slots_with_qr("QR", ["first"], sleep_seconds=0))

    inner = _upsert_packets()[0]["upsertUserAll"]
    assert inner["userData"][0]["charaSlot"] == [101] * 5
    assert "✅" in msg and "[101, 101, 101, 101, 101]" in msg


def test_set_chara_slots_mirrors_lock_slot_when_first_round_ignored(monkeypatch):
    """第一轮不认（服务器只认槽位与锁位一致的包）：第二轮把 charaLockSlot 一起写上。"""
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w, accept="with_lock")
    msg = asyncio.run(w.set_chara_slots_with_qr("QR", [302], sleep_seconds=0))

    inner = [d["upsertUserAll"] for d in _upsert_packets()]
    assert len(inner) == 2
    assert [i["userData"][0]["charaLockSlot"] for i in inner] == [[0, 0, 0, 0, 0], [302] * 5]
    assert "✅" in msg and "第 2 轮生效" in msg


def test_set_chara_slots_reports_when_server_keeps_old_slots(monkeypatch):
    """两轮都不认就如实报告，不谎报生效。"""
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w, accept=False)
    msg = asyncio.run(w.set_chara_slots_with_qr("QR", [302], sleep_seconds=0))

    assert len(_upsert_packets()) == 2
    assert msg.startswith("⚠️") and "没有被采纳" in msg
    assert "[101, 102, 103, 104, 105]" in msg          # 回查能看到服务器保留的原槽位


def test_set_chara_slots_rejects_unowned_partner_before_write(monkeypatch):
    """没拥有的伙伴当场拒绝：读了槽位也没用，任何写包都不发（登录会话照常登出）。"""
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w)
    with pytest.raises(RuntimeError, match="没有这些旅行伙伴"):
        asyncio.run(w.set_chara_slots_with_qr("QR", [999999], sleep_seconds=0))

    apis = _apis()
    assert "UpsertUserAllApi" not in apis and "GetUserNewItemListApi" not in apis
    assert apis.count("UserLogoutApi") == 1


def test_set_chara_slots_skips_when_slots_already_match(monkeypatch):
    from sdgb import write_ops as w

    _chara_setup(monkeypatch, w)
    msg = asyncio.run(w.set_chara_slots_with_qr(
        "QR", [101, 102, 103, 104, 105], sleep_seconds=0
    ))

    assert msg.startswith("ℹ️")
    assert len(_upsert_packets()) == 0


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
