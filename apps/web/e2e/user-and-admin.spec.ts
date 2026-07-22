import { expect, test } from "@playwright/test";

const adminToken = "playwright-admin-token-0123456789abcdef";

test("用户可通过 Mock 二维码登录", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("二维码").fill("mock:playwright-user:Playwright玩家:14500:E2E");
  await page.getByRole("button", { name: "扫码登录" }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: "Playwright玩家" })).toBeVisible();
});

test("管理员可登录并暂停队列", async ({ page }) => {
  await page.goto("/admin");
  await page.getByLabel("令牌").fill(adminToken);
  await page.getByRole("button", { name: "进入" }).click();
  await expect(page.getByRole("heading", { name: "运维" })).toBeVisible();
  await page.getByRole("button", { name: "暂停" }).first().click();
  await expect(page.getByText("PAUSED").first()).toBeVisible();
  await expect(page.getByText("QUEUE_STATUS_CHANGED").first()).toBeVisible();
});
