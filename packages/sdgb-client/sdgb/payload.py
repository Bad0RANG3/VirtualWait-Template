# -*- coding: utf-8 -*-
"""请求数据构建工具（纯函数，无副作用）。

原版在 import 时就会执行 qr_api(qrCode) 换取 userId/token，导致只要
import payload 就会发一次网络请求，且 settings.qrCode 为空时直接报错。
这里改为纯函数：所有请求数据都通过参数传入，由调用方（client / Web 平台）
控制登录时机。
"""
import time
import json
import pytz
import logging
from datetime import datetime, timedelta

from .encrypt import CalcRandom
from .settings import (
    regionId, regionName, placeId, placeName, clientId,
)

logger = logging.getLogger(__name__)


def now_timestamp() -> int:
    return int(time.time())


# ---------------------------------------------------------------
# 基础请求数据构建
# ---------------------------------------------------------------

def build_preview_data(user_id: int, token: str, client_id: str = None) -> dict:
    """GetUserPreviewApi 请求数据（登录前探测）。"""
    return {
        "userId": user_id,
        "segaIdAuthKey": "",
        "token": token,
        "clientId": client_id or clientId,
    }


def build_login_data(
    user_id: int,
    token: str,
    timestamp: int = None,
    region_id: int = None,
    place_id: int = None,
    client_id: str = None,
) -> dict:
    """UserLoginApi 请求数据。"""
    timestamp = timestamp if timestamp is not None else now_timestamp()
    return {
        "userId": user_id,
        "accessCode": "",
        "regionId": region_id if region_id is not None else regionId,
        "placeId": place_id if place_id is not None else placeId,
        "clientId": client_id or clientId,
        "dateTime": timestamp - 600,
        "loginDateTime": timestamp,
        "isContinue": False,
        "genericFlag": 0,
        "token": token,
    }


# 需要分页参数 (nextIndex / maxCount) 的只读接口
PAGED_API_TYPES = {
    "GetUserMusicApi",
    "GetUserItemApi",
    "GetUserCharacterApi",
    "GetUserCardApi",
    "GetUserCourseApi",
    "GetUserMapApi",
    "GetUserLoginBonusApi",
    "GetUserPortraitApi",
    "GetUserGhostApi",
    "GetUserFavoriteApi",
    "GetUserFavoriteItemApi",
    "GetUserPhotoApi",
    "GetUserScoreRankingApi",
    "GetUserRecommendRateMusicApi",
    "GetUserRecommendSelectMusicApi",
    "GetTransferFriendApi",
}


def build_user_data(user_id: int, token: str = "") -> dict:
    """GetUserDataApi / GetUserExtendApi 等一类只需 userId 的查询。

    统一带上 token（用户要求每次调用携带 token）。
    """
    data = {"userId": user_id}
    if token:
        data["token"] = token
    return data


def build_paged_user_data(
    user_id: int,
    token: str = "",
    next_index: int = 0,
    max_count: int = 10000,
) -> dict:
    """GetUserMusicApi 等分页查询请求体（带 token）。"""
    data = {
        "userId": user_id,
        "nextIndex": next_index,
        "maxCount": max_count,
    }
    if token:
        data["token"] = token
    return data


# ---------------------------------------------------------------
# 写库时序与旅行伙伴槽位
# ---------------------------------------------------------------

#: UpsertUserAllApi 落库前必须先「结算」的接口：本局 playlog 随它的请求上报，
#: 服务器在这一步采纳 achievement；30s 后再走 UpsertUserAllApi 才入档。
#: 实测走 UploadUserPlaylogListApi 的上报一律静默不生效（2026-09-27 传分实机）。
SETTLE_API_TYPE = "GetUserNewItemListApi"

#: 旅行伙伴槽位接口：`charaSlot` / `charaLockSlot` 只在它的 userData 里返回，
#: GetUserDataApi 不带这两个字段（机台报文 2026-09-17 / 09-25 全量核对）。
CHARA_SLOT_API_TYPE = "GetGameKaleidxScopeApi"

#: 请求体必须为空的接口。机台 34 次调用 `GetGameKaleidxScopeApi` 全部发 `{}`；
#: 一旦带上 userId/token，服务器只回 gameKaleidxScopeList，读不到 charaSlot（实机验证）。
#: 另一个硬条件：这一发必须排在 UserLoginApi 之后 —— 登录前发同样的 `{}` 也只回 scope 列表。
EMPTY_BODY_API_TYPES = (CHARA_SLOT_API_TYPE,)

#: 机台的旅行伙伴槽位数（charaSlot / charaLockSlot / playlog 的 characterId1..5）。
CHARA_SLOT_COUNT = 5


def normalize_chara_slot(chara_ids) -> list:
    """把角色 ID 收成 5 槽数组：给 1 个就占满 5 槽，给 5 个按槽序。

    长度不对必须当场报错，不能悄悄补 0 —— 补 0 等于把该槽清空。
    """
    ids = [int(i) for i in chara_ids or []]
    if len(ids) == 1:
        return ids * CHARA_SLOT_COUNT
    if len(ids) != CHARA_SLOT_COUNT:
        raise ValueError(
            f"旅行伙伴只能给 1 个（占满 {CHARA_SLOT_COUNT} 槽）或 {CHARA_SLOT_COUNT} 个"
            f"（按槽序），本次给了 {len(ids)} 个：{ids}"
        )
    return ids


