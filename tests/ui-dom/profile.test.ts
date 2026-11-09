/**
 * The optional profile menu in the REAL console (lab/ui/index.html).
 *
 * Sign-in is optional and exists only where the site serves /_ay/auth/*
 * (agent-yes.com). The console must look exactly as before on a self-hosted
 * domain or `ay serve` (no auth route), and rooms must work without ever
 * signing in. Signed in, the menu shows name + email and the "My data" panel;
 * each saved room shows whether it syncs (☁) or stays on this device (⌂).
 */
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "./server.ts";

const TERMINAL_STUB =
  "window.Terminal=class{constructor(){this.cols=80;this.rows=24;this.element=null;}" +
  "loadAddon(){}open(el){this.element=el;}focus(){}onTitleChange(){}onResize(){}onScroll(){}" +
  "onData(){}onBinary(){}write(){}resize(){}hasSelection(){return false;}getSelection(){return '';}" +
  "getSelectionPosition(){return null;}clearSelection(){}dispose(){}};";
const FITADDON_STUB = "window.FitAddon={FitAddon:class{activate(){}dispose(){}fit(){}}};";

const NOW = Date.now();
const ROOMS = {
  "alpha-room": { token: "t-alpha", host: "s.agent-yes.com", ts: NOW, added: NOW },
  "beta-room": {
    token: "t-beta",
    host: "s.agent-yes.com",
    ts: NOW - 1000,
    added: NOW,
    localOnly: true,
  },
};

async function open(browser: Browser, url: string, seedRooms = false): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/cdn\.jsdelivr\.net|\/vendor\/[\w-]+\.min\.js/, (route) => {
    const body = route.request().url().includes("addon-fit") ? FITADDON_STUB : TERMINAL_STUB;
    route.fulfill({ status: 200, contentType: "application/javascript", body });
  });
  const page = await ctx.newPage();
  if (seedRooms)
    await page.addInitScript((r) => localStorage.setItem("ay.rooms", JSON.stringify(r)), ROOMS);
  await page.goto(url);
  await page.waitForSelector(".list .row", { timeout: 10_000 });
  return page;
}

describe("profile menu", () => {
  let browser: Browser;
  const servers: Array<() => void> = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    servers.forEach((c) => c());
  });

  it("shows nothing where the site has no sign-in (self-hosted, ay serve)", async () => {
    const s = await startServer();
    servers.push(s.close);
    const page = await open(browser, s.url);
    await page.waitForTimeout(500);
    expect(await page.locator("#profile .ayp").count()).toBe(0);
    expect(await page.locator("#profile").innerHTML()).toBe("");
    await page.context().close();
  });

  it("signed out: one optional Sign in button listing the site's providers", async () => {
    const s = await startServer(undefined, {
      auth: { providers: ["google", "github"], user: null },
    });
    servers.push(s.close);
    const page = await open(browser, s.url);
    await page.waitForSelector("#profile .ayp > button");
    await page.click("#profile .ayp > button");
    const items = await page.locator("#profile .aypm button").allTextContents();
    expect(items).toEqual(["Sign in with Google", "Sign in with GitHub"]);
    await page.context().close();
  });

  it("signed in: name, email, rooms marked synced or device-only, and the data panel", async () => {
    const s = await startServer(undefined, {
      auth: { providers: ["google"], user: { name: "Alice", email: "alice@example.com" } },
    });
    servers.push(s.close);
    const page = await open(browser, s.url, true);
    await page.waitForSelector("#profile .ayp > button");
    await page.click("#profile .ayp > button");
    const who = await page.locator("#profile .who").innerText();
    expect(who).toContain("Alice");
    expect(who).toContain("alice@example.com");

    // The rooms panel marks each room: ☁ synced, ⌂ this device only.
    await page.click("#conn");
    await page.waitForSelector(".rooms .ritem .rsyn");
    const icons = await page
      .locator(".rooms .ritem")
      .evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((r) => [
            r.querySelector(".rname")?.textContent,
            r.querySelector(".rsyn")?.textContent,
          ]),
        ),
      );
    expect(icons).toEqual({ "alpha-room": "☁", "beta-room": "⌂" });

    // The data panel lists the same rooms and the other kinds of data.
    await page.click("#profile .ayp > button"); // the click above closed the menu
    await page.click("#profile .aypm button:has-text('My data')");
    const panel = (await page.locator(".aypd").textContent()) ?? "";
    expect(panel).toContain("alpha-room");
    expect(panel).toContain("☁ synced");
    expect(panel).toContain("beta-room");
    expect(panel).toContain("⌂ this device only");
    for (const t of ["Quick commands and scripts", "Preferences", "Hosts, machines and agents"])
      expect(panel).toContain(t);
    await page.context().close();
  });
});
