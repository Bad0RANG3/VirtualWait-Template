export type QueueStatus = "OPEN" | "PAUSED" | "CLOSED";

export type EntryStatus =
  | "WAITING"
  | "PLAYING"
  | "DONE"
  | "CANCELLED"
  | "EXPIRED";

export type PlayMode = "SOLO" | "DUO";

export type PartyStatus = "SEEKING" | "PENDING" | "CONFIRMED" | "DISBANDED";

export interface PublicProfile {
  displayName: string;
  rating?: number | null;
  ratingVisible?: boolean;
  title?: string | null;
  iconUrl?: string | null;
  bound?: boolean;
}

export interface SessionUser {
  id: string;
  nickname: string;
  displayName: string;
  rating: number | null;
  showRatingPublic: boolean;
  title: string | null;
  bound: boolean;
  avatarUrl: string | null;
  loginProvider: "maimai" | "unknown";
}

export interface PartyMemberView {
  entryId: string;
  userId: string;
  displayName: string;
  rating: number | null;
  ratingVisible: boolean;
  title: string | null;
  bound: boolean;
  status: EntryStatus;
  isHost: boolean;
  confirmed: boolean;
  isMine: boolean;
}

export interface PartyView {
  id: string;
  playMode: PlayMode;
  status: PartyStatus;
  hostConfirmed: boolean;
  guestConfirmed: boolean;
  members: PartyMemberView[];
  canConfirmPair: boolean;
  canRequestPair: boolean;
  canCancelPair: boolean;
}

export interface QueueEntryView {
  id: string;
  sequenceNumber: number;
  status: EntryStatus;
  position: number | null;
  playMode: PlayMode;
  joinedAt: string;
  playingAt: string | null;
  profile: PublicProfile;
  isMine: boolean;
  party: PartyView | null;
}

/** One active slot on the machine (solo ticket or confirmed duo). */
export interface QueueSlotView {
  key: string;
  sequenceNumber: number;
  status: EntryStatus;
  position: number | null;
  playMode: PlayMode;
  party: PartyView | null;
  entries: QueueEntryView[];
  isMine: boolean;
}

export interface PublicQueueSnapshot {
  venue: { id: string; name: string; slug: string };
  queue: {
    id: string;
    name: string;
    slug: string;
    status: QueueStatus;
    playingTimeoutSec: number;
    updatedAt: string;
  };
  now: string;
  entries: QueueEntryView[];
  slots: QueueSlotView[];
}