def build_character_entry(character: dict) -> dict:
    """构造 userCharacterList 行（机台整包里就是这 4 个字段，原样回传不改角色状态）。"""
    return {
        "characterId": int(character.get("characterId") or 0),
        "level": int(character.get("level") or 1),
        "awakening": int(character.get("awakening") or 0),
        "useCount": int(character.get("useCount") or 0),
    }


# ---------------------------------------------------------------
# userItemList 行
# ---------------------------------------------------------------

def build_item_entry(item_kind: int, item_id: int, stock: int = 1, is_valid: bool = True) -> dict:
    """构造一条 userItemList 行。

    itemKind：1 姓名框 2 称号 3 头像 4 礼物 5 歌曲 6 Master 7 Re:Master
    8 宴谱 9 角色 10 搭档 11 背景板 12 功能票；领取场景 stock 固定 1。
    """
    return {
        "itemKind": int(item_kind),
        "itemId": int(item_id),
        "stock": int(stock),
        "isValid": bool(is_valid),
    }


def merge_user_items(*lists) -> list:
    """合并多组 userItemList 行，按 (itemKind, itemId) 去重（后者覆盖前者）。"""
    merged: dict = {}
    for lst in lists:
        for row in lst or []:
            if not isinstance(row, dict):
                continue
            merged[(row.get("itemKind"), row.get("itemId"))] = row
    return list(merged.values())


def build_is_new_item_list(items) -> str:
    """按 userItemList 行数生成 isNewItemList（一行一个 "1"；0 行时为 ""）。"""
    return "1" * len(items or [])


#: 音符数 -> DX 分上限（机台刻度：满 Critical Perfect 每颗音符 3 分）。
def dx_score_max(notes) -> int:
    total = sum(normalize_notes(notes))
    return DX_SCORE_PER_NOTE * total


# GetUserItemApi 的 itemKind 枚举
# 1=Plate 2=Title 3=Icon 4=Present 5=Music 6=MusicMas 7=MusicRem
# 8=MusicSrg 9=Character 10=Partner 11=Frame 12=Ticket
USER_ITEM_KINDS = list(range(1, 13))
#: GetUserItemApi 分区起始 nextIndex：itemKind * ITEM_INDEX_STRIDE。
ITEM_INDEX_STRIDE = 10000000000
USER_ITEM_KIND_NAMES = {
    1: "Plate", 2: "Title", 3: "Icon", 4: "Present", 5: "Music",
    6: "MusicMas", 7: "MusicRem", 8: "MusicSrg", 9: "Character",
    10: "Partner", 11: "Frame", 12: "Ticket",
}


def build_user_item_data(
    user_id: int,
    token: str = "",
    item_kind: int = 1,
    next_index: int = None,
    max_count: int = 100,
) -> dict:
    """GetUserItemApi 请求体。

    服务器按 itemKind 分区返回：nextIndex 必须以 itemKind * 10^10 起步
    （如 MUSIC=50000000000、MASTER=60000000000），maxCount 用 100
    （实测确认的分页规则）。
    nextIndex=0 / maxCount=10000 会被服务器拒绝（HTTP 500）。
    """
    if next_index is None:
        next_index = item_kind * 10000000000
    data = {
        "userId": user_id,
        "nextIndex": next_index,
        "maxCount": max_count,
    }
    if token:
        data["token"] = token
    return data


def build_logout_data(
    user_id: int,
    timestamp: int = None,
    region_id: int = None,
    place_id: int = None,
    client_id: str = None,
) -> dict:
    """UserLogoutApi 请求数据。

    delayLog：机台延迟统计，服务器按此识别真实机台行为；缺失可能影响登出完整性。
    """
    timestamp = timestamp if timestamp is not None else now_timestamp()
    return {
        "userId": user_id,
        "accessCode": "",
        "regionId": region_id if region_id is not None else regionId,
        "placeId": place_id if place_id is not None else placeId,
        "clientId": client_id or clientId,
        "loginDateTime": timestamp,
        "type": 1,
        "delayLog": {
            "dlRequests": 43,
            "dlSize": 756259,
            "dlRetry": 0,
            "loginMsec": 3974,
            "saveMsec": 1319,
            "reductionMusic": 0,
            "reductionItem": 0,
            "request": [
                {"count": 1, "size": 2109, "msec": 82, "retry": 0},
                {"count": 1, "size": 18507, "msec": 78, "retry": 0},
                {"count": 12, "size": 329111, "msec": 1066, "retry": 0},
                {"count": 5, "size": 347, "msec": 456, "retry": 0},
                {"count": 1, "size": 16812, "msec": 107, "retry": 0},
                {"count": 1, "size": 14971, "msec": 79, "retry": 0},
                {"count": 1, "size": 999, "msec": 99, "retry": 0},
                {"count": 1, "size": 298, "msec": 76, "retry": 0},
                {"count": 1, "size": 2840, "msec": 77, "retry": 0},
                {"count": 1, "size": 58, "msec": 99, "retry": 0},
                {"count": 1, "size": 799, "msec": 79, "retry": 0},
                {"count": 1, "size": 423, "msec": 78, "retry": 0},
                {"count": 1, "size": 5250, "msec": 79, "retry": 0},
                {"count": 1, "size": 106737, "msec": 118, "retry": 0},
                {"count": 0, "size": 0, "msec": 0, "retry": 0},
                {"count": 1, "size": 2310, "msec": 150, "retry": 0},
                {"count": 2, "size": 411, "msec": 155, "retry": 0},
                {"count": 3, "size": 273, "msec": 244, "retry": 0},
                {"count": 3, "size": 247960, "msec": 315, "retry": 0},
                {"count": 1, "size": 1079, "msec": 78, "retry": 0},
                {"count": 1, "size": 49, "msec": 88, "retry": 0},
                {"count": 1, "size": 307, "msec": 80, "retry": 0},
                {"count": 1, "size": 4188, "msec": 215, "retry": 0},
                {"count": 1, "size": 421, "msec": 76, "retry": 0},
                {"count": 0, "size": 0, "msec": 0, "retry": 0},
                {"count": 1, "size": 65, "msec": 1130, "retry": 0},
            ],
        },
    }


