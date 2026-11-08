import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from "./password";

test("password hashes are salted, verifiable and never stored in plaintext", () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");

  assert.notEqual(first.salt, second.salt, "each hash must use a fresh salt");
  assert.notEqual(first.hash, second.hash, "same password must hash differently");
  assert.ok(!first.hash.includes("correct"), "plaintext must never appear in the hash");

  assert.equal(verifyPassword("correct horse battery staple", first), true);
  assert.equal(verifyPassword("wrong password", first), false);
  assert.equal(verifyPassword("", first), false);
});

test("verification rejects unknown algorithms and empty stored hashes", () => {
  const stored = hashPassword("another-secret-value");
  assert.equal(verifyPassword("another-secret-value", { ...stored, algo: "md5" }), false);
  assert.equal(
    verifyPassword("another-secret-value", { ...stored, hash: null, salt: null }),
    false,
  );
  assert.equal(verifyPassword("another-secret-value", { ...stored, salt: null }), false);
});

test("password policy enforces length and rejects degenerate choices", () => {
  assert.equal(validatePasswordStrength("short"), "PASSWORD_TOO_SHORT");
  assert.equal(validatePasswordStrength("a".repeat(129)), "PASSWORD_TOO_LONG");
  assert.equal(validatePasswordStrength("aaaaaaaa"), "PASSWORD_TOO_WEAK");
  assert.equal(validatePasswordStrength("   " + "a".repeat(4)), "PASSWORD_TOO_SHORT");
  assert.equal(validatePasswordStrength("        "), "INVALID_PASSWORD");
  assert.equal(validatePasswordStrength("password123"), null);
  assert.equal(validatePasswordStrength("中文密码中文密码"), null);
});
