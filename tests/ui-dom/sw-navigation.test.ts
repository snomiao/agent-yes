/**
 * Regression guard: opening a SECOND tab on the console must not hang.
 *
 * The service worker (lab/ui/sw.js) intercepts every same-origin request,
 * including top-level navigations. A navigation has no existing client — only a
 * *reserved* one named by `FetchEvent.resultingClientId` — and `clients.get()`
 * never settles for a reserved client, because the client only becomes gettable
 * once the navigation commits, which cannot happen until `respondWith()`
 * settles. Awaiting it inside the fetch handler therefore deadlocks the
 * navigation.
 *
 * The failure is invisible on a cold profile: the first tab loads before the
 * worker takes control, so it is fast. Every tab opened afterwards — the case a
 * user hits by sharing the console link with themselves in a second tab — hangs
 * on a blank page indefinitely. Measured before the fix: tab 1 committed in
 * 24ms, tabs 2 and 3 never committed (>45s, >180s against production).
 *
 * This test needs the REAL sw.js on a secure origin, so it runs its own static
 * server over lab/ui rather than the shared stub in ./server.ts (which
 * deliberately does not serve sw.js — registering it there would deadlock every
 * other DOM test).
 */
import { chromium, type Browser } from "playwright";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../lab/ui");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

// A plain static server over lab/ui. 127.0.0.1 is a secure context, so the
// service worker installs exactly as it does on https://agent-yes.com/w/.
function startStatic(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(UI, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/index.html`, close: () => server.close() });
    }),
  );
}

describe("service worker navigation", () => {
  let browser: Browser;
  let srv: { url: string; close: () => void };

  beforeAll(async () => {
    browser = await chromium.launch();
    srv = await startStatic();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    srv?.close();
  });

  it("serves a second tab once the worker controls the origin", async () => {
    // A fresh context per run: no worker registered, so tab 1 is uncontrolled.
    const ctx = await browser.newContext();
    try {
      const first = await ctx.newPage();
      await first.goto(srv.url, { waitUntil: "commit", timeout: 30_000 });
      // Wait for the worker to install and claim — `activate` calls clients.claim(),
      // so this resolves as soon as it has taken over the origin. Until it does,
      // a second tab would bypass the fetch handler and pass trivially.
      await first.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, {
        timeout: 30_000,
      });

      // The regression: this navigation goes through the worker's fetch handler.
      // Before the fix it never committed. The timeout is the assertion — a
      // healthy commit takes tens of milliseconds.
      const second = await ctx.newPage();
      const started = Date.now();
      await second.goto(srv.url, { waitUntil: "commit", timeout: 20_000 });
      expect(Date.now() - started).toBeLessThan(20_000);

      // And it really was served by the worker, not by a bypass.
      expect(await second.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    } finally {
      await ctx.close();
    }
  }, 120_000);
});