# ---------------------------------------------------------------
# 上传打歌数据（UpsertUserAllApi / UploadUserPlaylogListApi）
# ---------------------------------------------------------------

def _safe_get(obj, path, default=None):
    """安全取值：obj 为 dict/list 混合结构，path 为 key/index 序列。"""
    cur = obj
    for k in path:
        if isinstance(cur, dict) and k in cur and cur[k] is not None:
            cur = cur[k]
        elif isinstance(cur, list) and isinstance(k, int) and 0 <= k < len(cur):
            cur = cur[k]
        else:
            return default
    return cur


# 各节空响应时使用的兜底默认值（避免 UserAll_payload 直接取下标崩溃）
DEFAULT_USER_DATA = {
    "accessCode": "", "userName": "\uff37\uff41\uff52\uff4d\uff41", "isNetMember": 1, "point": 0,
    "totalPoint": 0, "iconId": 1, "plateId": 1, "titleId": 1, "partnerId": 1, "frameId": 1,
    "selectMapId": 1, "totalAwake": 0, "gradeRating": 0, "musicRating": 0, "playerRating": 0,
    "highestRating": 0, "gradeRank": 0, "classRank": 0, "courseRank": 0,
    "charaSlot": [1, 1, 1, 1, 1], "charaLockSlot": [0, 0, 0, 0, 0], "contentBit": "",
    "playCount": 0, "currentPlayCount": 0, "renameCredit": 0, "mapStock": 0,
    "eventWatchedDate": "2026-01-01 00:00:00.0",
    "lastRomVersion": "", "lastDataVersion": "", "lastSelectEMoney": 0, "lastSelectTicket": 0,
    "lastSelectCourse": 0, "lastCountCourse": 0, "firstGameId": "SDGB", "firstRomVersion": "",
    "firstDataVersion": "", "firstPlayDate": "2026-01-01 00:00:00.0",
    "compatibleCmVersion": "", "dailyBonusDate": "2026-01-01 00:00:00.0",
    "dailyCourseBonusDate": "2026-01-01 00:00:00.0", "lastPairLoginDate": "2026-01-01 00:00:00.0",
    "lastTrialPlayDate": "2026-01-01 00:00:00.0",
    "playVsCount": 0, "playSyncCount": 0, "winCount": 0, "helpCount": 0, "comboCount": 0,
    "totalDeluxscore": 0, "totalBasicDeluxscore": 0, "totalAdvancedDeluxscore": 0,
    "totalExpertDeluxscore": 0, "totalMasterDeluxscore": 0, "totalReMasterDeluxscore": 0,
    "totalSync": 0, "totalBasicSync": 0, "totalAdvancedSync": 0, "totalExpertSync": 0,
    "totalMasterSync": 0, "totalReMasterSync": 0, "totalAchievement": 0,
    "totalBasicAchievement": 0, "totalAdvancedAchievement": 0, "totalExpertAchievement": 0,
    "totalMasterAchievement": 0, "totalReMasterAchievement": 0,
    "playerOldRating": 0, "playerNewRating": 0, "friendRegistSkip": False,
}

DEFAULT_USER_EXTEND = {
    "selectMusicId": 0, "selectDifficultyId": 0, "categoryIndex": 0, "musicIndex": 0,
    "extraFlag": 0, "selectScoreType": 0, "selectResultDetails": False,
    "selectResultScoreViewType": 0, "sortCategorySetting": 0, "sortMusicSetting": 0,
    "selectedCardList": [0, 0, 0, 0, 0],
    "encountMapNpcList": [{"npcId": 0, "musicId": 0}, {"npcId": 0, "musicId": 0}, {"npcId": 0, "musicId": 0}],
    "extendContentBit": 0, "playStatusSetting": 0,
}

