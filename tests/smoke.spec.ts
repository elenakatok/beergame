import { test, expect } from "@playwright/test";

test.describe("landing page", () => {
  test("renders hero, role cards, and instructor request CTA", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "The Beer Game" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Students / Players" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Instructors / Admin" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request Instructor Access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join Game" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Instructor / Admin" })).toBeVisible();
  });
});

test.describe("player join flow (no network)", () => {
  test("opens the join form and back button returns home", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Join Game" }).click();
    await expect(page.getByRole("heading", { name: "Join a Game" })).toBeVisible();
    await expect(page.getByLabel("Session code")).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeVisible();

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "The Beer Game" })).toBeVisible();
  });

  test("submit button is disabled until both fields are filled", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Join Game" }).click();

    const submit = page.getByRole("button", { name: "Join Game", exact: true }).last();
    await expect(submit).toBeDisabled();

    await page.getByLabel("Session code").fill("abcd");
    await expect(submit).toBeDisabled();

    await page.getByLabel("Your name").fill("Ava");
    await expect(submit).toBeEnabled();
  });

  test("session code input normalizes to uppercase alphanumerics and caps at 8 chars", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Join Game" }).click();

    const code = page.getByLabel("Session code");
    await code.fill("ab cd-12!@#xyz9999");
    // strip spaces and non-alphanumerics, uppercase, truncate to 8
    await expect(code).toHaveValue("ABCD12XY");
  });
});

test.describe("auth portal", () => {
  test("opens auth portal and switches between Sign in / Register / Reset tabs", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Instructor / Admin" }).click();

    await expect(page.getByRole("heading", { name: "Instructor / Admin Access" })).toBeVisible();

    // default: login mode
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    await page.getByRole("tab", { name: "Register" }).click();
    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel("Institution")).toBeVisible();
    await expect(page.getByLabel("Country")).toBeVisible();

    await page.getByRole("tab", { name: "Reset password" }).click();
    await expect(page.getByRole("button", { name: /Send reset email/ })).toBeVisible();

    await page.getByRole("tab", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: /Sign in/ })).toBeVisible();
  });

  test("Request Instructor Access opens the auth portal in Register mode", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Request Instructor Access" }).click();
    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel("Institution")).toBeVisible();
  });
});
