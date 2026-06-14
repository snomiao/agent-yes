/**
 * Deterministic DOM test of the REAL console (lab/ui/index.html).
 *
 * Unlike tests/ui-test (xterm render fidelity judged by Gemini Vision), this
 * drives the actual shipped page against a stubbed ay-serve API and asserts
 * concrete behaviour with plain DOM checks — no AI, no network: the xterm CDN
 * scripts are intercepted and replaced with a tiny stub so the page is hermetic.
 *
 * Covers the UI wiring that the console-logic unit tests can't: list rendering,
 * the filter box, the compact toggle, Alt+PageUp/PageDown navigation (incl. the
 * capture-phase intercept that stops the combo reaching xterm), the draggable
 * splitter, and the absence of the removed stdin composer.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startServer } from "./server.ts";

// Stub the two xterm CDN scripts so creating a Terminal never touches the
// network. Only the methods the console calls are implemented.
const TERMINAL_STUB =
  "window.Terminal=class{constructor(){this.cols=80;this.rows=24;}" +
  "loadAddon(){}open(){}focus(){}onTitleChange(){}onResize(){}onData(){}" +
  "onBinary(){}write(){}resize(c,r){this.cols=c;this.rows=r;}dispose(){}};";
const FITADDON_STUB = "window.FitAddon={FitAddon:class{activate(){}dispose(){}fit(){}}};";

async function openConsole(
  browser: Browser,
  url: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/cdn\.jsdelivr\.net/, (route) => {
    const body = route.request().url().includes("addon-fit") ? FITADDON_STUB : TERMINAL_STUB;
    route.fulfill({ status: 200, contentType: "application/javascript", body });
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector(".list .row", { timeout: 10_000 });
  return { ctx, page };
}

describe("console DOM behaviour", () => {
  let browser: Browser;
  let url: string;
  let close: () => void;

  beforeAll(async () => {
    ({ url, close } = await startServer());
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    close?.();
  });

  it("renders one row per agent, leads with repo/branch identity, omits default claude", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      expect(await page.locator(".list .row").count()).toBe(3);
      const list = (await page.locator("#list").innerText()).toLowerCase();
      // default-claude rows show identity as the name, not "claude"
      expect(list).toContain("agent-yes/main");
      expect(list).toContain("codex"); // non-default cli is shown
      expect(list).not.toMatch(/\bclaude\b/); // the word "claude" never appears
      // repo/wt mnemonic tags are derived from the cwd
      expect(list).toContain("snomiao/agent-yes");
    } finally {
      await ctx.close();
    }
  });

  it("filters the list as you type (key:value and bare tokens)", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await page.fill("#q", "codex");
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
      expect(await page.locator("#count").innerText()).toContain("1 / 3");

      await page.fill("#q", "repo:agent-yes");
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);

      await page.fill("#q", "");
      await expect.poll(() => page.locator(".list .row").count()).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  it("compact toggle collapses rows and caps repo/branch to 3 chars", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await page.click("#viewbtn");
      await page.waitForSelector(".list .row.crow");
      const idents = await page.locator(".crow .cident").allInnerTexts();
      expect(idents).toContain("age/mai"); // agent-yes/main
      expect(idents).toContain("wid/dev"); // widgets/dev
      // codex row shows its cli; claude rows don't
      const names = await page.locator(".crow .cname").allInnerTexts();
      expect(names).toEqual(["codex"]);
    } finally {
      await ctx.close();
    }
  });

  it("Alt+PageDown/PageUp cycles selection and is intercepted before xterm", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Select the first agent (builds the stubbed terminal + focuses it).
      await page.click('.list .row[data-pid="101"]');
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-pid")).toBe("101");

      // Spy on document keydown in the BUBBLE phase: the page's capture-phase
      // handler calls stopPropagation, so these Alt+Page* combos must never
      // reach here (i.e. they never reach xterm's textarea either).
      await page.evaluate(() => {
        (window as any).__bubble = [];
        document.addEventListener(
          "keydown",
          (e) => {
            if (e.altKey && e.key.startsWith("Page")) (window as any).__bubble.push(e.key);
          },
          false,
        );
      });

      await page.keyboard.press("Alt+PageDown");
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-pid")).toBe("102");
      await page.keyboard.press("Alt+PageDown");
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-pid")).toBe("103");
      await page.keyboard.press("Alt+PageDown"); // clamps at the bottom
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-pid")).toBe("103");
      await page.keyboard.press("Alt+PageUp");
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-pid")).toBe("102");

      // The combo was swallowed by the capture-phase intercept.
      expect(await page.evaluate(() => (window as any).__bubble)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("the middle splitter is draggable and persists the width", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      const box = await page.locator("#splitter").boundingBox();
      expect(box).not.toBeNull();
      const startX = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await page.mouse.move(startX, y);
      await page.mouse.down();
      await page.mouse.move(startX + 220, y, { steps: 5 });
      await page.mouse.up();

      const leftw = await page.evaluate(() =>
        getComputedStyle(document.querySelector(".app")!).getPropertyValue("--leftw").trim(),
      );
      expect(leftw).toMatch(/^\d+(\.\d+)?px$/);
      const px = parseFloat(leftw);
      expect(px).toBeGreaterThan(box!.x + 100); // moved right of where it started
      // persisted for next visit
      const saved = await page.evaluate(() => localStorage.getItem("ay.leftw"));
      expect(saved).toBe(leftw);
    } finally {
      await ctx.close();
    }
  });

  it("shows the install one-liner on the home page", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      const install = (await page.locator(".install").innerText()).toLowerCase();
      expect(install).toContain("curl -fssl https://agent-yes.com/setup.sh | sh");
      expect(install).toContain("irm https://agent-yes.com/setup.ps1 | iex");
    } finally {
      await ctx.close();
    }
  });

  it("has no stdin composer (xterm is the input)", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      expect(await page.locator("#msg").count()).toBe(0);
      expect(await page.locator(".composer").count()).toBe(0);
      expect(await page.locator("#send").count()).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
