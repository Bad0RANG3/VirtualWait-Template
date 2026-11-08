/**
 * API 公共原语：错误码→HTTP 映射、JSON 响应、同源校验、请求体读取、
 * 以及用户/管理员权限包装（withUser / withAdmin）。
 */
import { NextResponse } from "next/server";
import { env } from "./env";

const DEFAULT_JSON_BODY_MAX_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// Typed service errors
// ---------------------------------------------------------------------------

const ERROR_MAP: Record<string, [number, string]> = {
  QUEUE_NOT_FOUND: [404, "队列不存在"],
  QUEUE_NOT_OPEN: [409, "队列未开放"],
  QUEUE_OUTSIDE_HOURS: [409, "当前不在开放时间"],
  ALREADY_IN_ANOTHER_QUEUE: [409, "你已在其他机台排队，请先取消排队"],
  ENTRY_NOT_FOUND: [404, "排队记录不存在"],
  FORBIDDEN: [403, "无权操作该记录"],
  INVALID_STATUS: [409, "当前状态不可执行该操作"],
  NICKNAME_TAKEN: [409, "昵称已被占用"],
  QQ_TAKEN: [409, "该 QQ 已被其他账号绑定"],
  QQ_REQUIRED: [409, "请先在个人页绑定 QQ 号后再排队"],
  INVALID_QQ: [400, "QQ 号格式无效，请填写 5-12 位数字或留空"],
  BOT_DISABLED: [503, "机器人接口未配置"],
  BOT_UNAUTHORIZED: [401, "机器人认证失败"],
  NOT_AUTHENTICATED: [401, "请先登录"],
  REGISTRATION_DISABLED: [403, "当前未开放注册，请联系现场管理员"],
  USERNAME_TAKEN: [409, "该用户名已被注册"],
  INVALID_USERNAME: [400, "用户名需为 3-20 位字母、数字、下划线或短横线"],
  INVALID_NICKNAME: [400, "昵称需为 2-20 个可见字符"],
  INVALID_PASSWORD: [400, "密码无效"],
  PASSWORD_TOO_SHORT: [400, "密码至少 8 位"],
  PASSWORD_TOO_LONG: [400, "密码最多 128 位"],
  PASSWORD_TOO_WEAK: [400, "密码过于简单，请更换更复杂的密码"],
  INVALID_CREDENTIALS: [401, "用户名或密码不正确"],
  CHECKIN_REQUIRED: [400, "请输入当前场地的签到码"],
  CHECKIN_INVALID: [403, "签到码不正确或已过期，请向现场工作人员确认最新签到码"],
  CHECKIN_VENUE_UNKNOWN: [404, "场地不存在或未开放注册"],
  INVALID_PLAYING_TIMEOUT: [400, "游玩超时需在 1 分钟到 24 小时之间"],
  INVALID_HEAD_CONFIRM_TIMEOUT: [400, "队头确认超时需在 30 秒到 60 分钟之间"],
  INVALID_MACHINE_COUNT: [400, "机台数量无效"],
  INVALID_COIN_COST: [400, "机台硬币数需在 1-99"],
  INVALID_REGION_KIND: [400, "区县类型无效"],
  INVALID_VENUE_HOURS: [400, "开放时间无效，结束须晚于开始"],
  VENUE_NOT_FOUND: [404, "场地不存在"],
  PARTY_NOT_FOUND: [404, "拼机队伍不存在"],
  PARTY_NOT_SEEKING: [409, "该拼机位已不可加入"],
  PARTY_FULL: [409, "该拼机位已满"],
  CANNOT_JOIN_OWN_PARTY: [409, "不能加入自己的拼机"],
  PARTY_HOST_MISSING: [409, "拼机发起人已不在队列"],
  NOT_DUO: [409, "不是拼机队伍"],
  INVALID_PARTY_STATUS: [409, "当前拼机状态不可确认"],
  IP_ACCOUNT_BOUND: [409, "该网络地址今日注册的账号过多，请明日再试"],
  RATE_LIMITED: [429, "请求过于频繁，请稍后再试"],
  INVALID_REQUEST: [400, "请求参数无效"],
  REQUEST_BODY_TOO_LARGE: [413, "请求体过大"],
  CSRF_ORIGIN_INVALID: [403, "请求来源无效"],
  ADMIN_DISABLED: [503, "管理员接口未配置"],
  ADMIN_UNAUTHORIZED: [401, "管理员认证失败"],
  ENTRY_VERSION_CONFLICT: [409, "排队记录已被其他操作更新，请刷新后重试"],
  ADMIN_ACTION_NOT_ALLOWED: [409, "该记录当前不支持此管理员操作"],
  NOT_HEAD_OF_QUEUE: [409, "当前不是队头，暂不能上机"],
  MACHINE_BUSY: [409, "机台仍有人在游玩，请稍候"],
  PAIR_NOT_CONFIRMED: [409, "拼机双方确认后才能上机"],
  INTERNAL_ERROR: [500, "服务器错误"],
};

