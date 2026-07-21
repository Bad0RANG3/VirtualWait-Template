/**
 * Queue domain API.
 * Implementation is split across focused modules; this file keeps stable imports.
 */
export {
  adminEntryAction,
  listAdminActiveEntries,
  listAuditEvents,
  setQueueStatus,
  type AdminEntryAction,
} from "./admin";
export {
  countActiveEntries,
  countActiveEntriesByMachine,
  getPublicQueue,
} from "./public";
export { processTimeouts } from "./timeouts";
export {
  cancelEntry,
  confirmPair,
  confirmStartPlay,
  finishPlay,
  getUserActiveEntries,
  joinQueue,
} from "./user-actions";
