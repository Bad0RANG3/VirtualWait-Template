import { assertSameOrigin, jsonError, mapServiceError } from "@/lib/api";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await req.body?.cancel();
    return jsonError(
      "AUTH_PASSWORD_DISABLED",
      "账号密码登录已关闭，请使用舞萌二维码登录",
      410
    );
  } catch (err) {
    return mapServiceError(err);
  }
}
