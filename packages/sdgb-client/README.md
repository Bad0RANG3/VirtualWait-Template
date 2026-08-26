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
- `write_ops.py`：发票写操作（登录 → 上传 → 登出，高风险）。

## 配置

取值优先级：环境变量（`VW_SDGB_*` / `SDGB_*`）→ `sdgb/settings_local.py`（gitignored）
→ 内置协议常量默认值。

安全约定（渗透测试加固后）：
- **本包不内置任何真实密钥/机厅信息**；`settings.py` 的密钥字段默认全部为空，
  未配置时 `encrypt.py` / `chime.py` 会立即报错（fail-fast），不会静默使用弱默认值；
- 生产部署必须通过环境变量覆盖全部密钥与机厅信息，禁止提交 `settings_local.py`；
- `token_cache.json` / `records_cache.json` 仅记录 `userID` 与时间，**不落盘原始二维码或 token**；
- 所有到标题服务器/AiMe 的 HTTP 请求默认启用 TLS 证书校验（不再 `verify=False`）。

本地开发/机器人部署：复制 `sdgb/settings_local.example.py` 为 `sdgb/settings_local.py`
并填写机厅信息（密钥、机台、机厅位置）。

## 安装

```bash
pip install -e ./packages/sdgb-client
```

或直接将其加入 `PYTHONPATH`（Gateway 与 Bot 均自动注入该路径）。