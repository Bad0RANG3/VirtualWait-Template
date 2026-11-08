import { requireAdmin } from "@/lib/auth/admin";
import {
  assertSameOrigin,
  jsonOk,
  mapServiceError,
} from "@/lib/api";
import {
  getVenueCheckinCode,
  rotateVenueCheckinSecret,
} from "@/lib/settings/checkin";

/**
 * Venue check-in code for the operator dashboard.
 *
 * GET returns the code currently valid for the venue; POST rotates the venue
 * secret, invalidating the previous code immediately (use it when a code leaks
 * outside the venue group chat).  The code is meant to be displayed in the
 * venue, so it is not a secret in the same sense as a password — but the
 * endpoint itself stays behind the admin session.
 *
 * Both responses include `serverNowMs` so the dashboard can render the
 * countdown against the server clock: an operator machine whose clock is off by
 * more than one window would otherwise show every live code as expired.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ venueId: string }> },
) {
  try {
    await requireAdmin(req);
    const { venueId } = await ctx.params;
    const serverNowMs = Date.now();
    const checkin = getVenueCheckinCode(venueId, serverNowMs);
    if (!checkin) return mapServiceError(new Error("VENUE_NOT_FOUND"));
    return jsonOk({ checkin, serverNowMs });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ venueId: string }> },
) {
  try {
    assertSameOrigin(req);
    await requireAdmin(req);
    const { venueId } = await ctx.params;
    const serverNowMs = Date.now();
    const checkin = rotateVenueCheckinSecret(venueId, serverNowMs);
    if (!checkin) return mapServiceError(new Error("VENUE_NOT_FOUND"));
    return jsonOk({ checkin, serverNowMs });
  } catch (err) {
    return mapServiceError(err);
  }
}
