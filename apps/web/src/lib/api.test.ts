import assert from "node:assert/strict";
import test from "node:test";
import { assertSameOrigin } from "./api";

test("same-origin check accepts the dev server network host header", () => {
  const req = new Request("http://localhost:3000/api/auth/qr", {
    method: "POST",
    headers: {
      Origin: "http://192.168.1.28:3000",
      Host: "192.168.1.28:3000",
    },
  });

  assert.doesNotThrow(() => assertSameOrigin(req));
});

test("same-origin check still rejects mismatched origins", () => {
  const req = new Request("http://localhost:3000/api/auth/qr", {
    method: "POST",
    headers: {
      Origin: "http://evil.example",
      Host: "192.168.1.28:3000",
    },
  });

  assert.throws(() => assertSameOrigin(req), /CSRF_ORIGIN_INVALID/);
});
