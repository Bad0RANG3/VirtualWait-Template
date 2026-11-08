import { expect, test } from "@playwright/test";
import { adminToken, fetchCheckinCode, registerThroughUi } from "./helpers";

test("玩家可凭场地签到码注册账号并登录", async ({ page, request }) => {
  const checkin = await fetchCheckinCode(request);
  await registerThroughUi(page, checkin, {
    username: "playwrightuser",
    password: "{{SECRET_q4bxrgmi}}",
    nickname: "Playwright玩家",
  });

  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: "Playwright玩家" })).toBeVisible();

  // 退出后用用户名 + 口令重新登录。
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("playwrightuser");
  await page.getByLabel("密码", { exact: true }).fill("{{SECRET_q4bxrgmi}}");
  // The "登录" tab and the submit button share the same label; target the form
  // submit button explicitly.
  await expect(page.locator('form button[type="submit"]')).toHaveText(/登录/);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: "Playwright玩家" })).toBeVisible();

  // 错误口令必须被拒绝。
  await page.getByRole("button", { name: "退出" }).click();
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("playwrightuser");
  await page.getByLabel("密码", { exact: true }).fill("wrong-password-value");
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText("用户名或密码不正确")).toBeVisible();
});

test("管理员可登录、查看签到码并暂停队列", async ({ page }) => {
  await page.goto("/admin");
  await page.getByLabel("令牌", { exact: true }).fill(adminToken);
  await page.getByRole("button", { name: "进入" }).click();
  // "运维" 是 "运维登录" 的子串，必须 exact 才等到真正的控制台。
  await expect(page.getByRole("heading", { name: "运维", exact: true })).toBeVisible();

  // 签到码面板展示当前有效的 6 位码。
  const checkinPanel = page
    .locator("section")
    .filter({ hasText: "场地签到码" })
    .first();
  await expect(checkinPanel).toBeVisible();
  await expect(checkinPanel.getByText(/^\d{6}$/).first()).toBeVisible();

  await page.getByRole("button", { name: "暂停" }).first().click();
  await expect(page.getByText("PAUSED").first()).toBeVisible();
  await expect(page.getByText("QUEUE_STATUS_CHANGED").first()).toBeVisible();
});
