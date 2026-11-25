import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("account sign-in and profile", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    await browser?.close();
  });

  async function open(signedIn = false, query = "") {
    const context = await browser.newContext();
    contexts.push(context);
    const user = { name: "Alice Example", email: "alice@example.com", id: "user-example" };
    let session: unknown = signedIn ? { user, session: { id: "session-example" } } : null;
    const posts: { path: string; body: unknown }[] = [];
    const failures = { signOut: false };
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "accounts.google.com") {
        await route.fulfill({
          body: "Synthetic Google authorization page",
          contentType: "text/html",
        });
        return;
      }
      if (url.pathname.startsWith("/api/auth/")) {
        if (route.request().method() === "POST") {
          posts.push({ path: url.pathname, body: route.request().postDataJSON() });
          if (url.pathname.endsWith("/sign-out") && failures.signOut) {
            await route.fulfill({ status: 503, json: { message: "Temporarily unavailable" } });
            return;
          }
          if (url.pathname.endsWith("/sign-out")) session = null;
        }
        await route.fulfill({
          json: url.pathname.endsWith("/get-session")
            ? session
            : url.pathname.endsWith("/sign-in/social")
              ? { url: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic" }
              : { success: true },
        });
        return;
      }
      const filename =
        url.pathname === "/auth/" ? "auth/index.html" : url.pathname.replace(/^\/(?:w\/)?/, "");
      const file = path.resolve("lab/ui", filename);
      if (!file.startsWith(path.resolve("lab/ui") + path.sep)) {
        await route.fulfill({ status: 404, body: "Not found" });
        return;
      }
      const body = await readFile(file).catch(() => null);
      await route.fulfill({
        status: body ? 200 : 404,
        body: body ?? "Not found",
        contentType: filename.endsWith(".js")
          ? "text/javascript"
          : filename.endsWith(".css")
            ? "text/css"
            : "text/html",
      });
    });
    const page = await context.newPage();
    await page.goto("https://app.example/auth/" + query);
    return { page, posts, context, failures };
  }

  it("offers Google sign-in and prevents an external callback URL", async () => {
    const { page, posts } = await open(false, "?returnTo=https%3A%2F%2Fother.example%2F");
    const button = page.getByRole("button", { name: "Continue with Google" });
    await expect.poll(() => button.isEnabled()).toBe(true);
    await button.click();
    await expect.poll(() => page.url()).toContain("https://accounts.google.com/");
    expect(posts[0]).toEqual({
      path: "/api/auth/sign-in/social",
      body: {
        provider: "google",
        callbackURL: "/w/",
        errorCallbackURL: "/auth/?error=signin_failed",
      },
    });
  });

  it("shows the profile menu, supports keyboard dismissal, and signs out", async () => {
    const { page, posts } = await open(true);
    await expect.poll(() => page.locator("#profile-name").textContent()).toBe("Alice Example");
    const menu = page.getByRole("button", { name: "Account menu for Alice Example" });
    await menu.focus();
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.getByRole("link", { name: "Your profile" }).isVisible())
      .toBe(true);
    await page.keyboard.press("Escape");
    expect(await menu.getAttribute("aria-expanded")).toBe("false");
    expect(await menu.evaluate((node) => node === document.activeElement)).toBe(true);
    // Sign-out also cleans a closed console. Its own saved rooms remain local.
    await page.evaluate(() => {
      localStorage.setItem(
        "ay.rooms",
        JSON.stringify({
          local: { token: "fixture-local", sync: true, syncId: "local-id" },
          received: { token: "fixture-received", sync: true, syncImported: true },
        }),
      );
      localStorage.setItem("ay.peerOwner", "user-example");
    });
    await menu.click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Continue with Google" }).isVisible())
      .toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ay.rooms") || "{}"))).toEqual(
      {
        local: { token: "fixture-local", sync: false },
      },
    );
    expect(posts).toContainEqual({ path: "/api/auth/sign-out", body: {} });
    expect(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible()).toBe(true);
  });

  it("explains a failed callback and never treats it as a signed-in session", async () => {
    const { page } = await open(false, "?error=access_denied");
    await expect
      .poll(() => page.locator("#auth-status").textContent())
      .toContain("Sign-in was not completed");
    expect(await page.locator("#signed-in").isVisible()).toBe(false);
  });

  it("keeps the profile visible and offers retry when sign-out cannot be confirmed", async () => {
    const { page, failures } = await open(true);
    failures.signOut = true;
    await page.getByRole("button", { name: "Sign out of this account" }).click();
    await expect
      .poll(() => page.locator("#auth-status").textContent())
      .toContain("Sign-out could not be confirmed");
    expect(await page.locator("#signed-in").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Sign out of this account" }).isEnabled()).toBe(
      true,
    );
  });

  it("links to readable privacy and account terms pages", async () => {
    const { page } = await open();
    await page.getByRole("link", { name: "Privacy", exact: true }).click();
    expect(
      await page.getByRole("heading", { name: "Account privacy", exact: true }).isVisible(),
    ).toBe(true);
    await page.getByRole("link", { name: "Account terms", exact: true }).click();
    expect(
      await page.getByRole("heading", { name: "Account terms", exact: true }).isVisible(),
    ).toBe(true);
  });
});
