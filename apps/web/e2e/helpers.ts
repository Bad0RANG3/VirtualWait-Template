import { expect, type APIRequestContext } from "@playwright/test";

export const adminToken = "playwright-admin-token-0123456789abcdef";

export type CheckinCode = {
  venueId: string;
  venueSlug: string;
  venueName: string;
  code: string;
  expiresAt: string;
};

/**
 * Read the live venue check-in code through the operator API.
 *
 * Registration requires this code, so browser tests authenticate as the
 * operator first — exactly what a real venue does when it posts the code at the
 * counter.
 */
export async function fetchCheckinCode(
  request: APIRequestContext,
  venueSlug = "sample-venue",
): Promise<CheckinCode> {
  const login = await request.post("/api/admin/session", {
    data: { token: adminToken },
  });
  expect(login.ok()).toBeTruthy();

  const listed = await request.get("/api/admin/venues");
  expect(listed.ok()).toBeTruthy();
  const { venues } = (await listed.json()) as {
    venues: Array<{ id: string; slug: string }>;
  };

  for (const venue of venues) {
    const res = await request.get(
      `/api/admin/venues/${encodeURIComponent(venue.id)}/checkin`,
    );
    if (!res.ok()) continue;
    const { checkin } = (await res.json()) as { checkin: CheckinCode };
    if (checkin.venueSlug === venueSlug) return checkin;
  }
  throw new Error(`no check-in code available for venue ${venueSlug}`);
}

/** Fill the register tab of the auth panel and submit it. */
export async function registerThroughUi(
  page: import("@playwright/test").Page,
  checkin: CheckinCode,
  account: { username: string; password: string; nickname: string },
) {
  await page.goto("/login");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByLabel("排队显示名", { exact: true }).fill(account.nickname);
  await page.getByLabel("场地", { exact: true }).selectOption(checkin.venueSlug);
  await page.getByLabel("场地签到码", { exact: true }).fill(checkin.code);
  await page.locator('form button[type="submit"]').click();
}
