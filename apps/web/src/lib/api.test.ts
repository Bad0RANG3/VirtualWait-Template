import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError, assertSameOrigin, mapServiceError } from "./api";

test("same-origin check accepts the dev server network host header", () => {
  const req = new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "http://192.168.1.28:3000",
      Host: "192.168.1.28:3000",
    },
  });

  assert.doesNotThrow(() => assertSameOrigin(req));
});

test("same-origin check still rejects mismatched origins", () => {
  const req = new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "http://evil.example",
      Host: "192.168.1.28:3000",
    },
  });

  assert.throws(() => assertSameOrigin(req), /CSRF_ORIGIN_INVALID/);
});

test("bearer-authenticated machine calls skip the same-origin check", () => {
  // Cross-site JS cannot set Authorization without a CORS preflight, so an
  // operator script must not be blocked by the browser-only CSRF guard.
  const req = new Request("http://localhost:3000/api/admin/settings", {
    method: "POST",
    headers: { Authorization: "Bearer operator-token" },
  });

  assert.doesNotThrow(() => assertSameOrigin(req));
});

test("defined error codes keep their status and message", async () => {
  const body = await (await mapServiceError(new Error("NOT_AUTHENTICATED"))).json();
  assert.equal(body.error.code, "NOT_AUTHENTICATED");
  assert.equal(body.error.message, "请先登录");

  const custom = await (
    await mapServiceError(new ServiceError("QUEUE_NOT_OPEN", 409, "自定义文案"))
  ).json();
  assert.equal(custom.error.message, "自定义文案");
});

test("unknown internal failures collapse into INTERNAL_ERROR", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = mapServiceError(new Error("database is locked"));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(body.error.message, "服务器错误");
    assert.ok(
      !JSON.stringify(body).includes("database is locked"),
      "internal exception text must never reach the client",
    );
  } finally {
    console.error = originalError;
  }
});
