import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const repositoryRoot = path.resolve(appRoot, "../..");
const gatewayRoot = path.join(repositoryRoot, "services/sdgb-gateway");
const gatewaySource = path.join(gatewayRoot, "src");
const sharedSecret = "e2e-shared-secret-0123456789abcdef";
const publicIdSecret = "e2e-public-id-secret-0123456789abcdef";
const adminToken = "e2e-admin-token-0123456789abcdef";

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

function start(command, args, options) {
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
  const child = spawn("npm", ["run", "healthcheck"], {
    cwd: appRoot,
    env,
    stdio: "ignore",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, "local Web/Gateway healthcheck should pass");
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

let gateway;
let web;
let tempDirectory;

try {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "virtualwait-e2e-"));
  const gatewayPort = await freePort();
  const webPort = await freePort();
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    GATEWAY_MODE: "remote",
    GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
    GATEWAY_KEY_ID: "dev-web-1",
    GATEWAY_SHARED_SECRET: sharedSecret,
    PUBLIC_ID_HMAC_SECRET: publicIdSecret,
    ADMIN_API_TOKEN: adminToken,
    APP_BASE_URL: baseUrl,
    VIRTUALWAIT_TEST_NOW: "2026-07-16T04:00:00.000Z",
    VIRTUALWAIT_DATA_DIR: path.join(tempDirectory, "web-data"),
  };

  gateway = start("python3", ["-m", "virtualwait_gateway"], {
    cwd: gatewayRoot,
    env: {
      ...env,
      PYTHONPATH: gatewaySource,
      VW_GATEWAY_ENV: "test",
      VW_GATEWAY_PORT: String(gatewayPort),
      VW_GATEWAY_DATABASE_PATH: path.join(tempDirectory, "gateway.db"),
      VW_GATEWAY_SHARED_SECRET: sharedSecret,
      VW_PUBLIC_ID_HMAC_SECRET: publicIdSecret,
    },
  });
  await waitFor(`http://127.0.0.1:${gatewayPort}/healthz`, "Gateway");

  web = start("npm", ["run", "dev", "--", "-p", String(webPort)], { cwd: appRoot, env });
  await waitFor(baseUrl, "Web");
  await runHealthcheck({
    ...env,
    VIRTUALWAIT_WEB_HEALTH_URL: `${baseUrl}/api/healthz`,
    VIRTUALWAIT_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/healthz`,
  });

  const crossSite = await fetch(`${baseUrl}/api/auth/qr`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ qrCode: "mock:e2e-attacker:Attacker" }),
  });
  assert.equal(crossSite.status, 403, "cross-site state change must be rejected");

  const login = await post(baseUrl, "/api/auth/qr", { qrCode: "mock:e2e-user:E2EUser:14500:Test" });
  assert.equal(login.status, 200, "remote signed login should succeed");
  const userCookie = cookie(login);
  const loginBody = await login.json();
  assert.equal(loginBody.status, "SUCCEEDED");
  assert.equal(loginBody.user.nickname, "E2EUser");

  const join = await post(
    baseUrl,
    "/api/queues/heyuan-jianji-anime/old/join",
    { playMode: "SOLO" },
    { Cookie: userCookie }
  );
  assert.equal(join.status, 200, "logged-in user should join an open queue");
  const joinBody = await join.json();

  const processing = await post(baseUrl, "/api/auth/qr", { qrCode: "mock:processing" });
  assert.equal(processing.status, 200);
  const processingBody = await processing.json();
  assert.equal(processingBody.status, "PROCESSING");
  const poll = await fetch(`${baseUrl}/api/auth/attempts/${processingBody.attemptId}`);
  assert.equal(poll.status, 200);
  assert.equal((await poll.json()).status, "PROCESSING");

  const adminLogin = await post(baseUrl, "/api/admin/session", { token: adminToken });
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookie(adminLogin);
  const entries = await fetch(`${baseUrl}/api/admin/entries`, { headers: { Cookie: adminCookie } });
  assert.equal(entries.status, 200);
  const entry = (await entries.json()).entries.find((item) => item.id === joinBody.entryId);
  assert.ok(entry, "admin should see the newly joined entry");
  const publicQueue = await fetch(`${baseUrl}/api/queues/heyuan-jianji-anime/old/public`);
  assert.equal(publicQueue.status, 200);
  const publicBody = await publicQueue.json();
  assert.ok(
    publicBody.slots.some((slot) =>
      slot.status === "WAITING" && slot.entries.some((item) => item.id === joinBody.entryId)
    ),
    "public queue should expose the waiting slot",
  );

  const requeue = await post(
    baseUrl,
    `/api/admin/entries/${entry.id}/action`,
    { action: "START", version: entry.version },
    { Cookie: adminCookie }
  );
  assert.equal(requeue.status, 200, "admin action should accept the current entry version");
  const queueUpdate = await post(
    baseUrl,
    "/api/admin/queues/queue-old/status",
    { status: "PAUSED" },
    { Cookie: adminCookie }
  );
  assert.equal(queueUpdate.status, 200);
  const audit = await fetch(`${baseUrl}/api/admin/audit?limit=10`, { headers: { Cookie: adminCookie } });
  assert.equal(audit.status, 200);
  const auditEvents = (await audit.json()).events;
  assert.ok(auditEvents.some((event) => event.action === "QUEUE_STATUS_CHANGED"));
  assert.ok(auditEvents.some((event) => event.action === "ENTRY_ADMIN_ACTION"));

  // The user cookie is intentionally not needed for the admin flow, but prove
  // the remote login session remained a valid browser session.
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: userCookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.nickname, "E2EUser");
  process.stdout.write("VirtualWait E2E passed\n");
} finally {
  await stop(web);
  await stop(gateway);
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
}
