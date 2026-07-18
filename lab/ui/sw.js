// Service worker for the agent-yes console PWA (scope: /w/).
//
// Strategy: NETWORK-FIRST for the same-origin /w/ shell. The console speaks a
// versioned wire protocol to the signaling server, so it must never run stale —
// online we always fetch fresh (and refresh the cache); the cache is only a
// fallback when offline, which is what makes the installed app launchable with no
// network. WebSocket signaling and cross-origin CDN scripts are not GET fetches we
// own, so they pass straight through.
const CACHE = "agent-yes-w-v3";
// Preview proxy: <scope>p/<encSrc>/<port>/* renders a machine's local dev
// server INSIDE the console's existing WebRTC tunnel (peer-to-peer, off the
// edge relay). We can't own the RTCPeerConnection here, so we forward each
// request to the controlling page (which does), streaming the response back.
// Scope-relative so it works at both /w/ (agent-yes.com) and / (ay serve --http).
const BASE = new URL("./", self.location.href).pathname; // "/w/" or "/"
const PREVIEW = new RegExp(
  "^" + BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "p/([^/]+)/(\\d{1,5})(/.*)?$",
);

async function pickClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Prefer a real console tab (not the preview iframe itself).
  return all.find((c) => !new URL(c.url).pathname.startsWith(BASE + "p/")) || all[0] || null;
}

async function proxyPreview(request, src, port, rest, allowInject) {
  const client = await pickClient();
  if (!client) return new Response("open the agent-yes console to preview", { status: 502 });
  const headers = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
  return new Promise((resolve) => {
    const mc = new MessageChannel();
    let resolved = false;
    mc.port1.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type !== "head") {
        if (msg.type === "error" && !resolved) {
          resolved = true;
          resolve(new Response("preview tunnel error: " + msg.message, { status: 502 }));
        }
        return;
      }
      resolved = true;
      const headers = new Headers(msg.headers);
      const ct = headers.get("content-type") || "";
      // HTML document navigations (the /p/ path itself, not app subresources):
      // buffer, strip CSP, and inject a window.WebSocket shim so the app's own
      // sockets (Vite HMR) also ride the P2P tunnel. Everything else streams.
      if (allowInject && ct.includes("text/html")) {
        const chunks = [];
        mc.port1.onmessage = (e2) => {
          const m2 = e2.data;
          if (m2.type === "body") chunks.push(new Uint8Array(m2.chunk));
          else if (m2.type === "end")
            resolve(injectBootstrap(chunks, msg, headers, src, Number(port)));
          else if (m2.type === "error")
            resolve(new Response("preview error: " + m2.message, { status: 502 }));
        };
        return;
      }
      const stream = new ReadableStream({
        start(controller) {
          mc.port1.onmessage = (e2) => {
            const m2 = e2.data;
            if (m2.type === "body") controller.enqueue(new Uint8Array(m2.chunk));
            else if (m2.type === "end") controller.close();
            else if (m2.type === "error") controller.error(new Error(m2.message));
          };
        },
      });
      resolve(new Response(stream, { status: msg.status, statusText: msg.statusText, headers }));
    };
    client.postMessage(
      {
        type: "ay-preview-fetch",
        src,
        port: Number(port),
        method: request.method,
        path: rest,
        headers,
        body,
      },
      [mc.port2, ...(body ? [body.buffer] : [])],
    );
  });
}

// Concatenate the buffered HTML chunks, strip CSP, and inject a bootstrap
// <script> that replaces window.WebSocket with the parent console's tunneled
// shim — so a dev server's own sockets (Vite HMR) ride the P2P tunnel too. Runs
// first (right after <head>) so the override is in place before app scripts.
function injectBootstrap(chunks, msg, headers, src, port) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  const raw = new TextDecoder().decode(all);
  const boot =
    "<script>(function(){try{var mk=window.parent&&window.parent.__ayMakeWS;" +
    "if(mk)window.WebSocket=mk(" +
    JSON.stringify(src) +
    "," +
    JSON.stringify(port) +
    ");}catch(e){}})();</" +
    "script>";
  const html = /<head[^>]*>/i.test(raw) ? raw.replace(/<head[^>]*>/i, (m) => m + boot) : boot + raw;
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("content-length");
  return new Response(html, { status: msg.status, statusText: msg.statusText, headers });
}

const SHELL = [
  "./",
  "./index.html",
  "./room-client.js",
  "./console-logic.js",
  "./rtc.js",
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
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN / signaling pass through
  // Preview proxy (any method): a request is a preview request if its own path
  // is under <base>p/<src>/<port>/ (the iframe navigation + relative URLs), OR
  // it comes from a preview-iframe CLIENT (an app's absolute-path subresource
  // like Vite's /@vite/client — which resolves to the origin root, not our
  // prefix). Either way we proxy it to that machine's port over the tunnel.
  const own = PREVIEW.exec(url.pathname);
  if (own) {
    const rest = (own[3] || "/") + url.search;
    // Navigations to the /p/ root/route may be an HTML doc → allow WS-shim
    // injection; app subresources (below) never inject.
    e.respondWith(proxyPreview(req, decodeURIComponent(own[1]), own[2], rest, true));
    return;
  }
  e.respondWith(maybePreviewFromClient(e, req, url));
});

// If the request came from a preview iframe, proxy it to that iframe's port
// (appPath = the request's own path); otherwise fall back to the shell handler.
async function maybePreviewFromClient(e, req, url) {
  const clientId = e.clientId || e.resultingClientId;
  if (clientId) {
    const client = await self.clients.get(clientId).catch(() => null);
    const cm = client && PREVIEW.exec(new URL(client.url).pathname);
    if (cm) {
      // Subresources (Vite's /@vite/client, module chunks, etc.) never get the
      // WS shim injected — only the top-level /p/ navigation does.
      return proxyPreview(req, decodeURIComponent(cm[1]), cm[2], url.pathname + url.search, false);
    }
  }
  return shellFetch(req, url);
}

async function shellFetch(req, url) {
  const p = url.pathname;
  // Pass through non-GET, the API (SSE/POST — never cache), and anything off the
  // shell. Only cache the static console shell for offline launch.
  const isApi = p === "/api" || p.startsWith("/api/");
  if (req.method !== "GET" || isApi || !p.startsWith(BASE)) return fetch(req);
  // Network-first for the same-origin shell; cache is the offline fallback.
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
}
