# -*- coding: utf-8 -*-
"""加密工具。

密钥版本: 1.55 -> 1.56 (舞萌 DX 2026)
"""
import zlib
import base64
import hashlib
import random

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

# ---------------------------------------------------------------
# 密钥表
# ---------------------------------------------------------------
# 密钥一律来自 sdgb/settings.py（环境变量 / settings_local.py 注入），
# 本文件不得硬编码真实密钥。缺失时构造/调用会立即报错（fail-fast）。
from .settings import (  # noqa: E402
    aesKey,
    aesIv,
    obfuscateParam,
    gameSalt,
    apiVersion,
)

AesKey = aesKey
AesIV = aesIv
ObfuscateParam = obfuscateParam
GAME_SALT = gameSalt or "MaimaiChn"
MAI_ENCODING = apiVersion or "1.55"


class aes_pkcs7(object):
    def __init__(self, key: str, iv: str):
        if not key or not iv:
            raise ValueError(
                "SDGB AES key/IV 未配置：请设置 VW_SDGB_AES_KEY / VW_SDGB_AES_IV "
                "或填写 sdgb/settings_local.py，禁止使用空默认值。"
            )
        self.key = key.encode("utf-8")
        self.iv = iv.encode("utf-8")
        self.mode = AES.MODE_CBC

    def encrypt(self, content: bytes) -> bytes:
        cipher = AES.new(self.key, self.mode, self.iv)
        content_padded = pad(content, AES.block_size)
        encrypted_bytes = cipher.encrypt(content_padded)
        return encrypted_bytes

    def decrypt(self, content):
        cipher = AES.new(self.key, self.mode, self.iv)
        decrypted_padded = cipher.decrypt(content)
        decrypted = unpad(decrypted_padded, AES.block_size)
        return decrypted

    def pkcs7unpadding(self, text):
        length = len(text)
        unpadding = ord(text[length - 1])
        return text[0:length - unpadding]

    def pkcs7padding(self, text):
        bs = 16
        length = len(text)
        bytes_length = len(text.encode("utf-8"))
        padding_size = length if (bytes_length == length) else bytes_length
        padding = bs - padding_size % bs
        padding_text = chr(padding) * padding
        return text + padding_text


def get_hash_api(api, salt: str = None, obfuscate: str = None):
    """计算 API 路由 hash。

    hash = md5(api + gameSalt + ObfuscateParam)
    """
    salt = salt or GAME_SALT
    obfuscate = obfuscate or ObfuscateParam
    if not obfuscate:
        raise ValueError(
            "SDGB obfuscateParam 未配置：请设置 VW_SDGB_OBFUSCATE_PARAM "
            "或填写 sdgb/settings_local.py。"
        )
    return hashlib.md5((api + salt + obfuscate).encode()).hexdigest()


def CalcRandom():
    """与参考实现 calcPlaySpecial 一致的 c_int32 截断算法。"""
    from ctypes import c_int32
    num2 = random.randint(1, 1037933) * 2069
    num2 += 1024  # GameManager.CalcSpecialNum()
    num2 = c_int32(num2).value
    result = c_int32(0)
    for _ in range(32):
        result.value <<= 1
        result.value += num2 & 1
        num2 >>= 1
    return c_int32(result.value).value
