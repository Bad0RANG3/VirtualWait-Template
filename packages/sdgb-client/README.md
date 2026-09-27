# sdgb-client（共享 SDGB 客户端包）

从 MaidXTool 迁移的完整 maimai DX（舞萌 DX）SDGB 标题服务器客户端，供 VirtualWait 的
Gateway（`services/sdgb-gateway`）与 QQ 机器人（`services/bot`）共用。

## 能力

- `encrypt.py`：AES-CBC + zlib 加密管道、API hash（`MaimaiChn`）、CalcRandom；
- `chime.py`：机台二维码（SGWCMAID...）→ AiMe 换 `userId/token`；
- `payload.py`：登录/登出/查询/写操作等请求体构建（纯函数）；
- `sdgb.py`：异步 `MaimaiClient`（httpx，供 QQ 机器人使用）；
- `records.py`：B50 成绩查询（GetUserRatingApi / GetUserMusicApi）与 10 分钟本地缓存；
- `b50.py`：B50 oneshot 渲染（外部渲染服务）；
- `write_ops.py`：写操作（发票 / 写道具 / 传分，高风险）。

## 写操作时序（机台报文实测）

`write_ops` 的非查询流程统一走「先结算、再整包落库」：

```
换 token -> GetUserPreviewApi（isLogin 小黑屋探测）-> UserLoginApi
         -> 查询快照 -> 模拟游玩等待(60s)
         -> GetUserNewItemListApi（带本局 playlog；成绩/道具在这一步被服务器采纳）
         -> 30s -> UpsertUserAllApi（同一批 playlog + 目标行）
         -> 回查（verify=True 才做）-> UserLogoutApi（回传登录时刻，finally 必登出）
```

- `UploadUserPlaylogListApi` 单独上传成绩会被服务器静默忽略，必须走结算包；
- 结算包用「本局之前」的计数，落库包才累加（`bump_play_totals`）；
- 非传分流程的「本局」伪造成账号自己已有的 B50 记录（判定按曲库音符数填满），
  因此写道具不会顺手改成绩；
- 整包写会覆盖 `charaSlot`，所以写前先读回账号现值（`GetGameKaleidxScopeApi`
  只在「登录后 + 空请求体」时返回 `userData`），避免把五个槽位清成默认值。

一次登录即消耗一个二维码（即使后续没发写包），失败必须重新扫码；
写流程被打断会触发 `isLogin=1`（约 15 分钟冷却）。

## 测试

```bash
pip install -e './packages/sdgb-client[test]'
python -m pytest -q packages/sdgb-client/tests
```

测试用假客户端覆盖写时序、结算/落库顺序与回查分支，不触碰真实服务器。

## 配置

取值优先级：环境变量（`VW_SDGB_*` / `SDGB_*`）→ `sdgb/settings_local.py`（可选覆盖）
→ 内置默认值（公开的国服协议参数，开箱即用）。

安全约定：
- `settings.py` 内置的是**国服社区公开、共享**的协议参数（AES Key/IV、ObfuscateParam、
  AIME Salt、KeychipID/ClientID、机厅位置），不是个人机密，随仓库发布；
- 个人/机厅私有值可用环境变量或可选的 `settings_local.py` 覆盖，覆盖文件与运行数据不要外传；
- `token_cache.json` / `records_cache.json` 仅记录 `userID` 与时间，**不落盘原始二维码或 token**；
- 所有到标题服务器/AiMe 的 HTTP 请求默认启用 TLS 证书校验（不再 `verify=False`）。

换机厅/换版本：复制 `sdgb/settings_local.example.py` 为 `sdgb/settings_local.py` 覆盖对应字段。

## 安装

```bash
pip install -e ./packages/sdgb-client
```

或直接将其加入 `PYTHONPATH`（Gateway 与 Bot 均自动注入该路径）。