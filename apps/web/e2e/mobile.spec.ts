import { expect, test } from "@playwright/test";
import { fetchCheckinCode, registerThroughUi } from "./helpers";

test("移动端可完成注册登录，页面不产生横向溢出", async ({ page, request }) => {
  const checkin = await fetchCheckinCode(request);

  await page.goto("/login");
  await expect(page.getByRole("button", { name: "注册", exact: true })).toBeVisible();

  await registerThroughUi(page, checkin, {
    // Browser projects share one test database; use a dedicated account so this
    // project never depends on the desktop project's run order.
    username: "mobileuser",
    password: "{{SECRET_qaixt4hr}}",
    nickname: "Mobile玩家",
  });

  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: "Mobile玩家" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
