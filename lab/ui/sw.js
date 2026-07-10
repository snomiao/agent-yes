// Service worker for the agent-yes console PWA (scope: /w/).
//
// Strategy: NETWORK-FIRST for the same-origin /w/ shell. The console speaks a
// versioned wire protocol to the signaling server, so it must never run stale —
// online we always fetch fresh (and refresh the cache); the cache is only a
// fallback when offline, which is what makes the installed app launchable with no
// network. WebSocket signaling and cross-origin CDN scripts are not GET fetches we
// own, so they pass straight through.
const CACHE = "agent-yes-w-v2";
const SHELL = [
  "./",
  "./index.html",
  "./room-client.js",
  "./console-logic.js",
  "./e2e.js",
  "./qrcode.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only the same-origin /w/ shell; let everything else (CDN, signaling) be.
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/w/")) return;
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        return cached || (await caches.match("./index.html")) || Response.error();
      }
    })(),
  );
});
