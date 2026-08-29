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
// network. EVERY method the console calls on a Terminal must exist here, or the
// select() flow throws partway through and later wiring (e.g. onData) never runs
// — which silently times out the keystroke tests. Keep this in lockstep with the
// `term.*` calls in lab/ui/index.html.
// onData captures the keystroke handler on window so a test can drive it (xterm
// would normally call it from real key events, which the stub can't synthesize).
// open(el) records the container as `element` so the right-click-to-copy
// contextmenu listener (term.element?.addEventListener) has something to bind to;
// the selection getters report "no selection" so that handler is a harmless no-op.
const TERMINAL_STUB =
  "window.Terminal=class{constructor(){this.cols=80;this.rows=24;this.element=null;this.options={theme:{background:'#0d1117'}};}" +
  "loadAddon(){}open(el){el.innerHTML='<div class=\"xterm\"><div class=\"xterm-rows\"></div><textarea class=\"xterm-helper-textarea\" style=\"left:8px;top:16px;width:8px;height:16px;line-height:16px\"></textarea></div>';this.element=el.querySelector('.xterm');}focus(){}onTitleChange(){}onResize(){}onScroll(){}" +
  "onData(f){window.__onData=f;}onBinary(){}write(){}resize(c,r){this.cols=c;this.rows=r;}" +
  "hasSelection(){return false;}getSelection(){return '';}getSelectionPosition(){return null;}" +
  "clearSelection(){}dispose(){}};";
const FITADDON_STUB = "window.FitAddon={FitAddon:class{activate(){}dispose(){}fit(){}}};";

