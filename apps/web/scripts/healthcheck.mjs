const timeoutMs = 5_000;
const webUrl =
  process.env.VIRTUALWAIT_WEB_HEALTH_URL || "http://127.0.0.1:3000/api/healthz";

async function check(name, url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(`${name} health check request failed`);
  }
  if (!response.ok) throw new Error(`${name} health check returned ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${name} health check returned invalid JSON`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error(`${name} health check did not report ok`);
  }
}

await check("Web", webUrl);
console.info("VirtualWait local health checks passed");
