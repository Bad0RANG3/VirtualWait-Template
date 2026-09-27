# -*- coding: utf-8 -*-
# Optional local override for sdgb/settings.py.
# 默认参数已内置在 settings.py（国服公开参数），一般无需本文件；
# 仅在换机厅 / 换版本时，复制本文件为 sdgb/settings_local.py 并覆盖对应字段。
# DO NOT share personal overrides to others.

# ============================================================
# 服务器 / 加密配置（1.55 -> 1.56）
# ============================================================
# 以下为占位符示例：把 <...> 替换为你的授权值，禁止提交真实密钥。
titleServerUrl = "<your-title-server-url>"   # 例如 https://maimai-gm.example.com:42081/Maimai2Servlet
aesKey = "<your-aes-key>"                    # 标题服务器 AES 密钥（>=16 字符）
aesIv = "<your-aes-iv>"                      # 标题服务器 AES IV（>=16 字符）
obfuscateParam = "<your-obfuscate-param>"    # API hash 混淆盐（>=32 字符）
apiVersion = "1.55"
gameSalt = "MaimaiChn"

# ============================================================
# 机厅信息
# ============================================================
clientId = "<your-client-id>"
regionId = 1403
regionName = "<your-region-name>"
placeId = 1
placeName = "<your-place-name>"
KeychipID = "<your-keychip-id>"

# ============================================================
# AIME / 二维码换 token 接口
# ============================================================
aimeUrl = "<your-aime-url>"          # 例如 http://ai.sys-allnet.cn/wc_aime/api/get_data
aimeSalt = "<your-aime-salt>"        # AIME 换码接口盐（>=32 字符）
openGameID = "MAID"

# ============================================================
# 用户（二维码登录后由 chime.qr_api 自动获取 userId/token）
# ============================================================
userId = None
qrCode = ""

# ============================================================
# 本局游玩记录（发票流程默认曲目）
# ============================================================
musicData = {
    "musicId": 417,
    "level": 3,
    "playCount": 1,
    "achievement": 1010000,
    "comboStatus": 4,
    "syncStatus": 4,
    "deluxscoreMax": 2277,
    "scoreRank": 13,
    "extNum1": 0,
}
