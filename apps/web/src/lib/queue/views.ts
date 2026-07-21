import { addSeconds, nowIso } from "../db";
import { getHeadConfirmTimeoutSec } from "../settings";
import type {
  EntryStatus,
  PartyView,
  QueueEntryView,
  QueueSlotView,
} from "../types";
import type { EntryRow, PartyRow } from "./core";

function toPartyView(
  party: PartyRow | null,
  members: EntryRow[],
  currentUserId?: string | null,
): PartyView | null {
  if (!party) return null;
  const memberViews = members.map((member) => ({
    entryId: member.id,
    userId: member.user_id,
    displayName: member.nickname,
    rating:
      member.sdgb_identity_hash && member.show_rating_public ? member.rating : null,
    ratingVisible: Boolean(member.sdgb_identity_hash && member.show_rating_public),
    title: member.sdgb_identity_hash ? member.title : null,
    bound: Boolean(member.sdgb_identity_hash),
    status: member.status,
    isHost: member.user_id === party.host_user_id,
    confirmed:
      member.user_id === party.host_user_id
        ? Boolean(party.host_confirmed)
        : Boolean(party.guest_confirmed),
    isMine: Boolean(currentUserId && member.user_id === currentUserId),
  }));
  const mine = memberViews.find((member) => member.isMine);
  return {
    id: party.id,
    playMode: party.play_mode,
    status: party.status,
    hostConfirmed: Boolean(party.host_confirmed),
    guestConfirmed: Boolean(party.guest_confirmed),
    members: memberViews,
    canConfirmPair:
      party.play_mode === "DUO" &&
      party.status === "PENDING" &&
      Boolean(mine) &&
      !mine!.confirmed,
    canRequestPair:
      party.play_mode === "DUO" && party.status === "SEEKING" && !mine && Boolean(currentUserId),
    canCancelPair: Boolean(mine) && party.status !== "DISBANDED",
  };
}

function toEntryView(
  row: EntryRow,
  position: number | null,
  party: PartyView | null,
  currentUserId: string | null | undefined,
  canConfirmStart = false,
  headConfirmDeadlineAt: string | null = null,
): QueueEntryView {
  const bound = Boolean(row.sdgb_identity_hash);
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    status: row.status,
    position,
    playMode: row.play_mode,
    joinedAt: row.joined_at,
    playingAt: row.playing_at,
    headConfirmDeadlineAt,
    headMissCount: row.head_miss_count ?? 0,
    profile: {
      displayName: row.nickname,
      rating: bound && row.show_rating_public ? row.rating : null,
      ratingVisible: Boolean(bound && row.show_rating_public),
      title: bound ? row.title : null,
      iconUrl: bound ? row.icon_url : null,
      bound,
    },
    isMine: Boolean(currentUserId && row.user_id === currentUserId),
    canConfirmStart,
    party,
  };
}

export function buildSlots(
  entries: EntryRow[],
  parties: Map<string, PartyRow>,
  currentUserId?: string | null,
) {
  const grouped = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    const key =
      entry.party_id && entry.play_mode === "DUO"
        ? `party:${entry.party_id}`
        : `solo:${entry.id}`;
    const members = grouped.get(key) || [];
    members.push(entry);
    grouped.set(key, members);
  }
  const raw = [...grouped.entries()].map(([key, members]) => {
    const partyId = members[0].party_id;
    const status = members.some((member) => member.status === "PLAYING")
      ? "PLAYING"
      : "WAITING";
    return {
      key,
      members,
      status: status as EntryStatus,
      sequenceNumber: Math.min(...members.map((member) => member.sequence_number)),
      playMode: members[0].play_mode,
      party: partyId ? parties.get(partyId) || null : null,
    };
  });
  raw.sort((a, b) =>
    a.status === "PLAYING"
      ? -1
      : b.status === "PLAYING"
        ? 1
        : a.sequenceNumber - b.sequenceNumber,
  );

  const machineBusy = raw.some((slot) => slot.status === "PLAYING");
  let waitingPosition = 0;
  const slots: QueueSlotView[] = [];
  const entryViews: QueueEntryView[] = [];
  for (const slot of raw) {
    const position = slot.status === "PLAYING" ? -1 : ++waitingPosition;
    const party = toPartyView(slot.party, slot.members, currentUserId);
    const duoReady =
      slot.playMode !== "DUO" || !slot.party || slot.party.status === "CONFIRMED";
    // Head of waiting line may self-confirm onto the free machine.
    const canConfirmStart =
      !machineBusy && slot.status === "WAITING" && position === 1 && duoReady;
    const headEligibleAt =
      slot.members.map((member) => member.head_eligible_at).find((value) => Boolean(value)) ||
      null;
    // Head waiting on a free machine gets a confirm countdown (even if duo not ready yet).
    const headTimerActive =
      !machineBusy && slot.status === "WAITING" && position === 1;
    const deadlineAt =
      headTimerActive && headEligibleAt
        ? addSeconds(headEligibleAt, getHeadConfirmTimeoutSec())
        : headTimerActive
          ? addSeconds(nowIso(), getHeadConfirmTimeoutSec())
          : null;
    const views = slot.members.map((member) =>
      toEntryView(
        member,
        position,
        party,
        currentUserId,
        canConfirmStart && Boolean(currentUserId && member.user_id === currentUserId),
        deadlineAt,
      ),
    );
    entryViews.push(...views);
    slots.push({
      key: slot.key,
      sequenceNumber: slot.sequenceNumber,
      status: slot.status,
      position,
      playMode: slot.playMode,
      party,
      entries: views,
      isMine: views.some((view) => view.isMine),
      canConfirmStart: canConfirmStart && views.some((view) => view.isMine),
    });
  }
  return { entries: entryViews, slots };
}
