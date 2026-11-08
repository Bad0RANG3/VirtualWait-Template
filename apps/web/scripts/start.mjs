/**
 * Production entry point (`npm run start`).
 *
 * `next start` binds every interface by default. That is unsafe here because
 * production requires `TRUST_PROXY_HEADERS=true`, which makes
 * `X-Forwarded-For` / `X-Real-IP` the *only* source of a client IP: anything
 * that can reach the port directly could forge its IP and bypass the per-IP
 * registration quota, login rate limits and session IP binding.
 *
 * So the listen address defaults to loopback. Set `HOST=0.0.0.0` only when the
 * platform cannot route through a loopback proxy (e.g. a container network) and
 * make sure nothing else can reach the port. `VIRTUALWAIT_HOST` /
 * `VIRTUALWAIT_PORT` take precedence when `HOST`/`PORT` are already used for
 * something else in the environment.
 */
import { spawn } from "node:child_process";
import path from "node:path";

// Next loads .env itself, but this launcher decides the listen address *before*
// spawning, so load the same files here (existing process environment wins, so
// systemd EnvironmentFile / docker -e still take precedence).
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(process.cwd(), file));
  } catch {
    // File absent or unreadable: fall through to the defaults below.
  }
}

const host =
  process.env.VIRTUALWAIT_HOST || process.env.HOST || "127.0.0.1";
const port = process.env.VIRTUALWAIT_PORT || process.env.PORT || "3000";
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

if (host !== "127.0.0.1" && host !== "::1") {
  console.warn(
    `[virtualwait] listening on ${host}:${port} — ensure only your reverse proxy can reach this port`,
  );
}

const child = spawn(
  process.execPath,
  [nextBin, "start", "-H", host, "-p", port],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
