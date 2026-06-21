/**
 * Deterministic DOM test of the REAL console (lab/ui/index.html).
 *
 * Unlike tests/ui-test (xterm render fidelity judged by Gemini Vision), this
 * drives the actual shipped page against a stubbed ay-serve API and asserts
 * concrete behaviour with plain DOM checks — no AI, no network: the xterm CDN
 * scripts are intercepted and replaced with a tiny stub so the page is hermetic.
 *
 * Covers the UI wiring that the console-logic unit tests can't: list rendering,
 * the filter box, the compact toggle, Alt+ArrowUp/ArrowDown navigation (incl. the
 * capture-phase intercept that stops the combo reaching xterm), the draggable
 * splitter, and the absence of the removed stdin composer.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startServer } from "./server.ts";

// Stub the two xterm CDN scripts so creating a Terminal never touches the
// network. Only the methods the console calls are implemented.
// onData captures the keystroke handler on window so a test can drive it (xterm
// would normally call it from real key events, which the stub can't synthesize).
const TERMINAL_STUB =
  "window.Terminal=class{constructor(){this.cols=80;this.rows=24;}" +
  "loadAddon(){}open(){}focus(){}onTitleChange(){}onResize(){}onData(f){window.__onData=f;}" +
  "onBinary(){}write(){}resize(c,r){this.cols=c;this.rows=r;}dispose(){}};";
const FITADDON_STUB = "window.FitAddon={FitAddon:class{activate(){}dispose(){}fit(){}}};";

async function openConsole(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
  extra: Record<string, unknown> = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, ...extra });
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

  it("restores the filter and the selected agent across a reload", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Narrow the list and open an agent.
      await page.fill("#q", "codex");
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
      await page.click('.list .row[data-key="local#102"]');
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#102");

      // A refresh (manual, or the auto-reload on a new deploy) must not lose them.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".list .row");

      expect(await page.inputValue("#q")).toBe("codex");
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#102");
      await expect.poll(() => page.locator("#rhead").isVisible()).toBe(true);
    } finally {
      // localStorage is per-context; closing it clears the persisted keys so the
      // other tests start clean.
      await ctx.close();
    }
  });

  it("on mobile, a restored selection highlights the row but stays on the list", async () => {
    // Phone width (≤720px) is the single-column master/detail layout: opening an
    // agent flips to the full-screen terminal (.show-detail). A *restored*
    // selection should re-highlight the row WITHOUT that flip, so reopening the
    // site lands on the list, not a terminal.
    const { ctx, page } = await openConsole(browser, url, { width: 390, height: 844 });
    try {
      await page.click('.list .row[data-key="local#102"]');
      await expect
        .poll(() =>
          page.evaluate(() => document.querySelector(".app")!.classList.contains("show-detail")),
        )
        .toBe(true);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('.list .row[data-key="local#102"]', { state: "attached" });

      // row stays selected…
      await expect
        .poll(() =>
          page.evaluate(() => document.querySelector(".row.sel")?.getAttribute("data-key") ?? null),
        )
        .toBe("local#102");
      // …but we're back on the list, not flipped into the terminal.
      expect(
        await page.evaluate(() =>
          document.querySelector(".app")!.classList.contains("show-detail"),
        ),
      ).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("compact toggle collapses rows; identity is owner/repo/branch capped to 3", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await page.click("#viewbtn");
      await page.waitForSelector(".list .row.crow");
      // All local (no devices) → path-only identity owner/repo/branch, each ≤3 chars.
      const idents = await page.locator(".crow .cident").allInnerTexts();
      expect(idents).toContain("sno/age/mai"); // snomiao/agent-yes/main
      expect(idents).toContain("acm/wid/dev"); // acme/widgets/dev
      // codex row shows its cli; claude rows don't
      const names = await page.locator(".crow .cname").allInnerTexts();
      expect(names).toEqual(["codex"]);
    } finally {
      await ctx.close();
    }
  });

  it("Alt+ArrowDown/ArrowUp cycles selection and is intercepted before xterm", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Select the first agent (builds the stubbed terminal + focuses it).
      await page.click('.list .row[data-key="local#101"]');
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#101");

      // Spy on document keydown in the BUBBLE phase: the page's capture-phase
      // handler calls stopPropagation, so these Alt+Arrow combos must never
      // reach here (i.e. they never reach xterm's textarea either).
      await page.evaluate(() => {
        (window as any).__bubble = [];
        document.addEventListener(
          "keydown",
          (e) => {
            if (e.altKey && e.key.startsWith("Arrow")) (window as any).__bubble.push(e.key);
          },
          false,
        );
      });

      await page.keyboard.press("Alt+ArrowDown");
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#102");
      await page.keyboard.press("Alt+ArrowDown");
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#103");
      await page.keyboard.press("Alt+ArrowDown"); // clamps at the bottom
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#103");
      await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#102");

      // The combo was swallowed by the capture-phase intercept.
      expect(await page.evaluate(() => (window as any).__bubble)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("forwards keystrokes as POST /api/send with a STRING keyword", async () => {
    // Regression: ay serve rejects a numeric keyword with 400, so a keystroke
    // POST must send keyword as a string even though pid arrives as a number
    // from /api/ls. (Tail still works — its pid lives in the URL path — which is
    // exactly the "see output, can't type" symptom this guards against.)
    const { ctx, page } = await openConsole(browser, url);
    const sends: any[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/send")) {
        try {
          sends.push(r.postDataJSON());
        } catch {}
      }
    });
    try {
      await page.click('.list .row[data-key="local#102"]');
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#102");
      // Drive the captured xterm onData handler as a real keystroke would.
      await page.waitForFunction(() => typeof (window as any).__onData === "function");
      await page.evaluate(() => (window as any).__onData("h"));

      await expect.poll(() => sends.length).toBeGreaterThan(0);
      expect(typeof sends[0].keyword).toBe("string");
      expect(sends[0].keyword).toBe("102");
      expect(sends[0].msg).toBe("h");
    } finally {
      await ctx.close();
    }
  });

  it("key bar + composer apply sticky Ctrl/Alt and never leak the modifier", async () => {
    const { ctx, page } = await openConsole(
      browser,
      url,
      { width: 390, height: 844 },
      { hasTouch: true, isMobile: true },
    );
    const sends: any[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/send")) {
        try {
          sends.push(r.postDataJSON());
        } catch {}
      }
    });
    const lastMsg = () => sends.at(-1)?.msg;
    const ctrlOn = () =>
      page
        .locator('.keybar [data-mod="ctrl"]')
        .getAttribute("class")
        .then((c) => !!c?.includes("on"));
    try {
      await page.locator('.list .row[data-key="local#102"]').click();
      await expect.poll(() => page.locator(".keybar").isVisible()).toBe(true);

      // plain arrow → CSI form (no DECCKM in the stub)
      await page.locator('.keybar [data-arrow="down"]').click();
      await expect.poll(lastMsg).toBe("\x1b[B");

      // dedicated ⇧Tab → CBT / back-tab (ESC [ Z)
      await page.locator('.keybar [data-key="stab"]').click();
      await expect.poll(lastMsg).toBe("\x1b[Z");

      // Shift modifier + Tab → the same CBT sequence as the dedicated ⇧Tab
      await page.locator('.keybar [data-mod="shift"]').click();
      await page.locator('.keybar [data-key="tab"]').click();
      await expect.poll(lastMsg).toBe("\x1b[Z");

      // Shift + arrow → CSI modifier 2 (e.g. Shift-Left = ESC [ 1 ; 2 D)
      await page.locator('.keybar [data-mod="shift"]').click();
      await page.locator('.keybar [data-arrow="left"]').click();
      await expect.poll(lastMsg).toBe("\x1b[1;2D");

      // a multi-char input (paste/mouse report) disarms a pending modifier so it
      // can't leak onto a later key: arm ⇧, "paste", then Left → PLAIN Left
      await page.locator('.keybar [data-mod="shift"]').click();
      await page.evaluate(() => (window as any).__onData("pasted text"));
      await page.locator('.keybar [data-arrow="left"]').click();
      await expect.poll(lastMsg).toBe("\x1b[D");

      // Ctrl + Left → ESC [ 1 ; 5 D, and the armed state clears after one key
      await page.locator('.keybar [data-mod="ctrl"]').click();
      await expect.poll(ctrlOn).toBe(true);
      await page.locator('.keybar [data-arrow="left"]').click();
      await expect.poll(lastMsg).toBe("\x1b[1;5D");
      expect(await ctrlOn()).toBe(false);

      // Alt + Right → ESC [ 1 ; 3 C
      await page.locator('.keybar [data-mod="alt"]').click();
      await page.locator('.keybar [data-arrow="right"]').click();
      await expect.poll(lastMsg).toBe("\x1b[1;3C");

      // Alt + Shift + Tab → ESC ESC [ Z (Alt prefix layered on the back-tab)
      await page.locator('.keybar [data-mod="alt"]').click();
      await page.locator('.keybar [data-mod="shift"]').click();
      await page.locator('.keybar [data-key="tab"]').click();
      await expect.poll(lastMsg).toBe("\x1b\x1b[Z");

      // nav keys: Home/End are DECCKM-aware cursor keys (ESC [ H / F);
      // PgUp/PgDn/Del are VT220 function keys (CSI N ~)
      await page.locator('.keybar [data-arrow="home"]').click();
      await expect.poll(lastMsg).toBe("\x1b[H");
      await page.locator('.keybar [data-arrow="end"]').click();
      await expect.poll(lastMsg).toBe("\x1b[F");
      await page.locator('.keybar [data-tilde="pgup"]').click();
      await expect.poll(lastMsg).toBe("\x1b[5~");
      await page.locator('.keybar [data-tilde="pgdn"]').click();
      await expect.poll(lastMsg).toBe("\x1b[6~");
      await page.locator('.keybar [data-tilde="del"]').click();
      await expect.poll(lastMsg).toBe("\x1b[3~");
      // Home shares the cursor-key path, so it composes with modifiers too:
      // Ctrl+Home → ESC [ 1 ; 5 H
      await page.locator('.keybar [data-mod="ctrl"]').click();
      await page.locator('.keybar [data-arrow="home"]').click();
      await expect.poll(lastMsg).toBe("\x1b[1;5H");
      // VT220 keys take CSI modifiers too: Ctrl+Del → ESC [ 3 ; 5 ~ (word-delete)
      await page.locator('.keybar [data-mod="ctrl"]').click();
      await page.locator('.keybar [data-tilde="del"]').click();
      await expect.poll(lastMsg).toBe("\x1b[3;5~");

      // sticky Ctrl then a soft-keyboard char → control code via the xterm path
      await page.locator('.keybar [data-mod="ctrl"]').click();
      await page.evaluate(() => (window as any).__onData("r"));
      await expect.poll(lastMsg).toBe("\x12");

      // composer: a single-char line carries an armed Ctrl (Ctrl-D + Enter)…
      await page.locator('.keybar [data-mod="ctrl"]').click();
      await page.fill("#cmpin", "d");
      await page.locator("#cmpin").press("Enter");
      await expect.poll(lastMsg).toBe("\x04\r");
      // …and a multi-char line can't carry it, but must still clear it (no leak)
      await page.locator('.keybar [data-mod="ctrl"]').click();
      await page.fill("#cmpin", "ls");
      await page.locator("#cmpin").press("Enter");
      await expect.poll(lastMsg).toBe("ls\r");
      expect(await ctrlOn()).toBe(false);
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
      expect(install).toContain('powershell -c "irm https://agent-yes.com/setup.ps1 | iex"');
    } finally {
      await ctx.close();
    }
  });

  it("desktop has no stdin composer (xterm is the input); touch aids stay hidden", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // the old always-on stdin composer is gone — on desktop you type into xterm
      expect(await page.locator("#msg").count()).toBe(0);
      expect(await page.locator("#send").count()).toBe(0);
      // the mobile line composer + key bar exist in the DOM but are
      // pointer:coarse-only, so they must stay hidden in this fine-pointer viewport
      expect(await page.locator(".composer").count()).toBe(1);
      expect(await page.locator(".composer").isVisible()).toBe(false);
      expect(await page.locator(".keybar").count()).toBe(1);
      expect(await page.locator(".keybar").isVisible()).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("shows the touch aids (key bar + composer) on a coarse-pointer device", async () => {
    // emulate a phone: touch + small viewport ⇒ pointer:coarse ⇒ aids visible
    const { ctx, page } = await openConsole(
      browser,
      url,
      { width: 390, height: 844 },
      { hasTouch: true, isMobile: true },
    );
    try {
      // open an agent so the detail (terminal) pane becomes the active column
      await page.locator(".list .row").first().click();
      await expect.poll(() => page.locator(".keybar").isVisible()).toBe(true);
      expect(await page.locator(".composer").isVisible()).toBe(true);
      // the key bar carries the Esc/Ctrl/arrow controls
      expect(await page.locator('.keybar [data-key="esc"]').count()).toBe(1);
      expect(await page.locator('.keybar [data-mod="ctrl"]').count()).toBe(1);
      expect(await page.locator('.keybar [data-mod="shift"]').count()).toBe(1);
      expect(await page.locator('.keybar [data-arrow="up"]').count()).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});