/** Structured service error carrying a code, suggested HTTP status, and
 *  user-facing default message.  Use this everywhere instead of
 *  ``throw new Error("CODE")``. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number = 400,
    readonly publicMessage?: string,
  ) {
    super(code);
  }
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  // API responses can contain a user's queue state. Do not let intermediaries
  // replay or serve one user's response to another user.
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export function jsonError(
  code: string,
  message: string,
  status = 400,
  extra?: Record<string, unknown>
) {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(
    { error: { code, message, ...extra } },
    { status, headers }
  );
}

/**
 * Reject cross-site state-changing requests that could otherwise carry a
 * session cookie. APP_BASE_URL is mandatory in production, so this comparison
 * does not depend on attacker-controlled Host headers.
 */
function requestHostOrigin(req: Request) {
  const host = req.headers.get("host");
  if (!host) return null;
  const reqUrl = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProto || reqUrl.protocol.replace(/:$/, "");
  return `${protocol}://${host}`;
}

export function assertSameOrigin(req: Request): void {
  // A Bearer-authenticated request is a machine caller (operator script, CI),
  // not a cookie-carrying browser: cross-site JS cannot set Authorization
  // without a CORS preflight these routes never grant, so there is no CSRF
  // surface to protect here.
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return;

  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");

  if (!origin) {
    if (process.env.NODE_ENV === "production" || fetchSite === "cross-site") {
      throw new Error("CSRF_ORIGIN_INVALID");
    }
    return;
  }

  const allowedOrigins = new Set([new URL(env.appBaseUrl || req.url).origin]);

  // In `next dev`, Request.url can be normalized to localhost even when the
  // browser is using the printed Network URL such as http://192.168.x.x:3000.
  // Production has APP_BASE_URL pinned, but local development should accept the
  // actual Host header so phones/tablets on the LAN can exercise the UI.
  if (process.env.NODE_ENV !== "production" && !env.appBaseUrl) {
    const hostOrigin = requestHostOrigin(req);
    if (hostOrigin) allowedOrigins.add(hostOrigin);
  }

  if (!allowedOrigins.has(origin)) throw new Error("CSRF_ORIGIN_INVALID");
}

export function mapServiceError(err: unknown) {
  if (err instanceof ServiceError) {
    const [status, message] = ERROR_MAP[err.code] || [500, "服务器错误"];
    return jsonError(err.code, err.publicMessage || message, status);
  }
  // Only codes we deliberately defined may reach the client. An arbitrary
  // internal exception message (SQLite text, file paths, ...) must never become
  // a public error code, so unknown failures collapse into INTERNAL_ERROR and
  // the original error is logged server-side instead.
  const raw = err instanceof Error ? err.message : "";
  const mapped = ERROR_MAP[raw];
  if (mapped) return jsonError(raw, mapped[1], mapped[0]);
  console.error("unhandled service error", err);
  return jsonError("INTERNAL_ERROR", "服务器错误", 500);
}

type JsonBodyOptions<T> = {
  maxBytes?: number;
  emptyBody?: T;
};

async function readTextBodyWithLimit(req: Request, maxBytes: number) {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await req.body?.cancel().catch(() => undefined);
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
  }

  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("REQUEST_BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readJsonBody<T = never>(
  req: Request,
  options: JsonBodyOptions<T> = {}
) {
  const raw = await readTextBodyWithLimit(
    req,
    options.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES
  );
  if (!raw.trim()) {
    if ("emptyBody" in options) return options.emptyBody as T;
    throw new Error("INVALID_REQUEST");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}

// ---------------------------------------------------------------------------
// Route-handler wrappers — reduce boilerplate try/catch + auth + validation
// ---------------------------------------------------------------------------

import type { SessionUser } from "./types";

/**
 * Wrap a user-authenticated route handler.  Injects the session user and
 * (optionally) a Zod-validated body.  Handles same-origin enforcement,
 * try/catch, ZodError → 400, and ServiceError → HTTP mapping.
 */
export function withUser<
  T = unknown,
>(
  fn: (req: Request, user: SessionUser, body?: T) => Promise<Response>,
  opts?: { requireOrigin?: boolean; bodySchema?: import("zod").ZodType<T> },
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      if (opts?.requireOrigin !== false) assertSameOrigin(req);
      const user = await (
        await import("./auth/session")
      ).getSessionUser(req);
      if (!user) return mapServiceError(new Error("NOT_AUTHENTICATED"));
      let body: T | undefined;
      if (opts?.bodySchema) {
        body = opts.bodySchema.parse(await readJsonBody(req));
      }
      return fn(req, user, body);
    } catch (err) {
      if (err instanceof (await import("zod")).z.ZodError) {
        return jsonError(
          "INVALID_REQUEST",
          (err as import("zod").ZodError).errors[0]?.message || "参数无效",
        );
      }
      return mapServiceError(err);
    }
  };
}

/**
 * Wrap an admin-authenticated route handler.  Same structure as
 * ``withUser`` but authorises via the admin bearer/cookie flow.
 */
export function withAdmin<T = unknown>(
  fn: (req: Request, body?: T) => Promise<Response>,
  opts?: { bodySchema?: import("zod").ZodType<T> },
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      const { requireAdmin } = await import("./auth/admin");
      await requireAdmin(req);
      let body: T | undefined;
      if (opts?.bodySchema) {
        body = opts.bodySchema.parse(await readJsonBody(req));
      }
      return fn(req, body);
    } catch (err) {
      if (err instanceof (await import("zod")).z.ZodError) {
        return jsonError(
          "INVALID_REQUEST",
          (err as import("zod").ZodError).errors[0]?.message || "参数无效",
        );
      }
      return mapServiceError(err);
    }
  };
}
