# -*- coding: utf-8 -*-
"""SDGB 客户端配置（共享包版本）。

取值优先级（高 -> 低）：
1. 环境变量（VW_SDGB_* / SDGB_*）
2. 本地覆盖文件 sdgb/settings_local.py（gitignored）
3. 内置默认值（仅协议常量；**密钥与机厅信息一律为空，必须显式配置**）

安全要求：
- 本文件不得包含任何真实密钥、KeychipID、ClientID、AIME Salt 或机厅信息；
  这些值只能通过环境变量或 gitignored 的 settings_local.py 注入。
- 缺少密钥时 encrypt/chime 会在使用时立即报错（fail-fast），不会静默使用弱默认值。

本地覆盖：复制 sdgb/settings_local.example.py 为 sdgb/settings_local.py 后填写。
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
# 默认值（协议常量 + 空密钥占位；不得放真实密钥/机厅信息）
# ============================================================
# 协议常量（非机密）与占位默认值。
# 机密/机厅专属值（aesKey/aesIv/obfuscateParam/clientId/KeychipID/aimeSalt/
# titleServerUrl/aimeUrl/regionName/placeName）默认全部为空，必须通过环境变量
# 或 settings_local.py 提供；缺失时对应模块会 fail-fast。
_DEFAULTS = {
    "titleServerUrl": "",
    "aesKey": "",
    "aesIv": "",
    "obfuscateParam": "",
    "apiVersion": "1.55",
    "gameSalt": "MaimaiChn",
    "clientId": "",
    "regionId": 1403,
    "regionName": "",
    "placeId": 1,
    "placeName": "",
    "KeychipID": "",
    "aimeUrl": "",
    "aimeSalt": "",
    "openGameID": "MAID",
    "userId": None,
    "qrCode": "",
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

# 本地覆盖文件（gitignored）：复制 settings_local.example.py 为 settings_local.py
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