async function openConsole(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
  extra: Record<string, unknown> = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, ...extra });
  // Stub xterm.js + addons. The console self-hosts them (./vendor/*.min.js, #317)
  // instead of cdn.jsdelivr.net now, so intercept BOTH paths — otherwise the real
  // xterm loads, the stub's onData never captures window.__onData, and the
  // keystroke tests time out.
  await ctx.route(/cdn\.jsdelivr\.net|\/vendor\/[\w-]+\.min\.js/, (route) => {
    const body = route.request().url().includes("addon-fit") ? FITADDON_STUB : TERMINAL_STUB;
    route.fulfill({ status: 200, contentType: "application/javascript", body });
  });
  const page = await ctx.newPage();
  // Pin the platform so the suite is hermetic to the DEV machine's OS and matches
  // CI (Linux). The agent-switch combo is platform-gated in the page (Cmd+Arrow on
  // Mac, Alt+Arrow on Windows/Linux); without this, the Alt+Arrow test would no-op
  // on a Mac dev box. CI already runs Linux, so this is a no-op there.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
  });
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

  it("renders one compact row per agent; identity capped to 3, default claude omitted", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Since #268 the compact list is the ONLY view — every row is a .crow.
      expect(await page.locator(".list .row.crow").count()).toBe(3);
      // All local (no devices) → path-only identity owner/repo/branch, each ≤3 chars.
      const idents = await page.locator(".crow .cident").allInnerTexts();
      expect(idents).toContain("sno/age/mai"); // snomiao/agent-yes/main
      expect(idents).toContain("acm/wid/dev"); // acme/widgets/dev
      // codex row shows its cli; default-claude rows never say "claude"
      const names = await page.locator(".crow .cname").allInnerTexts();
      expect(names).toEqual(["codex"]);
      const list = (await page.locator("#list").innerText()).toLowerCase();
      expect(list).not.toMatch(/\bclaude\b/);
      // the compact row's one-line title (title || status_text || prompt)
      expect(await page.locator('.list .row[data-key="local#101"] .ctitle').innerText()).toBe(
        "first agent",
      );
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

  it("compact is the only view — the old ☰ toggle is gone (#268)", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await page.waitForSelector(".list .row.crow");
      expect(await page.locator("#viewbtn").count()).toBe(0);
      // the full identity survives as the hover title on the capped chip
      const titles = await page
        .locator(".crow .cident")
        .evaluateAll((els) => els.map((e) => e.getAttribute("title")));
      expect(titles).toContain("snomiao/agent-yes/main");
    } finally {
      await ctx.close();
    }
  });

  it("Alt+ArrowDown/ArrowUp cycles selection and is intercepted before xterm", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // The list is sorted for DISPLAY (default "state" mode = attention-first:
      // active agents before idle ones), so nav follows the RENDERED order, not
      // pid order — here [101, 103, 102] since 102 is idle. Drive the assertions
      // off the actual rendered order so this stays correct if the sort changes.
      const sel = () => page.locator(".row.sel").getAttribute("data-key");
      const order = await page
        .locator(".list .row")
        .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-key")));
      expect(order.length).toBe(3);

      // Select the first row (builds the stubbed terminal + focuses it).
      await page.click(`.list .row[data-key="${order[0]}"]`);
      await expect.poll(sel).toBe(order[0]);

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
      await expect.poll(sel).toBe(order[1]);
      await page.keyboard.press("Alt+ArrowDown");
      await expect.poll(sel).toBe(order[2]);
      await page.keyboard.press("Alt+ArrowDown"); // clamps at the bottom
      await expect.poll(sel).toBe(order[2]);
      await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(sel).toBe(order[1]);

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
      const immediateEcho = await page.evaluate(() => {
        (window as any).__onData("h");
        return document.querySelector(".ay-local-echo")?.textContent;
      });

      expect(immediateEcho).toBe("h");
      await expect.poll(() => sends.length).toBeGreaterThan(0);
      expect(typeof sends[0].keyword).toBe("string");
      expect(sends[0].keyword).toBe("102");
      expect(sends[0].msg).toBe("h");
    } finally {
      await ctx.close();
    }
  });

  it("Cmd+K /restart and /kill fire the open agent's recovery endpoints", async () => {
    // The slash commands mirror the ⋯-menu Restart / Force-kill buttons: they act
    // on the agent that was open when the palette launched (the anchor), and hit
    // the very same POST /api/restart · /api/kill with a STRING keyword=pid.
    const { ctx, page } = await openConsole(browser, url);
    const posts: { path: string; body: any }[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (r.method() === "POST" && (u.pathname === "/api/kill" || u.pathname === "/api/restart")) {
        try {
          posts.push({ path: u.pathname, body: r.postDataJSON() });
        } catch {}
      }
    });
    // The commands reuse the ⋯-menu confirm() gate — auto-accept it.
    page.on("dialog", (d) => d.accept());
    try {
      // Open agent 101, then launch the palette so 101 is the anchor.
      await page.click('.list .row[data-key="local#101"]');
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#101");
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);

      // "/" lists the commands; /restart, /kill, the /ws browser and the global
      // /filter and /new are all offered.
      await page.fill("#omni-input", "/");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(5);
      const menu = (await page.locator("#omni-results").innerText()).toLowerCase();
      expect(menu).toContain("restart");
      expect(menu).toContain("kill");
      expect(menu).toContain("workspaces");
      expect(menu).toContain("filter");
      expect(menu).toContain("new");

      // "/restart" narrows to one row; ⏎ fires POST /api/restart for pid 101.
      await page.fill("#omni-input", "/restart");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(1);
      await page.keyboard.press("Enter");
      await expect.poll(() => posts.filter((x) => x.path === "/api/restart").length).toBe(1);
      const restart = posts.find((x) => x.path === "/api/restart")!;
      expect(restart.body.keyword).toBe("101");
      expect(typeof restart.body.keyword).toBe("string");

      // Re-open and run "/kill" → POST /api/kill for the same agent.
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);
      await page.fill("#omni-input", "/kill");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(1);
      await page.keyboard.press("Enter");
      await expect.poll(() => posts.filter((x) => x.path === "/api/kill").length).toBe(1);
      const kill = posts.find((x) => x.path === "/api/kill")!;
      expect(kill.body.keyword).toBe("101");

      // "/new" opens the "+ New agent" spawn form (the header button's handler).
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);
      await page.fill("#omni-input", "/new");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(1);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#newform .lcard");
      expect(await page.locator("#newform .lcard").count()).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("right-clicking a row opens the full agent menu, acting on THAT row", async () => {
    // The row menu used to offer only "Pin to top"; it now mirrors the terminal
    // header's ⋯ menu (share / stop / restart / force-kill) — bound to the
    // right-clicked agent, not the selected one.
    const { ctx, page } = await openConsole(browser, url);
    const posts: { path: string; body: any }[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (r.method() === "POST" && u.pathname === "/api/kill") {
        try {
          posts.push({ path: u.pathname, body: r.postDataJSON() });
        } catch {}
      }
    });
    page.on("dialog", (d) => d.accept());
    try {
      // Open 101, then right-click a DIFFERENT row (102).
      await page.click('.list .row[data-key="local#101"]');
      await expect.poll(() => page.locator(".row.sel").getAttribute("data-key")).toBe("local#101");
      await page.click('.list .row[data-key="local#102"]', { button: "right" });
      await expect.poll(() => page.locator(".ctxmenu").isVisible()).toBe(true);
      const items = (await page.locator(".ctxmenu").innerText()).toLowerCase();
      expect(items).toContain("pin to top");
      expect(items).toContain("share (view-only)");
      expect(items).toContain("share (read-write)");
      expect(items).toContain("stop agent");
      expect(items).toContain("restart");
      expect(items).toContain("force-kill");

      // Force-kill targets 102 (the right-clicked row), not the open 101.
      await page.locator(".ctxmenu-item", { hasText: "Force-kill" }).click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0].body.keyword).toBe("102");
      // The selection never moved.
      expect(await page.locator(".row.sel").getAttribute("data-key")).toBe("local#101");
    } finally {
      await ctx.close();
    }
  });

  it("Cmd+K /filter sets and clears the left panel filter box", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // "/filter claude" applies the tokens to #q (persisted via its input path).
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);
      await page.fill("#omni-input", "/filter claude");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(1);
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#q").inputValue()).toBe("claude");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(false);
      expect(await page.evaluate(() => localStorage.getItem("ay.filter"))).toBe("claude");

      // Bare "/filter" clears it again.
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);
      await page.fill("#omni-input", "/filter");
      await expect
        .poll(() =>
          page
            .locator("#omni-results")
            .innerText()
            .then((t) => t.toLowerCase().includes("clear list filter")),
        )
        .toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#q").inputValue()).toBe("");
      expect(await page.evaluate(() => localStorage.getItem("ay.filter"))).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("Cmd+K /ws browses workspaces, lazy-loads git state, and spawns into one", async () => {
    // The /ws browser lists GET /api/ws results (including the idle acme/widgets
    // checkout no agent row could surface), fetches the highlighted row's git
    // state lazily via /api/ws/status, and Enter fires POST /api/spawn with the
    // workspace path as cwd. A source-looking query offers a provision row that
    // spawns with {from} instead.
    const { ctx, page } = await openConsole(browser, url);
    const spawns: any[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/spawn") {
        try {
          spawns.push(r.postDataJSON());
        } catch {}
      }
    });
    try {
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);

      // "/ws" lists both fixture workspaces, live-agent one first.
      await page.fill("#omni-input", "/ws");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(2);
      const rows = await page.locator("#omni-results").innerText();
      expect(rows).toContain("snomiao/agent-yes@main");
      expect(rows).toContain("acme/widgets@dev");
      expect(rows.indexOf("agent-yes")).toBeLessThan(rows.indexOf("widgets"));

      // The highlighted (first) row lazily pulls /api/ws/status → "dirty, ahead 2".
      await expect
        .poll(() => page.locator("#omni-results").innerText())
        .toContain("dirty, ahead 2");

      // Filter to the idle workspace and Enter → spawn with its path as cwd.
      await page.fill("#omni-input", "/ws widgets");
      await expect.poll(() => page.locator("#omni-results .omni-row").count()).toBe(1);
      await page.keyboard.press("Enter");
      await expect.poll(() => spawns.length).toBe(1);
      expect(spawns[0].cwd).toBe("/home/u/ws/acme/widgets/tree/dev");
      expect(spawns[0].from).toBeUndefined();

      // A source-looking query that matches nothing offers the provision row;
      // Enter spawns with {from} so the host clones it behind its gate.
      await page.keyboard.press("Control+k");
      await expect.poll(() => page.locator("#omni").isVisible()).toBe(true);
      await page.fill("#omni-input", "/ws acme/newrepo@dev");
      await expect
        .poll(() => page.locator("#omni-results").innerText())
        .toContain("Provision workspace");
      await page.keyboard.press("Enter");
      await expect.poll(() => spawns.length).toBe(2);
      expect(spawns[1].from).toBe("acme/newrepo@dev");
      expect(spawns[1].cwd).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("New-agent form provisions from a picked repo/branch (create for new names)", async () => {
    // The + New agent form's repo picker (GET /api/ws/repos) and branch picker
    // (GET /api/ws/branches) compose a `from` spec: an existing remote branch
    // spawns plain {from}; a branch name NOT on the remote adds create:true so
    // the host branches it off the default (ws new --create semantics).
    const { ctx, page } = await openConsole(browser, url);
    const spawns: any[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/spawn") {
        try {
          spawns.push(r.postDataJSON());
        } catch {}
      }
    });
    // the combobox fires its logic on `change` — fill() then commit like a user
    const setRepo = async (v: string) => {
      await page.fill("#nf-repo", v);
      await page.dispatchEvent("#nf-repo", "change");
    };
    try {
      await page.click("#newbtn");
      // repo combobox datalist fills async from /api/ws/repos — 3 repos
      await expect.poll(() => page.locator("#nf-repo-list option").count()).toBe(3);
      const values = await page
        .locator("#nf-repo-list option")
        .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      expect(values).toContain("acme/newrepo");

      // pick a repo → branch row appears, datalist fills from /api/ws/branches
      await setRepo("acme/widgets");
      await expect.poll(() => page.locator("#nf-branch-row").isVisible()).toBe(true);
      await expect.poll(() => page.locator("#nf-branch-list option").count()).toBe(2);

      // picking a repo derives the Working dir from the ws standard layout
      // (locked so it can't read as "clone into whatever dir was there")
      await expect.poll(() => page.locator("#nf-cwd").isDisabled()).toBe(true);
      await expect
        .poll(() => page.locator("#nf-cwd").inputValue())
        .toContain("/home/u/ws/acme/widgets/tree/");

      // a NEW branch name → hint flags the create, spawn carries create:true
      await page.fill("#nf-branch", "feat-x");
      await expect
        .poll(() => page.locator("#nf-cwd").inputValue())
        .toBe("/home/u/ws/acme/widgets/tree/feat-x");
      await expect
        .poll(() => page.locator("#nf-branch-hint").innerText())
        .toContain("new branch will be created");
      await page.selectOption("#nf-cli", "claude");
      await page.click("#nf-go");
      await expect.poll(() => spawns.length).toBe(1);
      expect(spawns[0].from).toBe("acme/widgets@feat-x");
      expect(spawns[0].create).toBe(true);
      expect(spawns[0].cwd).toBeUndefined();

      // a github /tree/<branch> URL → normalized spec, branch prefilled
      await page.click("#newbtn");
      await setRepo("https://github.com/acme/widgets/tree/main");
      await expect.poll(() => page.locator("#nf-branch").inputValue()).toBe("main");
      await expect.poll(() => page.locator("#nf-branch-list option").count()).toBe(2);
      await page.selectOption("#nf-cli", "claude");
      await page.click("#nf-go");
      await expect.poll(() => spawns.length).toBe(2);
      expect(spawns[1].from).toBe("acme/widgets@main");
      expect(spawns[1].create).toBeUndefined();
      expect(spawns[1].branch).toBeUndefined();

      // a non-GitHub git URL → cwd preview still derives from the layout
      await page.click("#newbtn");
      await setRepo("https://gitlab.com/acme/tools.git");
      await expect
        .poll(() => page.locator("#nf-cwd").inputValue())
        .toContain("/home/u/ws/acme/tools/tree/");
      await expect.poll(() => page.locator("#nf-branch-hint").innerText()).toContain("git clone");
      await page.fill("#nf-branch", "dev");
      await page.selectOption("#nf-cli", "claude");
      await page.click("#nf-go");
      await expect.poll(() => spawns.length).toBe(3);
      expect(spawns[2].from).toBe("https://gitlab.com/acme/tools.git");
      expect(spawns[2].branch).toBe("dev");
      expect(spawns[2].create).toBe(true);
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

  it("the New-agent FAB floats in the left panel, drags, and persists its spot", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // It lives in the left panel (not the header meta row) and floats over the
      // list, parked near the panel's bottom-right corner.
      expect(await page.evaluate(() => !!document.querySelector(".left > #newbtn"))).toBe(true);
      expect(
        await page.evaluate(() => getComputedStyle(document.querySelector("#newbtn")!).position),
      ).toBe("absolute");
      const panel = (await page.locator(".left").boundingBox())!;
      const before = (await page.locator("#newbtn").boundingBox())!;
      expect(panel.x + panel.width - (before.x + before.width)).toBeLessThan(40); // right edge
      expect(panel.y + panel.height - (before.y + before.height)).toBeLessThan(40); // bottom edge

      // Dragging moves it and must NOT open the spawn form (pointerup on a
      // <button> still synthesizes a click).
      const cx = before.x + before.width / 2;
      const cy = before.y + before.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 160, cy - 200, { steps: 8 });
      await page.mouse.up();
      const after = (await page.locator("#newbtn").boundingBox())!;
      expect(Math.round(before.x - after.x)).toBeGreaterThan(100);
      expect(Math.round(before.y - after.y)).toBeGreaterThan(140);
      expect(await page.locator("#newform").isVisible()).toBe(false);

      // …and the new spot survives a reload (stored right/bottom offsets).
      const saved = JSON.parse((await page.evaluate(() => localStorage.getItem("ay.newbtnPos")))!);
      expect(saved.r).toBeGreaterThan(100);
      expect(saved.b).toBeGreaterThan(140);
      await page.reload();
      await page.waitForSelector(".list .row", { timeout: 10_000 });
      const reloaded = (await page.locator("#newbtn").boundingBox())!;
      expect(Math.abs(reloaded.x - after.x)).toBeLessThan(2);
      expect(Math.abs(reloaded.y - after.y)).toBeLessThan(2);

      // A plain click still opens the spawn form.
      await page.click("#newbtn");
      await expect.poll(() => page.locator("#newform").isVisible()).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("shows the install one-liner on the home page", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      const install = (await page.locator(".install").innerText()).toLowerCase();
      const origin = new URL(url).origin.toLowerCase();
      expect(install).toContain(`curl -fssl ${origin}/setup.sh | sh`);
      expect(install).toContain(`powershell -c "irm ${origin}/setup.ps1 | iex"`);
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

  it("edge-to-edge mode runs the terminal under the title bar but never under the key bar", async () => {
    // The whole hazard of this feature: xterm repaints a fixed grid whose LAST
    // row is the live CLI input line, so if .log is allowed to run under the
    // bottom bars the input becomes untappable. Bleeding upward is safe (the
    // buffer is bottom-anchored, so it only exposes older scrollback), bleeding
    // downward is not. This pins both halves of that contract.
    const { ctx, page } = await openConsole(
      browser,
      url,
      { width: 390, height: 844 },
      { hasTouch: true, isMobile: true },
    );
    try {
      await page.locator(".list .row").first().click();
      await expect.poll(() => page.locator(".keybar").isVisible()).toBe(true);

      const box = () =>
        page.evaluate(() => {
          const g = (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          };
          const log = document.getElementById("log")!;
          const cs = getComputedStyle(log);
          const r = log.getBoundingClientRect();
          return {
            head: g(".rhead"),
            log: r.top,
            // where the xterm grid is actually allowed to paint
            logContentBottom: r.bottom - (parseFloat(cs.paddingBottom) || 0),
            keybar: g(".keybar").top,
          };
        });

      const before = await box();
      expect(before.log).toBeGreaterThanOrEqual(before.head.bottom - 1); // header reserves space

      await page.locator("#rmenubtn").click();
      await page.locator("#islandsToggle").check();
      await expect.poll(async () => (await box()).log).toBeLessThan(before.log);

      const after = await box();
      // top: the pane now starts at the very top of the header, i.e. the grid
      // paints behind it instead of below it
      expect(after.log).toBeLessThanOrEqual(after.head.top + 1);
      // bottom: unchanged — the key bar still sits below everything the grid
      // can paint into
      expect(after.logContentBottom).toBeLessThanOrEqual(after.keybar + 1);
      // (1px of slack: the header height is fractional, so pulling .log up by it
      // reshuffles sub-pixel rounding on the bottom edge too)
      expect(Math.abs(after.logContentBottom - before.logContentBottom)).toBeLessThanOrEqual(1);
    } finally {
      await ctx.close();
    }
  });

  it("new-agent modal: Working dir sits under Host, autocompletes, CLI needs an explicit pick", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await page.click("#newbtn");
      await page.waitForSelector("#newform .lcard");
      // Working dir leads (right under the Host row when one exists) — a cwd
      // only means something on its machine; CLI and the rest follow.
      const labels = await page.locator("#newform .nfield label").allTextContents();
      const iCwd = labels.findIndex((l) => l.includes("Working dir"));
      const iCli = labels.findIndex((l) => l.trim().startsWith("CLI"));
      expect(iCwd).toBeGreaterThanOrEqual(0);
      expect(iCli).toBeGreaterThan(iCwd);
      // cwd autocompletes from the fleet's known agent cwds
      expect(await page.locator("#nf-cwd").getAttribute("list")).toBe("nf-cwd-list");
      expect(await page.locator("#nf-cwd-list option").count()).toBeGreaterThan(0);
      // CLI is a picker (not free text) whose first option is a disabled
      // "choose a CLI…" placeholder — no silent claude default.
      expect(await page.locator("#nf-cli").evaluate((el) => el.tagName)).toBe("SELECT");
      expect(await page.locator("#nf-cli option").first().getAttribute("disabled")).not.toBeNull();
      // With no agent selected and no last-used cli, the value is empty and
      // Launch refuses to submit (the form stays open, no /api/spawn fired).
      if ((await page.locator("#nf-cli").inputValue()) === "") {
        await page.click("#nf-go");
        expect(await page.locator("#newform .lcard").count()).toBe(1);
        expect(await page.locator("#nf-go").isDisabled()).toBe(false);
      }
    } finally {
      await ctx.close();
    }
  });
});

