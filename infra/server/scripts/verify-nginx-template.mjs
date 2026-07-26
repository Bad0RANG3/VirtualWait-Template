import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function verifyTemplate(configPath, description, checks) {
  const config = readFileSync(configPath, "utf8");
  const prefix = `${path.basename(configPath)} (${description})`;

  function requirePattern(pattern, msg) {
    assert.match(config, pattern, `${prefix}: must ${msg}`);
  }
  function forbidPattern(pattern, msg) {
    assert.doesNotMatch(config, pattern, `${prefix}: must not ${msg}`);
  }

  checks({ requirePattern, forbidPattern, config });
}

// --- Production TLS template ---
verifyTemplate(
  path.resolve(scriptDir, "../nginx/virtualwait.conf"),
  "production TLS",
  ({ requirePattern, forbidPattern }) => {
    requirePattern(/client_max_body_size\s+8k\s*;/, "limit request body size");
    requirePattern(
      /location\s+=\s+\/api\/healthz\s*\{\s*return\s+404\s*;\s*\}/s,
      "hide the health endpoint",
    );
    requirePattern(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/, "proxy to Web");
    requirePattern(
      /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/,
      "overwrite X-Forwarded-For",
    );
    requirePattern(
      /proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/,
      "overwrite X-Real-IP",
    );
    requirePattern(
      /proxy_set_header\s+CF-Connecting-IP\s+""\s*;/,
      "clear CF-Connecting-IP",
    );
    requirePattern(/proxy_set_header\s+Host\s+\$host\s*;/, "preserve Host header");
    requirePattern(
      /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/,
      "forward scheme",
    );

    // TLS-specific checks
    requirePattern(/listen\s+443\s+ssl\s+http2\s*;/, "listen on TLS");
    requirePattern(
      /return\s+301\s+https:\/\/\$host\$request_uri\s*;/,
      "redirect HTTP to HTTPS",
    );
    requirePattern(/ssl_certificate\s+\//, "declare a certificate path");
    requirePattern(/ssl_certificate_key\s+\//, "declare a certificate key path");
    requirePattern(/proxy_read_timeout\s+30s\s*;/, "set proxy read timeout");
    requirePattern(/proxy_send_timeout\s+30s\s*;/, "set proxy send timeout");
    requirePattern(/proxy_connect_timeout\s+5s\s*;/, "set proxy connect timeout");
    requirePattern(/client_header_timeout\s+10s\s*;/, "set client header timeout");
    requirePattern(/client_body_timeout\s+10s\s*;/, "set client body timeout");

    forbidPattern(/\$proxy_add_x_forwarded_for/, "append client-provided XFF");
    forbidPattern(
      /proxy_pass\s+https?:\/\/(?!127\.0\.0\.1:3000)/,
      "proxy to any service other than local Web",
    );
    forbidPattern(/listen\s+8787\b/, "expose the Gateway listener");
  }
);

// --- Intranet / development HTTP template (deliberately unsafe) ---
verifyTemplate(
  path.resolve(scriptDir, "../nginx/virtualwait-intranet.conf"),
  "intranet HTTP",
  ({ requirePattern, forbidPattern }) => {
    requirePattern(/client_max_body_size\s+8k\s*;/, "limit request body size");
    requirePattern(
      /location\s+=\s+\/api\/healthz\s*\{\s*return\s+404\s*;\s*\}/s,
      "hide the health endpoint",
    );
    requirePattern(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/, "proxy to Web");
    requirePattern(
      /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/,
      "overwrite X-Forwarded-For",
    );
    requirePattern(
      /proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/,
      "overwrite X-Real-IP",
    );
    requirePattern(
      /proxy_set_header\s+CF-Connecting-IP\s+""\s*;/,
      "clear CF-Connecting-IP",
    );

    // Must NOT be mistaken for a public-safe config.
    forbidPattern(/listen\s+443\s+ssl/, "listen on TLS");
    forbidPattern(/ssl_certificate/, "reference a TLS certificate");
    forbidPattern(/Strict-Transport-Security/, "set HSTS on an HTTP-only template");
    forbidPattern(/\$proxy_add_x_forwarded_for/, "append client-provided XFF");
  }
);

console.info("VirtualWait Nginx templates verified", { scriptDir });
