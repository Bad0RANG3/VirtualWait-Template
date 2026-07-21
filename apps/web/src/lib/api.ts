import { NextResponse } from "next/server";
import { env } from "./env";

const DEFAULT_JSON_BODY_MAX_BYTES = 4 * 1024;

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
  const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
  const messages: Record<string, [number, string]> = {
    QUEUE_NOT_FOUND: [404, "队列不存在"],
    QUEUE_NOT_OPEN: [409, "队列未开放"],
    QUEUE_OUTSIDE_HOURS: [409, "当前不在开放时间"],
    ALREADY_IN_QUEUE: [409, "你已在该队列中"],
    ALREADY_IN_ANOTHER_QUEUE: [409, "你已在其他机台排队，请先卸卡"],
    ENTRY_NOT_FOUND: [404, "排队记录不存在"],
    FORBIDDEN: [403, "无权操作该记录"],
    INVALID_STATUS: [409, "当前状态不可执行该操作"],
    NICKNAME_TAKEN: [409, "昵称已被占用"],
    AUTH_PASSWORD_DISABLED: [410, "账号密码登录已关闭，请使用舞萌二维码登录"],
    NOT_AUTHENTICATED: [401, "请先登录"],
    INVALID_PLAYING_TIMEOUT: [400, "游玩超时需在 1 分钟到 24 小时之间"],
    INVALID_HEAD_CONFIRM_TIMEOUT: [400, "队头确认超时需在 30 秒到 60 分钟之间"],
    INVALID_MACHINE_COUNT: [400, "机台数量无效"],
    INVALID_COIN_COST: [400, "机台硬币数需在 1-99"],
    INVALID_REGION_KIND: [400, "区县类型无效"],
    INVALID_VENUE_HOURS: [400, "开放时间无效，结束须晚于开始"],
    VENUE_NOT_FOUND: [404, "场地不存在"],
    NOT_BOUND: [409, "请先绑定舞萌数据"],
    PARTY_NOT_FOUND: [404, "拼机队伍不存在"],
    PARTY_NOT_SEEKING: [409, "该拼机位已不可加入"],
    PARTY_FULL: [409, "该拼机位已满"],
    CANNOT_JOIN_OWN_PARTY: [409, "不能加入自己的拼机"],
    PARTY_HOST_MISSING: [409, "拼机发起人已不在队列"],
    NOT_DUO: [409, "不是拼机队伍"],
    INVALID_PARTY_STATUS: [409, "当前拼机状态不可确认"],
    BIND_CONFLICT: [409, "该舞萌账号已绑定其他用户"],
    IDENTITY_MISMATCH: [409, "二维码与当前登录账号不一致"],
    IP_ACCOUNT_BOUND: [409, "该网络地址今日已绑定其他账号"],
    RATE_LIMITED: [429, "请求过于频繁，请稍后再试"],
    QR_BUSY: [429, "当前登录人数较多，请稍后再试"],
    GATEWAY_CREATE_FAILED: [502, "舞萌验证服务暂不可用"],
    SESSION_IP_MISMATCH: [401, "登录环境已变化，请重新扫码"],
    GATEWAY_FAILED: [502, "舞萌验证失败，请重试"],
    QR_EXPIRED: [400, "二维码已过期或已使用，请重新打开微信二维码"],
    QR_EXCHANGE_FAILED: [502, "二维码验证失败，请重试"],
    UPSTREAM_TIMEOUT: [504, "舞萌服务器响应超时，请稍后重试"],
    UPSTREAM_PROTOCOL_ERROR: [502, "舞萌验证服务异常，请稍后重试"],
    PROFILE_INCOMPLETE: [502, "账号资料不完整，无法登录"],
    ACCOUNT_BANNED: [403, "该账号无法用于登录"],
    INVALID_REQUEST: [400, "请求参数无效"],
    REQUEST_BODY_TOO_LARGE: [413, "请求体过大"],
    CSRF_ORIGIN_INVALID: [403, "请求来源无效"],
    IDEMPOTENCY_KEY_REUSED: [409, "请求标识不能用于当前会话"],
    AUTH_ATTEMPT_NOT_FOUND: [404, "验证任务不存在或已过期"],
    ADMIN_DISABLED: [503, "管理员接口未配置"],
    ADMIN_UNAUTHORIZED: [401, "管理员认证失败"],
    ENTRY_VERSION_CONFLICT: [409, "排队记录已被其他操作更新，请刷新后重试"],
    ADMIN_ACTION_NOT_ALLOWED: [409, "该记录当前不支持此管理员操作"],
    NOT_HEAD_OF_QUEUE: [409, "当前不是队头，暂不能上机"],
    MACHINE_BUSY: [409, "机台仍有人在游玩，请稍候"],
    PAIR_NOT_CONFIRMED: [409, "拼机双方确认后才能上机"],
  };
  const [status, message] = messages[code] || [500, "服务器错误"];
  return jsonError(code, message, status);
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
