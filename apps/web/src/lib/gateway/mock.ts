import { randomUUID } from "crypto";
import { getDb, nowIso, addSeconds } from "../db";
import { identityHashFromUserId } from "../crypto";
import type { PublicProfile } from "../types";

export type VerificationPurpose =
  | "REGISTER_BIND"
  | "LOGIN_BIND"
  | "JOIN_QUEUE";

export interface VerificationResult {
  status: "SUCCEEDED" | "FAILED" | "PROCESSING";
  errorCode?: string;
  identityHash?: string;
  profile?: PublicProfile;
}

type MockQrProfile = {
  userId: string;
  displayName: string;
  rating: number;
  title: string;
};

function parseMockQr(qrCode: string): MockQrProfile | null {
  const raw = qrCode.trim();
  // mock:USER_ID:DISPLAY_NAME[:RATING[:TITLE]]
  if (raw.startsWith("mock:")) {
    const parts = raw.split(":");
    if (parts.length < 3) return null;
    const userId = parts[1];
    const displayName = decodeURIComponent(parts[2] || "PLAYER");
    const rating = Number(parts[3] || 12000);
    const title = decodeURIComponent(parts[4] || "VirtualWait 玩家");
    if (!userId) return null;
    return {
      userId,
      displayName,
      rating: Number.isFinite(rating) ? rating : 12000,
      title,
    };
  }

  // fallback deterministic mock for any non-empty QR in mock mode
  if (!raw) return null;
  const hash = Math.abs(
    Array.from(raw).reduce((acc, ch) => acc + ch.charCodeAt(0) * 17, 0)
  );
  return {
    userId: String(10_000_000 + (hash % 8_000_000)),
    // Generic fallback name; site nickname remains the public queue name.
    displayName: "舞萌玩家",
    rating: 10000 + (hash % 5000),
    title: "舞萌 DX 玩家",
  };
}

export function createMockVerificationJob(qrCode: string): string {
  const db = getDb();
  const id = randomUUID();
  const now = nowIso();
  const profile = parseMockQr(qrCode);
  if (!profile) {
    db.prepare(
      `INSERT INTO gateway_job_mock
       (id, status, public_result, error_code, expires_at, created_at, updated_at)
       VALUES (?, 'FAILED', NULL, 'QR_EXCHANGE_FAILED', ?, ?, ?)`
    ).run(id, addSeconds(now, 120), now, now);
    return id;
  }

  const result = {
    identityHash: identityHashFromUserId(profile.userId),
    profile: {
      displayName: profile.displayName,
      rating: profile.rating,
      title: profile.title,
      iconUrl: null,
    } satisfies PublicProfile,
  };

  db.prepare(
    `INSERT INTO gateway_job_mock
     (id, status, public_result, error_code, expires_at, created_at, updated_at)
     VALUES (?, 'SUCCEEDED', ?, NULL, ?, ?, ?)`
  ).run(id, JSON.stringify(result), addSeconds(now, 120), now, now);
  return id;
}

export function getMockVerificationJob(jobId: string): VerificationResult {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT status, public_result, error_code FROM gateway_job_mock WHERE id = ?`
    )
    .get(jobId) as
    | { status: string; public_result: string | null; error_code: string | null }
    | undefined;

  if (!row) {
    return { status: "FAILED", errorCode: "JOB_EXPIRED" };
  }
  if (row.status === "FAILED") {
    return { status: "FAILED", errorCode: row.error_code || "INTERNAL_ERROR" };
  }
  if (row.status !== "SUCCEEDED" || !row.public_result) {
    return { status: "PROCESSING" };
  }
  const parsed = JSON.parse(row.public_result) as {
    identityHash: string;
    profile: PublicProfile;
  };
  return {
    status: "SUCCEEDED",
    identityHash: parsed.identityHash,
    profile: parsed.profile,
  };
}
