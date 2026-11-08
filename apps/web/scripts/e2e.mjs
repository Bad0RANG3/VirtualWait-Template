import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const adminToken = "e2e-admin-token-0123456789abcdef";
const sessionSecret = "e2e-shared-secret-0123456789abcdef";

const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");
const healthcheckScript = path.join(appRoot, "scripts", "healthcheck.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(url, name) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not become ready: ${String(lastError)}`);
}

function spawnProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "ignore" });
  child.once("error", (error) => {
    throw error;
  });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runHealthcheck(env) {
  const child = spawn(process.execPath, [healthcheckScript], {
    cwd: appRoot,
    env,
    stdio: "ignore",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, "local Web healthcheck should pass");
}

function cookie(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "expected an HttpOnly session cookie");
  return header.split(";", 1)[0];
}

async function post(baseUrl, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function patch(baseUrl, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "PATCH",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

let web;
let tempDirectory;

try {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "virtualwait-e2e-"));
  const webPort = await freePort();
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    SESSION_SECRET: sessionSecret,
    ADMIN_API_TOKEN: adminToken,
    APP_BASE_URL: baseUrl,
    REGISTRATION_ENABLED: "true",
    CHECKIN_REQUIRED: "true",
    TRUST_PROXY_HEADERS: "false",
    VIRTUALWAIT_TEST_NOW: "2026-07-16T04:00:00.000Z",
    VIRTUALWAIT_DATA_DIR: path.join(tempDirectory, "web-data"),
  };

  web = spawnProcess(
    process.execPath,
    [nextBin, "dev", "-p", String(webPort)],
    {
      cwd: appRoot,
      env: { ...env, NODE_OPTIONS: "--experimental-sqlite" },
    },
  );
  await waitFor(baseUrl, "Web");
  await runHealthcheck({
    ...env,
    VIRTUALWAIT_WEB_HEALTH_URL: `${baseUrl}/api/healthz`,
  });

  // Cross-site state changes must be rejected before any account work happens.
  const crossSite = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ username: "attacker", password: "attacker-password", nickname: "Attacker" }),
  });
  assert.equal(crossSite.status, 403, "cross-site state change must be rejected");

  // ---- Operator session, used to read the live venue check-in code ----------
  const adminLogin = await post(baseUrl, "/api/admin/session", { token: adminToken });
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookie(adminLogin);

  const venueList = await fetch(`${baseUrl}/api/admin/venues`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(venueList.status, 200);
  const venues = (await venueList.json()).venues;
  assert.ok(Array.isArray(venues) && venues.length > 0, "admin must see the seeded venues");

  let checkin = null;
  for (const venue of venues) {
    const res = await fetch(`${baseUrl}/api/admin/venues/${encodeURIComponent(venue.id)}/checkin`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.checkin.code, /^\d{6}$/, "check-in code must be six digits");
    checkin = data.checkin;
  }
  assert.ok(checkin, "at least one venue check-in code must be available");

  // ---- Registration requires a valid check-in code -------------------------
  const badCheckin = await post(baseUrl, "/api/auth/register", {
    username: "e2euser",
    password: "e2e-player-password",
    nickname: "E2EUser",
    venueSlug: checkin.venueSlug,
    checkinCode: "000000",
  });
  assert.equal(badCheckin.status, 403, "a wrong check-in code must be rejected");
  assert.equal((await badCheckin.json()).error.code, "CHECKIN_INVALID");

  const register = await post(baseUrl, "/api/auth/register", {
    username: "e2euser",
    password: "e2e-player-password",
    nickname: "E2EUser",
    venueSlug: checkin.venueSlug,
    checkinCode: checkin.code,
  });
  assert.equal(register.status, 200, "registration with a live code must succeed");
  const userCookie = cookie(register);
  const registered = await register.json();
  assert.equal(registered.user.username, "e2euser");
  assert.equal(registered.user.nickname, "E2EUser");

  // Duplicate usernames are rejected case-insensitively.
  const duplicate = await post(baseUrl, "/api/auth/register", {
    username: "E2EUser",
    password: "another-player-password",
    nickname: "OtherNick",
    venueSlug: checkin.venueSlug,
    checkinCode: checkin.code,
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "USERNAME_TAKEN");

  // ---- Password login ------------------------------------------------------
  const wrongPassword = await post(baseUrl, "/api/auth/login", {
    username: "e2euser",
    password: "not-the-password",
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal((await wrongPassword.json()).error.code, "INVALID_CREDENTIALS");

  const login = await post(baseUrl, "/api/auth/login", {
    username: "E2EUser",
    password: "e2e-player-password",
  });
  assert.equal(login.status, 200, "correct credentials must log in");
  const loginCookie = cookie(login);
  assert.equal((await login.json()).user.nickname, "E2EUser");

  // ---- Profile: bind QQ, then queue ---------------------------------------
  const bindQq = await patch(
    baseUrl,
    "/api/auth/me",
    { qq: "12345678" },
    { Cookie: loginCookie },
  );
  assert.equal(bindQq.status, 200, "logged-in user should be able to bind a QQ number");
  assert.equal((await bindQq.json()).user.qq, "12345678");

  const join = await post(
    baseUrl,
    "/api/queues/sample-venue/machine-a/join",
    { playMode: "SOLO" },
    { Cookie: loginCookie },
  );
  assert.equal(join.status, 200, "logged-in user should join an open queue");
  const joinBody = await join.json();

  const publicQueue = await fetch(`${baseUrl}/api/queues/sample-venue/machine-a/public`);
  assert.equal(publicQueue.status, 200);
  const publicBody = await publicQueue.json();
  assert.ok(
    publicBody.slots.some((slot) =>
      slot.status === "WAITING" && slot.entries.some((item) => item.id === joinBody.entryId),
    ),
    "public queue should expose the waiting slot",
  );
  const serializedPublic = JSON.stringify(publicBody);
  assert.ok(!serializedPublic.includes("12345678"), "public queue must never expose QQ numbers");

  // ---- Admin operations ----------------------------------------------------
  const entries = await fetch(`${baseUrl}/api/admin/entries`, { headers: { Cookie: adminCookie } });
  assert.equal(entries.status, 200);
  const entry = (await entries.json()).entries.find((item) => item.id === joinBody.entryId);
  assert.ok(entry, "admin should see the newly joined entry");

  const start = await post(
    baseUrl,
    `/api/admin/entries/${entry.id}/action`,
    { action: "START", version: entry.version },
    { Cookie: adminCookie },
  );
  assert.equal(start.status, 200, "admin action should accept the current entry version");

  const queueUpdate = await post(
    baseUrl,
    "/api/admin/queues/queue-a/status",
    { status: "PAUSED" },
    { Cookie: adminCookie },
  );
  assert.equal(queueUpdate.status, 200);

  const audit = await fetch(`${baseUrl}/api/admin/audit?limit=20`, { headers: { Cookie: adminCookie } });
  assert.equal(audit.status, 200);
  const auditEvents = (await audit.json()).events;
  assert.ok(auditEvents.some((event) => event.action === "QUEUE_STATUS_CHANGED"));
  assert.ok(auditEvents.some((event) => event.action === "ENTRY_ADMIN_ACTION"));
  assert.ok(auditEvents.some((event) => event.action === "ACCOUNT_REGISTERED"));

  // The session created by the first (registration) cookie is still valid.
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: userCookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.nickname, "E2EUser");

  // Logout revokes the session server-side.
  const logout = await post(baseUrl, "/api/auth/logout", {}, { Cookie: loginCookie });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: loginCookie } });
  assert.equal((await afterLogout.json()).user, null, "revoked session must not resolve");

  process.stdout.write("VirtualWait E2E passed\n");
} finally {
  await stop(web);
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
}
