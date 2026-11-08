import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-account-"));
process.env.IP_ACCOUNT_QUOTA_PER_DAY = "2";

const IP_A = "a".repeat(64);
const IP_B = "b".repeat(64);

async function seedVenue() {
  const { getDb } = await import("../db");
  return getDb()
    .prepare(`SELECT id, slug FROM venue ORDER BY slug LIMIT 1`)
    .get() as { id: string; slug: string };
}

test("registration requires a live venue check-in code", async () => {
  const { registerAccount } = await import("./account");
  const { getVenueCheckinCode } = await import("../settings/checkin");
  const venue = await seedVenue();
  const checkin = getVenueCheckinCode(venue.id);
  assert.ok(checkin);

  assert.throws(
    () =>
      registerAccount({
        username: "no-code",
        password: "player-password",
        nickname: "NoCode",
        venueSlug: venue.slug,
        checkinCode: null,
        ipHash: IP_A,
      }),
    /CHECKIN_REQUIRED/,
  );

  assert.throws(
    () =>
      registerAccount({
        username: "bad-code",
        password: "player-password",
        nickname: "BadCode",
        venueSlug: venue.slug,
        checkinCode: "000000",
        ipHash: IP_A,
      }),
    /CHECKIN_INVALID/,
  );

  assert.throws(
    () =>
      registerAccount({
        username: "bad-venue",
        password: "player-password",
        nickname: "BadVenue",
        venueSlug: "venue-that-does-not-exist",
        checkinCode: checkin.code,
        ipHash: IP_A,
      }),
    /CHECKIN_VENUE_UNKNOWN/,
  );

  const user = registerAccount({
    username: "good-code",
    password: "player-password",
    nickname: "GoodCode",
    venueSlug: venue.slug,
    checkinCode: checkin.code,
    ipHash: IP_A,
  });
  assert.equal(user.username, "good-code");
  assert.equal(user.nickname, "GoodCode");
  assert.equal(user.checkinVenueId, venue.id);
});

test("accounts keep unique usernames and never store the plaintext password", async () => {
  const { registerAccount, findCredentialByUsername } = await import("./account");
  const { getVenueCheckinCode } = await import("../settings/checkin");
  const { getDb } = await import("../db");
  const venue = await seedVenue();
  const code = getVenueCheckinCode(venue.id)!.code;

  const created = registerAccount({
    username: "UniqueUser",
    password: "unique-player-password",
    nickname: "UniqueNick",
    venueSlug: venue.slug,
    checkinCode: code,
    ipHash: IP_B,
  });

  // Case-insensitive duplicates are rejected for both columns.
  assert.throws(
    () =>
      registerAccount({
        username: "uniqueuser",
        password: "unique-player-password",
        nickname: "AnotherNick",
        venueSlug: venue.slug,
        checkinCode: code,
        ipHash: IP_B,
      }),
    /USERNAME_TAKEN/,
  );
  assert.throws(
    () =>
      registerAccount({
        username: "another-user",
        password: "unique-player-password",
        nickname: "uniquenick",
        venueSlug: venue.slug,
        checkinCode: code,
        ipHash: IP_B,
      }),
    /NICKNAME_TAKEN/,
  );

  const row = getDb()
    .prepare(`SELECT * FROM app_user WHERE id = ?`)
    .get(created.id) as Record<string, unknown>;
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes("unique-player-password"));
  assert.equal(typeof row.password_hash, "string");
  assert.equal(typeof row.password_salt, "string");
  assert.notEqual(row.password_hash, row.password_salt);

  // Username lookup used by login is case-insensitive.
  assert.equal(findCredentialByUsername("UNIQUEUSER")?.id, created.id);
});

test("password login succeeds only for the right credentials", async () => {
  const { registerAccount, authenticate } = await import("./account");
  const { getVenueCheckinCode } = await import("../settings/checkin");
  const venue = await seedVenue();
  const code = getVenueCheckinCode(venue.id)!.code;

  const created = registerAccount({
    username: "LoginUser",
    password: "login-player-password",
    nickname: "LoginNick",
    venueSlug: venue.slug,
    checkinCode: code,
    ipHash: IP_B,
  });

  const ok = authenticate({
    username: "loginuser",
    password: "login-player-password",
    ipHash: IP_B,
  });
  assert.equal(ok.id, created.id);

  assert.throws(
    () =>
      authenticate({
        username: "LoginUser",
        password: "not-the-password",
        ipHash: IP_B,
      }),
    /INVALID_CREDENTIALS/,
  );
  assert.throws(
    () =>
      authenticate({
        username: "no-such-account",
        password: "login-player-password",
        ipHash: IP_B,
      }),
    /INVALID_CREDENTIALS/,
  );
});

