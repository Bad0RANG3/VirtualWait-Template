/**
 * Runtime settings and live venue/machine metadata (DB-backed, catalog fallbacks).
 */
export {
  SETTING_HEAD_CONFIRM_TIMEOUT_SEC,
  SETTING_PLAYING_TIMEOUT_SEC,
  getHeadConfirmTimeoutSec,
  getPlayingTimeoutSec,
  getQueueTimeouts,
  setQueueTimeouts,
} from "./timeouts";

export {
  getMachineCoinCost,
  getVenueHoursBySlug,
  getVenueMetaBySlug,
  isVenueOpenNow,
  listMachinesMeta,
  listVenueMeta,
  updateMachineMeta,
  updateVenueMeta,
  type MachineMeta,
  type VenueMeta,
} from "./venue-meta";

// Shared hour helpers re-exported for admin/UI convenience.
export {
  formatMinutesAsTime,
  hoursLabelFromMinutes,
  minutesToTimeInput,
  normalizeVenueHours,
  parseTimeToMinutes,
} from "../time/hours";
