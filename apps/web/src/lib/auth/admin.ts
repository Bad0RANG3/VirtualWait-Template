import { env } from "../env";
import { safeEqual, signPayload } from "../crypto";
import { cookies } from "next/headers";

const COOKIE = "vw_admin";
const MAX_AGE_SEC = 8 * 60 * 60;

type AdminPayload = { role: "admin"; exp: number };

function encode(payload: AdminPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signPayload(body, env.adminApiToken)}`;
}

function isValid(token: string | undefined) {
  if (!token || !env.adminApiToken) return false;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return false;
  if (!safeEqual(signature, signPayload(body, env.adminApiToken))) return false;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AdminPayload;
    return value.role === "admin" && Number.isSafeInteger(value.exp) && value.exp > Date.now();
  } catch {
    return false;
  }
}

export async function setAdminSession() {
  const jar = await cookies();
  jar.set(COOKIE, encode({ role: "admin", exp: Date.now() + MAX_AGE_SEC * 1000 }), {
    httpOnly: true,
    sameSite: "strict",
    secure: env.secureCookies,
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export async function clearAdminSession() {
  const jar = await cookies();
  jar.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function hasAdminSession() {
  const jar = await cookies();
  return isValid(jar.get(COOKIE)?.value);
}

/** Require a server-only bearer token for operational APIs. */
export async function requireAdmin(req: Request): Promise<string> {
  if (!env.adminApiToken) throw new Error("ADMIN_DISABLED");
  const authorization = req.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (authorization.startsWith(prefix)) {
    const token = authorization.slice(prefix.length);
    if (safeEqual(token, env.adminApiToken)) return "token-admin";
  }
  if (await hasAdminSession()) return "cookie-admin";
  throw new Error("ADMIN_UNAUTHORIZED");
}
