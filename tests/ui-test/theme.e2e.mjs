// Headless e2e for the console's OS light/dark adaptation.
//
// The console must recolor live when the OS color-scheme flips — no reload.
// Playwright's emulateMedia({ colorScheme }) drives the same prefers-color-scheme
// signal the OS does, so flipping it on a live page mimics the user toggling
// their system theme. We assert (1) the CSS palette swaps live both ways, (2) the
// .log terminal container follows (it's var(--bg) now), and (3) the xterm theme
// remaps the white ANSI slots to dark in light mode — else SGR 37/97 text renders
// white-on-white and is unreadable (the exact gap a code review caught).
//
// Self-serving so it's a single command (pre-push hook / manual): `node
// tests/ui-test/theme.e2e.mjs`. Needs system Chrome (channel: "chrome").
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lab/ui");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const DARK_BG = "rgb(13, 17, 23)"; // #0d1117
const LIGHT_BG = "rgb(255, 255, 255)"; // #ffffff

const assert = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
};
const read = (page) =>
  page.evaluate(() => ({
    matchLight: matchMedia("(prefers-color-scheme: light)").matches,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    logBg: getComputedStyle(document.querySelector(".log")).backgroundColor,
  }));
const lum = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

// Tiny static server for lab/ui so the test has no external dependency.
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR)) return res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();

  // Hermetic / offline-safe: the page pulls xterm from a CDN, but this test only
  // reads computed CSS + window.__termTheme (both defined by the inline script,
  // independent of xterm), and it runs in a blocking pre-push hook — so abort all
  // off-host requests rather than let a flaky/absent network fail a push.
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );

  // Start dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let s = await read(page);
  assert(s.bodyBg === DARK_BG, `dark: body bg is ${DARK_BG} (got ${s.bodyBg})`);
  assert(s.logBg === DARK_BG, `dark: .log bg follows var(--bg) (got ${s.logBg})`);

  // Flip to light WITHOUT reloading — this is the realtime path.
  await page.emulateMedia({ colorScheme: "light" });
  s = await read(page);
  assert(s.matchLight === true, "light: matchMedia reports light after live flip");
  assert(s.bodyBg === LIGHT_BG, `light: body bg flipped to ${LIGHT_BG} live (got ${s.bodyBg})`);
  assert(s.logBg === LIGHT_BG, `light: .log bg flipped live (got ${s.logBg})`);

  // Light-mode xterm theme must keep white slots dark and the bg light.
  const t = await page.evaluate(() => window.__termTheme());
  assert(lum(t.white) < 0.6, `light: ANSI white is dark for contrast (got ${t.white})`);
  assert(lum(t.brightWhite) < 0.6, `light: ANSI brightWhite is dark (got ${t.brightWhite})`);
  assert(lum(t.background) > 0.9, `light: terminal background stays light (got ${t.background})`);

  // Flip back to dark, still no reload.
  await page.emulateMedia({ colorScheme: "dark" });
  s = await read(page);
  assert(s.bodyBg === DARK_BG, `dark again: body bg flipped back live (got ${s.bodyBg})`);

  console.log("\nPASS: console adapts to OS light/dark in real time (no reload).");
} finally {
  await browser.close();
  server.close();
}