DEFAULT_USER_OPTION = {
    "optionKind": 3, "noteSpeed": 28, "slideSpeed": 10, "touchSpeed": 27, "noteSize": 1,
    "slideSize": 1, "touchSize": 1, "tapDesign": 1, "holdDesign": 1, "slideDesign": 1,
    "starType": 1, "starRotate": 1, "adjustTiming": 20, "judgeTiming": 20, "mirrorMode": 0,
    "ansVolume": 8, "tempoVolume": 0, "tapHoldVolume": 0, "touchHoldVolume": 0, "breakVolume": 5,
    "exVolume": 0, "slideVolume": 0, "breakSe": 0, "slideSe": 0, "exSe": 0, "criticalSe": 1,
    "tapSe": 0, "headPhoneVolume": 3, "matching": 1, "brightness": 0, "dispRate": 7,
    "dispCenter": 4, "dispJudge": 13, "dispJudgePos": 5, "dispJudgeTouchPos": 2, "dispChain": 0,
    "dispBar": 0, "trackSkip": 1, "touchEffect": 0, "outlineDesign": 3, "submonitorAnimation": 2,
    "submonitorAppeal": 3, "submonitorAchive": 0, "sortTab": 0, "sortMusic": 0,
    "damageSeVolume": 0, "touchVolume": 0, "outFrameType": 7, "breakSlideVolume": 0,
}

DEFAULT_USER_RATING = {"rating": 0, "ratingList": []}
DEFAULT_USER_CHARGE_LIST = {"userChargeList": []}
DEFAULT_USER_ACTIVITY = {"playList": [], "musicList": []}

DEFAULT_MISSION_ENTRY = {
    "type": 0, "difficulty": 0, "targetGenreId": 0, "targetGenreTableId": 0,
    "conditionGenreId": 0, "conditionGenreTableId": 0, "clearFlag": False,
}
DEFAULT_USER_WEEKLY = {
    "lastLoginWeek": "2026-01-01 04:00:00", "beforeLoginWeek": "2026-01-01 04:00:00",
    "friendBonusFlag": False,
}


