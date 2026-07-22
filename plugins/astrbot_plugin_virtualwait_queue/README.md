# AstrBot 插件：VirtualWait 队列空闲通知

轮询 VirtualWait Bot API，在机台空闲且存在队首时向群发送 @ 提醒。

## 安装

1. 将本目录复制到 AstrBot 的 `data/plugins/astrbot_plugin_virtualwait_queue/`（或通过插件市场/本地加载）。
2. `pip install -r requirements.txt`（需要 `aiohttp`）。
3. 在 Web `.env` 配置 `BOT_API_TOKEN`，管理后台填写场地 **群 UMO**，玩家在 `/me` 绑定 QQ。
4. 插件配置：

| 项 | 说明 |
|----|------|
| `base_url` | Web 根地址，无尾斜杠 |
| `bot_token` | 与 `BOT_API_TOKEN` 相同 |
| `poll_interval_sec` | 默认 8 |
| `cooldown_sec` | 默认 300 |
| `warmup_rounds` | 默认 2（前 N 轮只缓存） |
| `default_umo` | 兜底群 UMO |
| `routing` | JSON：`{"sample-venue":"aiocqhttp:GroupMessage:1"}` |
| `district_routing` | JSON：`{"district:sample-district":"..."}` |

## 路由优先级

1. API 返回的 `groupUmo`（`venue.group_umo`）
2. `routing[venueSlug]`
3. `district_routing`
4. `default_umo`

## 行为摘要

- 热集：`activeCount>0 || hasPlaying`
- 通知：`machineIdle && head`
- `headKey = machineSlug + "_" + sorted(qqs joined by _)`
- 同一 `headKey` 冷却默认 5 分钟
- 启动 warmup 2 轮不通知
- 429/网络错误指数退避
- 通知 JSON 日志字段：`venueSlug, machineSlug, qq, umo, cooldown_key`
- 每 10 分钟输出 `skipped_no_qq_count`

## 指令

- `vw_queue_status`：查看轮次与统计

## 安全

勿把真实 `bot_token` 提交进仓库。公开排队接口不含 QQ。
