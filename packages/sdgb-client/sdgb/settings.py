# -*- coding: utf-8 -*-
"""SDGB 客户端配置（共享包版本）。

取值优先级（高 -> 低）：
1. 环境变量（VW_SDGB_* / SDGB_*）
2. 本地覆盖文件 sdgb/settings_local.py（可选）
3. 内置默认值（国服社区公开的协议参数，见下，开箱即用）

说明：本文件内置的均为公开、共享的国服协议参数（多个开源客户端一致），
不是个人机密，因此直接随仓库发布，开箱即用。仍可用环境变量或
settings_local.py 覆盖（例如换机厅、换版本）。
"""
from __future__ import annotations

import os


def _env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value is not None and value != "":
            return value
    return None


# ============================================================
# 默认值（公开的国服协议参数；开箱即用，可用 env / settings_local 覆盖）
# ============================================================
_DEFAULTS = {
    "titleServerUrl": "https://maimai-gm.wahlap.com:42081/Maimai2Servlet",
    "aesKey": "n7bx6:@Fg_:2;5E89Phy7AyIcpxEQ:R@",
    "aesIv": ";;KjR1C3hgB1ovXa",
    "obfuscateParam": "BEs2D5vW",
    "apiVersion": "1.55",
    "gameSalt": "MaimaiChn",
    "clientId": "A63E01C2805",
    "regionId": 1,
    "regionName": "北京",
    "placeId": 1403,
    "placeName": "插电师北京王府井银泰店",
    "KeychipID": "A63E-01C28055905",
    "aimeUrl": "http://ai.sys-allnet.cn/wc_aime/api/get_data",
    "aimeSalt": "XcW5FW4cPArBXEk4vzKz3CIrMuA5EVVW",
    "openGameID": "MAID",
    "userId": None,
    "qrCode": "",
    # 写流程「本局」兜底曲目（settings_local.py 可覆盖）；非机密。
    "musicData": {
        "musicId": 417,
        "level": 3,
        "playCount": 1,
        "achievement": 1010000,
        "comboStatus": 4,
        "syncStatus": 4,
        "deluxscoreMax": 2277,
        "scoreRank": 13,
        "extNum1": 0,
    },
}

_ENV_MAP = {
    "titleServerUrl": ("VW_SDGB_TITLE_SERVER_URL", "SDGB_TITLE_SERVER_URL"),
    "aesKey": ("VW_SDGB_AES_KEY", "SDGB_AES_KEY"),
    "aesIv": ("VW_SDGB_AES_IV", "SDGB_AES_IV"),
    "obfuscateParam": ("VW_SDGB_OBFUSCATE_PARAM", "SDGB_OBFUSCATE_PARAM"),
    "apiVersion": ("VW_SDGB_API_VERSION", "SDGB_API_VERSION"),
    "gameSalt": ("VW_SDGB_GAME_SALT", "SDGB_GAME_SALT"),
    "clientId": ("VW_SDGB_CLIENT_ID", "SDGB_CLIENT_ID"),
    "regionId": ("VW_SDGB_REGION_ID", "SDGB_REGION_ID"),
    "regionName": ("VW_SDGB_REGION_NAME", "SDGB_REGION_NAME"),
    "placeId": ("VW_SDGB_PLACE_ID", "SDGB_PLACE_ID"),
    "placeName": ("VW_SDGB_PLACE_NAME", "SDGB_PLACE_NAME"),
    "KeychipID": ("VW_SDGB_KEYCHIP_ID", "SDGB_KEYCHIP_ID"),
    "aimeUrl": ("VW_SDGB_AIME_URL", "SDGB_AIME_URL"),
    "aimeSalt": ("VW_SDGB_AIME_SALT", "SDGB_AIME_SALT"),
    "openGameID": ("VW_SDGB_OPEN_GAME_ID", "SDGB_OPEN_GAME_ID"),
}

globals().update(_DEFAULTS)

# 本地覆盖文件（可选，优先级低于环境变量）：复制 settings_local.example.py 为 settings_local.py
# 可覆盖下面任意一项（例如换机厅 / 换版本）。
try:
    from .settings_local import *  # noqa: F401,F403
except ImportError:
    pass

# 环境变量覆盖（最高优先级）
for _name, _env_names in _ENV_MAP.items():
    _value = _env(*_env_names)
    if _value is not None:
        globals()[_name] = _value

# 数值字段（regionId / placeId）允许字符串环境变量
for _name in ("regionId", "placeId"):
    _value = globals().get(_name)
    if _value is not None and not isinstance(_value, int):
        try:
            globals()[_name] = int(str(_value))
        except (TypeError, ValueError):
            globals()[_name] = _DEFAULTS[_name]