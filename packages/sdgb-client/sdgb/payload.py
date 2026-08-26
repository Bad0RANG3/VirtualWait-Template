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


# GetUserItemApi 的 itemKind 枚举
# 1=Plate 2=Title 3=Icon 4=Present 5=Music 6=MusicMas 7=MusicRem
# 8=MusicSrg 9=Character 10=Partner 11=Frame 12=Ticket
USER_ITEM_KINDS = list(range(1, 13))
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
):
    userData = json.loads(GeneralUserInfo[0]) if GeneralUserInfo[0] else {}
    userExtend = json.loads(GeneralUserInfo[1]) if GeneralUserInfo[1] else {}
    userOption = json.loads(GeneralUserInfo[2]) if GeneralUserInfo[2] else {}
    userRating = json.loads(GeneralUserInfo[3]) if GeneralUserInfo[3] else {}
    userChargeList = json.loads(GeneralUserInfo[4]) if GeneralUserInfo[4] else {}
    userActivity = json.loads(GeneralUserInfo[5]) if GeneralUserInfo[5] else {}
    userMissionDataList = json.loads(GeneralUserInfo[6]) if GeneralUserInfo[6] else {}

    # ---- 各节兜底 ----
    ud = _safe_get(userData, ["userData"], {})
    if not isinstance(ud, dict):
        ud = {}

    def U(key, default=0):
        return ud.get(key, default)

    def _chara_slot() -> list:
        slot = ud.get("charaSlot")
        if isinstance(slot, list) and len(slot) == 5:
            return slot
        return list(DEFAULT_USER_DATA["charaSlot"])

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
                    "charaSlot": _chara_slot(),
                    "charaLockSlot": U('charaLockSlot', [0, 0, 0, 0, 0]),
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
            "userItemList": [],
            "userMusicDetailList": [musicData],
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
            "isNewItemList": "",
            "isNewMusicDetailList": "0",
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
# UploadUserPlaylogListApi（单独上传打歌记录）
# ---------------------------------------------------------------

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
    player_rating: int = 0,
    play_date: str = None,
    user_play_date: str = None,
    **extra,
) -> dict:
    """构建一条 Playlog 记录（字段与机台 Playlog 定义一一对应）。

    只传必填项即可；其余字段使用与 UpsertUserAllApi 一致的默认值。
    可用 extra 覆盖任意字段（例如 tapCriticalPerfect / comboStatus / isClear）。
    """
    timestamp = timestamp if timestamp is not None else now_timestamp()
    tz = pytz.timezone("Asia/Shanghai")
    if play_date is None:
        play_date = datetime.now(tz).strftime("%Y-%m-%d")
    if user_play_date is None:
        user_play_date = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S") + ".0"

    slot = (chara_slot or [0, 0, 0, 0, 0]) + [0] * 5
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
        "characterId1": slot[0], "characterLevel1": 1, "characterAwakening1": 0,
        "characterId2": slot[1], "characterLevel2": 1, "characterAwakening2": 0,
        "characterId3": slot[2], "characterLevel3": 1, "characterAwakening3": 0,
        "characterId4": slot[3], "characterLevel4": 1, "characterAwakening4": 0,
        "characterId5": slot[4], "characterLevel5": 1, "characterAwakening5": 0,
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
    rec.update(extra)
    return rec


def build_playlog_list_data(
    user_id: int,
    playlogs: list,
    timestamp: int = None,
) -> dict:
    """UploadUserPlaylogListApi 请求体：{"userId": ..., "userPlaylogList": [...]}。

    响应为 {"returnCode": 1, "apiName": "UploadUserPlaylogListApi"}。
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
