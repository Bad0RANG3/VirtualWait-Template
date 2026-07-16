import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(scriptDir, "../nginx/virtualwait.conf");
const config = readFileSync(configPath, "utf8");

function requirePattern(pattern, description) {
  assert.match(config, pattern, `Nginx template must ${description}`);
}

function forbidPattern(pattern, description) {
  assert.doesNotMatch(config, pattern, `Nginx template must not ${description}`);
}

requirePattern(/client_max_body_size\s+8k\s*;/, "keep request bodies small at the proxy boundary");
requirePattern(
  /location\s+=\s+\/api\/healthz\s*\{\s*return\s+404\s*;\s*\}/s,
  "hide the local SQLite/process health endpoint from the public virtual host",
);
requirePattern(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/, "proxy public traffic only to the Web service");
requirePattern(
  /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/,
  "overwrite X-Forwarded-For with Nginx's verified remote address",
);
requirePattern(
  /proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/,
  "overwrite X-Real-IP with Nginx's verified remote address",
);
requirePattern(
  /proxy_set_header\s+CF-Connecting-IP\s+""\s*;/,
  "clear CF-Connecting-IP instead of trusting a client-supplied value",
);
requirePattern(/proxy_set_header\s+Host\s+\$host\s*;/, "preserve the requested Host for same-origin checks");
requirePattern(/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/, "forward the verified scheme");

forbidPattern(/\$proxy_add_x_forwarded_for/, "append client-provided forwarded-for chains");
forbidPattern(/proxy_pass\s+https?:\/\/(?!127\.0\.0\.1:3000)/, "proxy to any service other than local Web");
forbidPattern(/listen\s+8787\b/, "expose the Gateway listener");

console.info("VirtualWait Nginx template verified", { configPath });
