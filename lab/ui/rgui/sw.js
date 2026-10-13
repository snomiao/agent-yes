// Service worker for the agent-yes rgui PWA (scope: /r/, and the /rgui/ alias).
//
// Strategy:
//   • NETWORK-FIRST for the same-origin shell (index.html + main.js) so a
//     redeploy is picked up the moment the network is back; the cache is only an
//     offline-launch fallback — that's what makes the installed app launchable
//     with no network.
//   • CACHE-FIRST for the version-pinned CDN xterm libs (immutable @<ver> URLs),
//     so the graph UI actually RENDERS offline instead of failing on a missing
//     script. Pinned URLs never change, so serving them from cache is safe.
//
// Live agent data arrives over the cross-origin signaling socket (not a GET we
// own), so it passes straight through — offline the graph simply shows its
// demo/connecting state, which is fine: the point is the UI still loads.
//
// Scope-relative (BASE) so the SAME file works at /r/ and at the /rgui/ alias.
const BASE = new URL("./", self.location.href).pathname; // "/r/" or "/rgui/"
const CACHE = "agent-yes-rgui-v1";
const SHELL = ["./", "./index.html", "./main.js", "./manifest.webmanifest", "./icon.svg"];
// Version-pinned CDN libs — same versions the console (/w/) loads.
const CDN = [
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css",
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js",
  "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js",
  "https://cdn.jsdelivr.net/npm/@xterm/addon-canvas@0.7.0/lib/addon-canvas.min.js",
  "https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // Best-effort: a single 404/offline asset must not fail the whole install.
      Promise.all([c.addAll(SHELL).catch(() => {}), c.addAll(CDN).catch(() => {})]),
    ),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // Only evict OUR OWN stale versions. Cache Storage is per-origin and
      // agent-yes.com also hosts the /w/ console PWA — deleting anything that
      // isn't an "agent-yes-rgui-" cache would wipe the console's offline shell.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("agent-yes-rgui-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Version-pinned CDN libs → cache-first (immutable). Lets the UI render offline.
  if (CDN.includes(url.href)) {
    e.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === "opaque")) {
            (await caches.open(CACHE)).put(req, res.clone());
          }
          return res;
        } catch {
          return (await caches.match(req)) || Response.error();
        }
      })(),
    );
    return;
  }

  // Only the same-origin /r/ (or /rgui/) shell; live signaling / other origins
  // pass through. /api paths (if any) are live data — never serve them stale.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  if (url.pathname.includes("/api/")) return;

  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        const cached = await caches.match(req);
        return (
          cached ||
          (await caches.match(BASE + "index.html")) ||
          (await caches.match("./index.html")) ||
          Response.error()
        );
      }
    })(),
  );
});
