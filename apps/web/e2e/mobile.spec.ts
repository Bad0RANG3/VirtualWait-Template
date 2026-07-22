import { expect, test } from "@playwright/test";

test("移动端可完成 Mock 扫码登录，页面不产生横向溢出", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "扫码登录" })).toBeVisible();

  await page
    .getByLabel("二维码")
    // Browser projects share one test database. Reuse the same account as the
    // desktop login so the real one-IP/one-account-per-day rule remains on.
    .fill("mock:playwright-user:Playwright玩家:14500:E2E");
  await page.getByRole("button", { name: "扫码登录" }).click();

  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: "Playwright玩家" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