def UserAll_payload(
    loginId: int,
    loginDate: str,
    musicData: dict,
    GeneralUserInfo: list,
    user_id: int = None,
    timestamp: int = None,
    login_date_time: int = None,
    user_playlog_list: list = None,
    *,
    chara_slot: list = None,
    chara_lock_slot: list = None,
    user_item_list: list = None,
    user_music_detail_list: list = None,
    is_new_music_detail_list: str = None,
    is_new_item_list: str = None,
):
    """构建 UpsertUserAllApi 整包。

    `GeneralUserInfo` 是按 `write_ops.API_ORDER` 顺序序列化（JSON 字符串）的各只读接口
    响应，前 7 项固定为 User/Extend/Option/Rating/Charge/Activity/Mission；
    第 8 项（可选）是 `GetGameKaleidxScopeApi` 的响应 —— 账号的 `charaSlot` /
    `charaLockSlot` 只在它的 userData 里返回，缺了这一项就得靠默认值，
    会把账号正在用的 5 个旅行伙伴写成 [1,1,1,1,1]。

    关键字参数用于「本次要改什么」：不传即原样回传快照（userItemList 保持空 = 不动这些表）。
    user_music_detail_list 给定时整替换 userMusicDetailList（传分），
    并把 is_new_music_detail_list="1" 告诉服务器这是新成绩；不传时仍是单条 musicData。
    """
    userData = json.loads(GeneralUserInfo[0]) if GeneralUserInfo[0] else {}
    userExtend = json.loads(GeneralUserInfo[1]) if GeneralUserInfo[1] else {}
    userOption = json.loads(GeneralUserInfo[2]) if GeneralUserInfo[2] else {}
    userRating = json.loads(GeneralUserInfo[3]) if GeneralUserInfo[3] else {}
    userChargeList = json.loads(GeneralUserInfo[4]) if GeneralUserInfo[4] else {}
    userActivity = json.loads(GeneralUserInfo[5]) if GeneralUserInfo[5] else {}
    userMissionDataList = json.loads(GeneralUserInfo[6]) if GeneralUserInfo[6] else {}
    kalei = json.loads(GeneralUserInfo[7]) if len(GeneralUserInfo) > 7 and GeneralUserInfo[7] else {}

    # ---- 各节兜底 ----
    ud = _safe_get(userData, ["userData"], {})
    if not isinstance(ud, dict):
        ud = {}
    kalei_ud = _safe_get(kalei, ["userData"], {})
    if not isinstance(kalei_ud, dict):
        kalei_ud = {}

    def U(key, default=0):
        return ud.get(key, default)

    def _slot_array(key: str, override) -> list:
        """charaSlot / charaLockSlot：显式覆盖 > GetUserDataApi > 槽位接口 > 默认。"""
        if override is not None:
            return normalize_chara_slot(override)
        for src in (ud, kalei_ud):
            value = src.get(key)
            if isinstance(value, list) and len(value) == CHARA_SLOT_COUNT:
                return [int(i) for i in value]
        return list(DEFAULT_USER_DATA[key])

    ext = _safe_get(userExtend, ["userExtend"], None)
    ext = ext if isinstance(ext, dict) else dict(DEFAULT_USER_EXTEND)
    opt = _safe_get(userOption, ["userOption"], None)
    opt = opt if isinstance(opt, dict) else dict(DEFAULT_USER_OPTION)
    rating = _safe_get(userRating, ["userRating"], None)
    rating = rating if isinstance(rating, dict) else dict(DEFAULT_USER_RATING)
    charge_list = _safe_get(userChargeList, ["userChargeList"], None)
    charge_list = charge_list if isinstance(charge_list, list) else []
    activity = _safe_get(userActivity, ["userActivity"], None)
    activity = activity if isinstance(activity, dict) else dict(DEFAULT_USER_ACTIVITY)

    mission_list = _safe_get(userMissionDataList, ["userMissionDataList"], None)
    if not isinstance(mission_list, list) or len(mission_list) < 6:
        mission_list = [dict(DEFAULT_MISSION_ENTRY) for _ in range(6)]
    weekly = _safe_get(userMissionDataList, ["userWeeklyData"], None)
    weekly = weekly if isinstance(weekly, dict) else dict(DEFAULT_USER_WEEKLY)

    def _mission(i: int) -> dict:
        m = mission_list[i]
        return {
            "type": m.get("type", 0),
            "difficulty": m.get("difficulty", 0),
            "targetGenreId": m.get("targetGenreId", 0),
            "targetGenreTableId": m.get("targetGenreTableId", 0),
            "conditionGenreId": m.get("conditionGenreId", 0),
            "conditionGenreTableId": m.get("conditionGenreTableId", 0),
            "clearFlag": m.get("clearFlag", False),
        }

    if user_id is None:
        raise ValueError("UserAll_payload 需要显式传入 user_id")
    TimeStamp = timestamp if timestamp is not None else now_timestamp()

    items = list(user_item_list or [])
    music_details = (
        list(user_music_detail_list) if user_music_detail_list is not None
        else [musicData]
    )
    new_music_detail_list = (
        is_new_music_detail_list if is_new_music_detail_list is not None else "0"
    )
    #: 道具标志按行给：本次新增 "1"、镜像已有行 "0"（不给则整批按新增）。
    new_item_list = (
        is_new_item_list if is_new_item_list is not None
        else build_is_new_item_list(items)
    )

    requestData_UserAll = {
        "userId": user_id,
        "playlogId": loginId,
        "isEventMode": False,
        "isFreePlay": False,
        "upsertUserAll": {
            "userData": [
                {
                    "accessCode": "",
                    "userName": U('userName', DEFAULT_USER_DATA['userName']),
                    "isNetMember": 1,
                    "point": U('point'),
                    "totalPoint": U('totalPoint'),
                    "iconId": U('iconId', 1),
                    "plateId": U('plateId', 1),
                    "titleId": U('titleId', 1),
                    "partnerId": U('partnerId', 1),
                    "frameId": U('frameId', 1),
                    "selectMapId": U('selectMapId', 1),
                    "totalAwake": U('totalAwake'),
                    "gradeRating": U('gradeRating'),
                    "musicRating": U('musicRating'),
                    "playerRating": U('playerRating'),
                    "highestRating": U('highestRating'),
                    "gradeRank": U('gradeRank'),
                    "classRank": U('classRank'),
                    "courseRank": U('courseRank'),
                    "charaSlot": _slot_array("charaSlot", chara_slot),
                    "charaLockSlot": _slot_array("charaLockSlot", chara_lock_slot),
                    "contentBit": U('contentBit', ""),
                    "playCount": U('playCount'),
                    "currentPlayCount": U('currentPlayCount'),
                    "renameCredit": U('renameCredit'),
                    "mapStock": U('mapStock'),
                    "eventWatchedDate": U('eventWatchedDate', DEFAULT_USER_DATA['eventWatchedDate']),
                    "lastGameId": "SDGB",
                    "lastRomVersion": str(U('lastRomVersion') or ""),
                    "lastDataVersion": str(U('lastDataVersion') or ""),
                    "lastLoginDate": U('lastLoginDate') or loginDate,
                    "lastPlayDate": datetime.now(pytz.timezone('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S') + '.0',
                    "lastPlayCredit": 1,
                    "lastPlayMode": 0,
                    "lastPlaceId": placeId,
                    "lastPlaceName": placeName,
                    "lastAllNetId": 0,
                    "lastRegionId": regionId,
                    "lastRegionName": regionName,
                    "lastClientId": clientId,
                    "lastCountryCode": "CHN",
                    "lastSelectEMoney": U('lastSelectEMoney'),
                    "lastSelectTicket": U('lastSelectTicket'),
                    "lastSelectCourse": U('lastSelectCourse'),
                    "lastCountCourse": U('lastCountCourse'),
                    "firstGameId": U('firstGameId', 'SDGB'),
                    "firstRomVersion": str(U('firstRomVersion') or ""),
                    "firstDataVersion": str(U('firstDataVersion') or ""),
                    "firstPlayDate": U('firstPlayDate', DEFAULT_USER_DATA['firstPlayDate']),
                    "compatibleCmVersion": str(U('compatibleCmVersion') or ""),
                    "dailyBonusDate": U('dailyBonusDate', DEFAULT_USER_DATA['dailyBonusDate']),
                    "dailyCourseBonusDate": U('dailyCourseBonusDate', DEFAULT_USER_DATA['dailyCourseBonusDate']),
                    "lastPairLoginDate": U('lastPairLoginDate', DEFAULT_USER_DATA['lastPairLoginDate']),
                    "lastTrialPlayDate": U('lastTrialPlayDate', DEFAULT_USER_DATA['lastTrialPlayDate']),
                    "playVsCount": U('playVsCount'),
                    "playSyncCount": U('playSyncCount'),
                    "winCount": U('winCount'),
                    "helpCount": U('helpCount'),
                    "comboCount": U('comboCount'),
                    "totalDeluxscore": U('totalDeluxscore'),
                    "totalBasicDeluxscore": U('totalBasicDeluxscore'),
                    "totalAdvancedDeluxscore": U('totalAdvancedDeluxscore'),
                    "totalExpertDeluxscore": U('totalExpertDeluxscore'),
                    "totalMasterDeluxscore": U('totalMasterDeluxscore'),
                    "totalReMasterDeluxscore": U('totalReMasterDeluxscore'),
                    "totalSync": U('totalSync'),
                    "totalBasicSync": U('totalBasicSync'),
                    "totalAdvancedSync": U('totalAdvancedSync'),
                    "totalExpertSync": U('totalExpertSync'),
                    "totalMasterSync": U('totalMasterSync'),
                    "totalReMasterSync": U('totalReMasterSync'),
                    "totalAchievement": U('totalAchievement'),
                    "totalBasicAchievement": U('totalBasicAchievement'),
                    "totalAdvancedAchievement": U('totalAdvancedAchievement'),
                    "totalExpertAchievement": U('totalExpertAchievement'),
                    "totalMasterAchievement": U('totalMasterAchievement'),
                    "totalReMasterAchievement": U('totalReMasterAchievement'),
                    "playerOldRating": U('playerOldRating'),
                    "playerNewRating": U('playerNewRating'),
                    "banState": userData.get("banState", 0),
                    "friendRegistSkip": U('friendRegistSkip', False),
                    "dateTime": TimeStamp,
                }
            ],
            "userExtend": [ext],
            "userOption": [opt],
            "userCharacterList": [],
            "userGhost": [],
            "userMapList": [],
            "userLoginBonusList": [],
            "userRatingList": [rating],
            "userItemList": items,
            "userMusicDetailList": music_details,
            "userCourseList": [],
            "userFriendSeasonRankingList": [],
            "userChargeList": charge_list,
            "userFavoriteList": [
                {"itemKind": 3, "itemIdList": []},
                {"itemKind": 1, "itemIdList": []},
                {"itemKind": 2, "itemIdList": []},
                {"itemKind": 10, "itemIdList": []},
                {"itemKind": 11, "itemIdList": []},
            ],
            "userActivityList": [activity],
            "userMissionDataList": [_mission(i) for i in range(6)],
            "userWeeklyData": {
                "lastLoginWeek": weekly.get("lastLoginWeek", DEFAULT_USER_WEEKLY["lastLoginWeek"]),
                "beforeLoginWeek": weekly.get("beforeLoginWeek", DEFAULT_USER_WEEKLY["beforeLoginWeek"]),
                "friendBonusFlag": weekly.get("friendBonusFlag", False),
            },
            "userGamePlaylogList": [
                {
                    "playlogId": loginId,
                    "version": str(U('lastRomVersion') or ""),
                    "playDate": datetime.now(pytz.timezone('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S') + '.0',
                    "playMode": 0,
                    "useTicketId": -1,
                    "playCredit": 1,
                    "playTrack": 1,
                    "clientId": clientId,
                    "isPlayTutorial": False,
                    "isEventMode": False,
                    "isNewFree": False,
                    "playCount": U('playCount'),
                    "playSpecial": CalcRandom(),
                    "playOtherUserId": 0,
                }
            ],
            "user2pPlaylog": {
                "userId1": 0,
                "userId2": 0,
                "userName1": "",
                "userName2": "",
                "regionId": 0,
                "placeId": 0,
                "user2pPlaylogDetailList": [],
            },
            "userIntimateList": [],
            "userShopItemStockList": [],
            "userGetPointList": [],
            "userTradeItemList": [],
            "userFavoritemusicList": [],
            "userKaleidxScopeList": [],
            "isNewCharacterList": "",
            "isNewMapList": "",
            "isNewLoginBonusList": "",
            "isNewItemList": new_item_list,
            "isNewMusicDetailList": new_music_detail_list,
            "isNewCourseList": "",
            "isNewFavoriteList": "11111",
            "isNewFriendSeasonRankingList": "",
            "isNewUserIntimateList": "",
            "isNewFavoritemusicList": "",
            "isNewKaleidxScopeList": "",
        },
    }

    # 顶层带 loginDateTime（会话校验）与 userPlaylogList（内嵌本局 playlog）。
    if login_date_time is not None:
        requestData_UserAll["loginDateTime"] = login_date_time
    if user_playlog_list:
        requestData_UserAll["userPlaylogList"] = user_playlog_list

    # 不记录 userId/loginId/loginDate/timestamp 等会话与身份信息（防日志泄露）。
    return requestData_UserAll


# ---------------------------------------------------------------
# Playlog（本局游玩记录）
# ---------------------------------------------------------------

#: 机台包里的 DX 分刻度：满 Critical Perfect 时每颗音符固定 3 分。
DX_SCORE_PER_NOTE = 3


def normalize_notes(notes) -> tuple:
    """音符数归一化为 (tap, hold, slide, touch, break)。

    曲库 charts[].notes 只有 4 位 [tap, hold, slide, break]（没有 touch），
    5 位按机台顺序 [tap, hold, slide, touch, break]。
    """
    n = list(notes or [])
    if len(n) >= 5:
        return tuple(n[:5])
    t, h, s, b = (n + [0, 0, 0, 0])[:4]
    return t, h, s, 0, b


def build_playlog(
    *,
    playlog_id: int,
    music_id: int,
    level: int,
    achievement: int,
    deluxscore: int = 0,
    score_rank: int = 0,
    place_id: int = None,
    place_name: str = None,
    version: int = 1053000,
    timestamp: int = None,
    chara_slot: list = None,
    chara_levels: list = None,
    chara_awakenings: list = None,
    player_rating: int = 0,
    play_date: str = None,
    user_play_date: str = None,
    notes: list = None,
    **extra,
) -> dict:
    """构建一条 Playlog 记录（字段与机台 Playlog 定义一一对应）。

    只传必填项即可；其余字段使用与 UpsertUserAllApi 一致的默认值。
    可用 extra 覆盖任意字段（例如 tapCriticalPerfect / comboStatus / isClear）。

    notes: 谱面音符数（4 位或 5 位）。给定时按「全 Critical Perfect」填满判定，
    并同步 maxCombo/totalCombo/maxSync 与 deluxscore（未显式传 deluxscore 时）。
    机台会用判定反推 achievement，判定全 0 的成绩包会被服务器丢弃。

    chara_slot / chara_levels / chara_awakenings: 本局在用的 5 个旅行伙伴及其
    等级、觉醒度（取自 GetUserCharacterApi 的角色行），写进 characterId1..5 三组字段。
    """
    timestamp = timestamp if timestamp is not None else now_timestamp()
    tz = pytz.timezone("Asia/Shanghai")
    if play_date is None:
        play_date = datetime.now(tz).strftime("%Y-%m-%d")
    if user_play_date is None:
        user_play_date = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S") + ".0"

    slot = (chara_slot or [0] * 5) + [0] * 5
    #: 机台把本局在用伙伴的等级/觉醒度原样记进 playlog，空槽固定 1/0 ——
    #: 与不传 chara_slot 时的旧行为一致。
    lv = list(chara_levels or []) + [1] * 5
    awake = list(chara_awakenings or []) + [0] * 5

    judgments: dict = {}
    if notes is not None:
        tap, hold, slide, touch, brk = normalize_notes(notes)
        total = tap + hold + slide + touch + brk
        if total:
            judgments = {
                "tapCriticalPerfect": tap,
                "holdCriticalPerfect": hold,
                "slideCriticalPerfect": slide,
                "touchCriticalPerfect": touch,
                "breakCriticalPerfect": brk,
                "isTap": tap > 0, "isHold": hold > 0, "isSlide": slide > 0,
                "isTouch": touch > 0, "isBreak": brk > 0,
                "maxCombo": total, "totalCombo": total, "maxSync": total,
            }
            if not deluxscore:
                deluxscore = DX_SCORE_PER_NOTE * total

    rec = {
        "userId": 0,
        "orderId": 0,
        "playlogId": playlog_id,
        "version": version,
        "placeId": place_id if place_id is not None else placeId,
        "placeName": place_name if place_name is not None else placeName,
        "loginDate": timestamp,
        "playDate": play_date,
        "userPlayDate": user_play_date,
        "type": 0,
        "musicId": music_id,
        "level": level,
        "trackNo": 1,
        "useTicketId": -1,
        "vsMode": 0,
        "vsUserName": "",
        "vsStatus": 0,
        "vsUserRating": 0,
        "vsUserAchievement": 0,
        "vsUserGradeRank": 0,
        "vsRank": 0,
        "playerNum": 1,
        "playedUserId1": 0,
        "playedUserName1": "",
        "playedMusicLevel1": 0,
        "playedUserId2": 0,
        "playedUserName2": "",
        "playedMusicLevel2": 0,
        "playedUserId3": 0,
        "playedUserName3": "",
        "playedMusicLevel3": 0,
        "characterId1": slot[0], "characterLevel1": lv[0], "characterAwakening1": awake[0],
        "characterId2": slot[1], "characterLevel2": lv[1], "characterAwakening2": awake[1],
        "characterId3": slot[2], "characterLevel3": lv[2], "characterAwakening3": awake[2],
        "characterId4": slot[3], "characterLevel4": lv[3], "characterAwakening4": awake[3],
        "characterId5": slot[4], "characterLevel5": lv[4], "characterAwakening5": awake[4],
        "achievement": achievement,
        "deluxscore": deluxscore,
        "scoreRank": score_rank,
        "maxCombo": 0,
        "totalCombo": 0,
        "maxSync": 0,
        "totalSync": 0,
        "tapCriticalPerfect": 0, "tapPerfect": 0, "tapGreat": 0, "tapGood": 0, "tapMiss": 0,
        "holdCriticalPerfect": 0, "holdPerfect": 0, "holdGreat": 0, "holdGood": 0, "holdMiss": 0,
        "slideCriticalPerfect": 0, "slidePerfect": 0, "slideGreat": 0, "slideGood": 0, "slideMiss": 0,
        "touchCriticalPerfect": 0, "touchPerfect": 0, "touchGreat": 0, "touchGood": 0, "touchMiss": 0,
        "breakCriticalPerfect": 0, "breakPerfect": 0, "breakGreat": 0, "breakGood": 0, "breakMiss": 0,
        "isTap": False, "isHold": False, "isSlide": False, "isTouch": False, "isBreak": False,
        "isCriticalDisp": True,
        "isFastLateDisp": True,
        "fastCount": 0,
        "lateCount": 0,
        "isAchieveNewRecord": False,
        "isDeluxscoreNewRecord": False,
        "comboStatus": 0,
        "syncStatus": 0,
        "isClear": achievement >= 800000,
        "beforeRating": player_rating,
        "afterRating": player_rating,
        "beforeGrade": 0,
        "afterGrade": 0,
        "afterGradeRank": 0,
        "beforeDeluxRating": player_rating,
        "afterDeluxRating": player_rating,
        "isPlayTutorial": False,
        "isEventMode": False,
        "isFreedomMode": False,
        "playMode": 0,
        "isNewFree": False,
        "trialPlayAchievement": -1,
        "extNum1": 0,
        "extNum2": 0,
        "extNum4": 0,
        "extBool1": False,
        "extBool2": False,
    }
    rec.update(judgments)
    rec.update(extra)
    return rec


# ---------------------------------------------------------------
# 本局结算 / 单独上传打歌记录
# ---------------------------------------------------------------

def build_new_item_list_data(
    user_id: int,
    user_data: list,
    playlogs: list,
    version: int = 1053000,
) -> dict:
    """GetUserNewItemListApi 请求体：机台的「本局结算」。

    实测机台包每次游玩结束都是
    `GetUserNewItemListApi(userId, version, userData, userPlaylogList)`
    先结算本局，约 30 秒后同样的 playlog 再随 UpsertUserAllApi 落库。
    成绩/道具都是在这一步被服务器采纳的，响应 userItemList 即本局掉的收藏品。
    user_data 直接复用 UpsertUserAllApi 的 userData 行（同一个对象）。
    """
    return {
        "userId": user_id,
        "version": version,
        "userData": user_data,
        "userPlaylogList": playlogs,
    }


def build_playlog_list_data(
    user_id: int,
    playlogs: list,
    timestamp: int = None,
) -> dict:
    """UploadUserPlaylogListApi 请求体：{"userId", "userPlaylogList", "loginDateTime"}。

    响应为 {"returnCode": 1, "apiName": "UploadUserPlaylogListApi"}，但实测服务器
    会静默忽略这里的成绩 —— 传分要走 build_new_item_list_data 的结算时序。
    """
    return {
        "userId": user_id,
        "userPlaylogList": playlogs,
        "loginDateTime": timestamp if timestamp is not None else now_timestamp(),
    }


# ---------------------------------------------------------------
# UpsertUserChargelogApi（发票 / 添加票据）
# ---------------------------------------------------------------

def build_charge_data(
    user_id: int,
    *,
    charge_id: int = 3,
    stock: int = 1,
    price: int = None,
    valid_days: int = 90,
    play_count: int = 0,
    player_rating: int = 0,
    timestamp: int = None,
    login_date_time: int = None,
    region_id: int = None,
    place_id: int = None,
    client_id: str = None,
) -> dict:
    """UpsertUserChargelogApi 请求体：给账号添加 chargeId 票据。

    字段说明：
      - price 默认 = chargeId - 1（如 6 -> 5）；发票场景传 price=0（免费下发）
      - purchaseDate 使用当前时间（不是 1 小时前）
      - validDate 按"当天 04:00 + valid_days 天"计算（凌晨 0~4 点执行时比
        "now+90 天"少算一天，属服务器语义）
      - userChargelog 带 playCount / playerRating
      - loginDateTime 可选（顶层字段，等于 UserLoginApi 的 loginDateTime，
        写流程可传登录时刻）
    """
    tz = pytz.timezone("Asia/Shanghai")
    now = datetime.now(tz)
    purchase = now.strftime("%Y-%m-%d %H:%M:%S") + ".0"
    valid = (now.replace(hour=4, minute=0, second=0) + timedelta(days=valid_days)
             ).strftime("%Y-%m-%d %H:%M:%S")
    if price is None:
        price = max(charge_id - 1, 0)
    data = {
        "userId": user_id,
        "userCharge": {
            "chargeId": charge_id,
            "stock": stock,
            "purchaseDate": purchase,
            "validDate": valid,
        },
        "userChargelog": {
            "chargeId": charge_id,
            "price": price,
            "purchaseDate": purchase,
            "playCount": play_count,
            "playerRating": player_rating,
            "placeId": place_id if place_id is not None else placeId,
            "regionId": region_id if region_id is not None else regionId,
            "clientId": client_id or clientId,
        },
    }
    if login_date_time is not None:
        data["loginDateTime"] = login_date_time
    return data