// A nested fixture: root 201 with two subagents (202 active, 203 idle) and a
// grandchild 204 under 202. All in one worktree so the parent_pid links drive
// the forest. Exercises the fold toggle + summary chip, which the flat fixture
// above (all roots) can't reach.
describe("fold subagent trees", () => {
  let browser: Browser;
  let url: string;
  let close: () => void;
  const NESTED = [
    {
      pid: 201,
      wrapper_pid: 201,
      cli: "claude",
      cwd: "/home/u/ws/o/r/tree/w",
      title: "root",
      status: "active",
      started_at: 1_700_000_000_000,
    },
    {
      pid: 202,
      wrapper_pid: 202,
      parent_pid: 201,
      cli: "claude",
      cwd: "/home/u/ws/o/r/tree/w/a",
      title: "sub-a",
      status: "active",
      started_at: 1_700_000_000_000,
      last_active_at: 1_700_000_005_000,
    },
    {
      pid: 203,
      wrapper_pid: 203,
      parent_pid: 201,
      cli: "claude",
      cwd: "/home/u/ws/o/r/tree/w/b",
      title: "sub-b",
      status: "idle",
      started_at: 1_700_000_000_000,
      last_active_at: 1_700_000_001_000,
    },
    {
      pid: 204,
      wrapper_pid: 204,
      parent_pid: 202,
      cli: "claude",
      cwd: "/home/u/ws/o/r/tree/w/a/c",
      title: "grandchild",
      status: "active",
      started_at: 1_700_000_000_000,
      last_active_at: 1_700_000_003_000,
    },
  ];

  beforeAll(async () => {
    ({ url, close } = await startServer(NESTED));
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    close?.();
  });

  it("folds by default, hiding subagents behind a working/total chip", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Only the root is visible; its three descendants are folded away.
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
      await expect
        .poll(() => page.locator(".row[data-key='local#201'] .subs").innerText())
        .toBe("⊞ 2/3");
      // The recency the badge face omits lives in the tooltip.
      expect(
        await page.locator(".row[data-key='local#201'] .subs").getAttribute("title"),
      ).toContain("last active");
    } finally {
      await ctx.close();
    }
  });

  it("the toolbar button unfolds every tree, and folds again", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
      // The fold toggle now lives inside the Settings dropdown, which stays OPEN
      // after an item click (416bedb — most items are toggles you may want to
      // spin several times). So open it once and click the toggle twice; a
      // second #viewmenubtn click here would CLOSE the panel and the following
      // #foldbtn click would hang waiting for a hidden element.
      await page.click("#viewmenubtn");
      await page.click("#foldbtn");
      // All four agents (root + 3 descendants) now render; the chip is gone.
      await expect.poll(() => page.locator(".list .row").count()).toBe(4);
      expect(await page.locator(".subs").count()).toBe(0);
      await page.click("#foldbtn");
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("clicking the summary chip expands the trees instead of selecting the row", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await expect.poll(() => page.locator(".list .row").count()).toBe(1);
      await page.click(".row[data-key='local#201'] .subs");
      await expect.poll(() => page.locator(".list .row").count()).toBe(4);
      // The click expanded rather than selecting the root row.
      expect(await page.locator(".row.sel").count()).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
