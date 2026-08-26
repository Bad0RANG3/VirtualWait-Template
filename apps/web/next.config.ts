import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // 纵深防御：默认仅同源加载；Next.js 首屏需要内联脚本/样式，故显式放行
  // 'unsafe-inline'，但仍阻止远程脚本/对象/插件与跨站表单提交。
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
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
