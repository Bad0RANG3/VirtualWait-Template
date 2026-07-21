import { env } from "../env";
import { hmacHex, randomToken, sha256Hex } from "../crypto";
import {
  gatewayCreateJobResponseSchema,
  gatewayVerificationResponseSchema,
} from "./contracts";
import type { PublicProfile } from "../types";

export type VerificationResult =
  | {
      status: "SUCCEEDED";
      identityHash: string;
      profile: PublicProfile;
    }
  | { status: "FAILED"; errorCode?: string }
  | { status: "PROCESSING" };

const MAX_GATEWAY_RESPONSE_BYTES = 32 * 1024;

function gatewayHeaders(method: string, url: URL, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomToken(16);
  const path = `${url.pathname}${url.search}`;
  const bodyHash = sha256Hex(body);
  const signaturePayload = [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");

  return {
    "X-VW-Key-Id": env.gatewayKeyId,
    "X-VW-Timestamp": timestamp,
    "X-VW-Nonce": nonce,
    "X-VW-Body-SHA256": bodyHash,
    "X-VW-Signature": hmacHex(env.gatewaySharedSecret, signaturePayload),
  };
}

function timeoutSignal() {
  return AbortSignal.timeout(env.gatewayTimeoutMs);
}

/** Read a bounded gateway response before parsing untrusted JSON. */
async function readGatewayJson(res: Response): Promise<unknown> {
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_GATEWAY_RESPONSE_BYTES) {
    throw new Error("GATEWAY_RESPONSE_TOO_LARGE");
  }
  if (!res.body) throw new Error("GATEWAY_INVALID_RESPONSE");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GATEWAY_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("GATEWAY_INVALID_RESPONSE");
  }
}

export async function createVerificationJob(qrCode: string): Promise<string> {
  // Always call the signed Gateway. Offline fixtures live in the Gateway
  // mock provider (`mock:*` QR values), never as an in-process Web shortcut.
  const url = new URL("/v1/verification-jobs", env.gatewayBaseUrl);
  const body = JSON.stringify({
    qrCode,
    requestedPublicFields: ["displayName", "rating", "title"],
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...gatewayHeaders("POST", url, body),
      },
      body,
      signal: timeoutSignal(),
    });
  } catch {
    throw new Error("GATEWAY_CREATE_FAILED");
  }
  if (!res.ok) throw new Error("GATEWAY_CREATE_FAILED");
  try {
    return gatewayCreateJobResponseSchema.parse(await readGatewayJson(res)).jobId;
  } catch {
    throw new Error("GATEWAY_CREATE_FAILED");
  }
}

export async function getVerificationJob(
  jobId: string
): Promise<VerificationResult> {
  const url = new URL(
    `/v1/verification-jobs/${encodeURIComponent(jobId)}`,
    env.gatewayBaseUrl
  );
  let res: Response;
  try {
    res = await fetch(url, {
      headers: gatewayHeaders("GET", url),
      cache: "no-store",
      signal: timeoutSignal(),
    });
  } catch {
    return { status: "FAILED", errorCode: "UPSTREAM_PROTOCOL_ERROR" };
  }
  if (!res.ok) {
    return { status: "FAILED", errorCode: "UPSTREAM_PROTOCOL_ERROR" };
  }
  const parsed = gatewayVerificationResponseSchema.safeParse(
    await readGatewayJson(res).catch(() => null)
  );
  if (!parsed.success) {
    return { status: "FAILED", errorCode: "UPSTREAM_PROTOCOL_ERROR" };
  }
  const data = parsed.data;

  if (data.status === "SUCCEEDED") {
    // superRefine guarantees this at runtime; retain the guard for a narrow
    // TypeScript type and defense in depth if the schema changes later.
    if (!data.identityProof || !data.profile) {
      return { status: "FAILED", errorCode: "UPSTREAM_PROTOCOL_ERROR" };
    }
    return {
      status: "SUCCEEDED",
      identityHash: data.identityProof.subject,
      profile: {
        displayName: data.profile.displayName,
        rating: data.profile.rating ?? null,
        title: data.profile.title ?? null,
        iconUrl: null,
      },
    };
  }
  if (data.status === "PROCESSING" || data.status === "LOGGING_OUT") {
    return { status: "PROCESSING" };
  }
  return {
    status: "FAILED",
    errorCode: data.errorCode || "INTERNAL_ERROR",
  };
}
