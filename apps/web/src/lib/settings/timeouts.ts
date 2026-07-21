import { getDb, nowIso } from "../db";
import { env } from "../env";

export const SETTING_PLAYING_TIMEOUT_SEC = "playing_timeout_sec";
export const SETTING_HEAD_CONFIRM_TIMEOUT_SEC = "head_confirm_timeout_sec";

function readSettingNumber(key: string, fallback: number): number {
  const row = getDb()
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getPlayingTimeoutSec(): number {
  return readSettingNumber(SETTING_PLAYING_TIMEOUT_SEC, env.playingTimeoutSec);
}

export function getHeadConfirmTimeoutSec(): number {
  return readSettingNumber(
    SETTING_HEAD_CONFIRM_TIMEOUT_SEC,
    env.headConfirmTimeoutSec,
  );
}

export function getQueueTimeouts() {
  return {
    playingTimeoutSec: getPlayingTimeoutSec(),
    headConfirmTimeoutSec: getHeadConfirmTimeoutSec(),
  };
}

export function setQueueTimeouts(input: {
  playingTimeoutSec: number;
  headConfirmTimeoutSec: number;
}) {
  const playing = Math.floor(input.playingTimeoutSec);
  const head = Math.floor(input.headConfirmTimeoutSec);
  if (!Number.isFinite(playing) || playing < 60 || playing > 24 * 60 * 60) {
    throw new Error("INVALID_PLAYING_TIMEOUT");
  }
  if (!Number.isFinite(head) || head < 30 || head > 60 * 60) {
    throw new Error("INVALID_HEAD_CONFIRM_TIMEOUT");
  }
  const now = nowIso();
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  upsert.run(SETTING_PLAYING_TIMEOUT_SEC, String(playing), now);
  upsert.run(SETTING_HEAD_CONFIRM_TIMEOUT_SEC, String(head), now);
  return getQueueTimeouts();
}
