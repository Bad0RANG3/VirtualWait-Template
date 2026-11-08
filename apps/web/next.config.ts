import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

// Next.js dev mode (webpack HMR + React refresh) evaluates modules with eval,
// so `'unsafe-eval'` is required for the pages to hydrate in `next dev` and in
// the Playwright browser gate. Production keeps the strict policy below.
const scriptSrc = isProduction
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // 纵深防御：默认仅同源加载；Next.js 首屏需要内联脚本/样式，故显式放行
  // 'unsafe-inline'，但仍阻止远程脚本/对象/插件与跨站表单提交。
  {
    key: "Content-Security-Policy",
    value:
      `default-src 'self'; ${scriptSrc}; ` +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
      "font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  // Playwright and some local tooling hit the dev server via 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