test("per-IP daily registration quota blocks extra accounts and rolls back", async () => {
  const { registerAccount } = await import("./account");
  const { getVenueCheckinCode } = await import("../settings/checkin");
  const { getDb } = await import("../db");
  const venue = await seedVenue();
  const code = getVenueCheckinCode(venue.id)!.code;
  const ip = "c".repeat(64);

  registerAccount({
    username: "quota-one",
    password: "quota-player-password",
    nickname: "QuotaOne",
    venueSlug: venue.slug,
    checkinCode: code,
    ipHash: ip,
  });
  registerAccount({
    username: "quota-two",
    password: "quota-player-password",
    nickname: "QuotaTwo",
    venueSlug: venue.slug,
    checkinCode: code,
    ipHash: ip,
  });

  assert.throws(
    () =>
      registerAccount({
        username: "quota-three",
        password: "quota-player-password",
        nickname: "QuotaThree",
        venueSlug: venue.slug,
        checkinCode: code,
        ipHash: ip,
      }),
    /IP_ACCOUNT_BOUND/,
  );

  // The rejected account must not linger after the quota failure.
  const leftover = getDb()
    .prepare(`SELECT id FROM app_user WHERE username = 'quota-three'`)
    .get();
  assert.equal(leftover, undefined);

  // ...and the rejection is auditable (the audit row survives the rollback).
  const auditRow = getDb()
    .prepare(`SELECT action FROM audit_event WHERE action = 'IP_BINDING_QUOTA_HIT'`)
    .get() as { action: string } | undefined;
  assert.equal(auditRow?.action, "IP_BINDING_QUOTA_HIT");
});

test("nickname uniqueness folds NFKC compatibility characters", async () => {
  const { registerAccount, canonicalNickname } = await import("./account");
  const { getVenueCheckinCode } = await import("../settings/checkin");
  const venue = await seedVenue();
  const code = getVenueCheckinCode(venue.id)!.code;

  // Full-width "Ａdmin" and ASCII "Admin" must not coexist.
  assert.equal(canonicalNickname("  Ａdmin "), "Admin");

  registerAccount({
    username: "nfkc-one",
    password: "nfkc-player-password",
    nickname: "Ａdmin",
    venueSlug: venue.slug,
    checkinCode: code,
    ipHash: "d".repeat(64),
  });
  assert.throws(
    () =>
      registerAccount({
        username: "nfkc-two",
        password: "nfkc-player-password",
        nickname: "Admin",
        venueSlug: venue.slug,
        checkinCode: code,
        ipHash: "d".repeat(64),
      }),
    /NICKNAME_TAKEN/,
  );
});

test("an operator-created account skips registration switches but keeps validation", async () => {
  const { createAccountAsOperator } = await import("./account");
  const { getDb } = await import("../db");
  const venue = await seedVenue();

  assert.throws(
    () =>
      createAccountAsOperator({
        username: "ab",
        password: "operator-player-password",
        nickname: "TooShort",
      }),
    /INVALID_USERNAME/,
  );
  assert.throws(
    () =>
      createAccountAsOperator({
        username: "operator-one",
        password: "short",
        nickname: "WeakPass",
      }),
    /PASSWORD_TOO_SHORT/,
  );

  const created = createAccountAsOperator({
    username: "operator-one",
    password: "operator-player-password",
    nickname: "OperatorCreated",
    qq: "12345",
    venueSlug: venue.slug,
  });
  assert.equal(created.nickname, "OperatorCreated");
  assert.equal(created.qq, "12345");
  assert.equal(created.checkinVenueId, venue.id);

  const auditRow = getDb()
    .prepare(`SELECT action FROM audit_event WHERE resource_id = ? ORDER BY created_at DESC`)
    .get(created.id) as { action: string } | undefined;
  assert.equal(auditRow?.action, "ACCOUNT_CREATED_BY_OPERATOR");
});
