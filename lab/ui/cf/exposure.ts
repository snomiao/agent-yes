// Exposure Durable Object: the edge-relay leg of `ay expose <port>`.
//
// One DO per exposure id. The daemon dials IN with an outbound WebSocket
// (wss://agent-yes.com/_ay/tunnel/<id>) and keeps it open; visitors hit
// https://<id>.agent-yes.com/* and their HTTP requests / WebSockets are
// multiplexed onto that daemon socket using the codehost tunnel protocol
// (binary frames, streamId-multiplexed — see codehost/tunnel). The daemon
// runs TunnelHost against 127.0.0.1:<port>; this DO runs the TunnelClient.
//
// Auth model (MVP, private-by-default):
// - Daemon leg: first WS message is a JSON hello carrying a random key. The
//   first hello pins the key (TOFU, like the signaling Room); a reconnect must
//   present the same key or is closed 1008. The key is never logged/echoed.
// - Visitor leg: the daemon's hello also carries SHA-256 hashes of single-use
//   claim tokens. A visitor opens /_ay/claim?t=<token> once: the token hashes
//   to a stored claim, which is consumed and swapped for an HttpOnly session
//   cookie (8h). Every other request needs that cookie. No cookie → 403.
//   Unauthenticated bytes NEVER reach the daemon.

import { TunnelClient } from "codehost/tunnel";
import type { TunnelTransport } from "codehost/tunnel";

export interface ExposureEnv {}

/** Visitor request bodies are buffered before tunneling — cap them. */
const MAX_BODY = 25 * 1024 * 1024;
/** Session cookie lifetime. */
const SESSION_MS = 8 * 60 * 60 * 1000;
/** An unclaimed token self-expires after this, so a leaked link is short-lived. */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
/** Sweep cadence for expired sess:/claim: keys (also self-reschedules). */
const SWEEP_MS = 60 * 60 * 1000;
/** Keep at most this many unclaimed tokens (re-runs of `ay expose` add one each). */
const MAX_CLAIMS = 8;
/** Hard cap on concurrent sockets per exposure — bounds a daemon-leg flood. */
const MAX_SOCKETS = 16;
/** A daemon socket that never authenticates is closed after this. */
const UNAUTH_MS = 15 * 1000;
/** Daemon keepalive: text frames answered at the edge without waking the DO. */
const PING = "ping";
const PONG = "pong";

const COOKIE = "__ay_sess";

type Attach = { role: "daemon"; authed: boolean; at: number };

interface Hello {
  t: "hello";
  key: string;
  port?: number;
  claims?: string[]; // sha256 hex of unused claim tokens
  v?: number;
}

export class Exposure {
  // In-memory tunnel client over the live daemon socket. Rebuilt lazily after
  // hibernation — any stream that was in flight kept the DO awake, so a fresh
  // client on wake only ever starts from zero pending streams.
  private tunnel: TunnelClient | null = null;
  private tunnelWs: WebSocket | null = null;
  private frameCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(private state: DurableObjectState) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Daemon leg. The Worker sets the /_daemon path EXCLUSIVELY for the apex
    // `ay expose` tunnel route, so a visitor can never reach it (their requests
    // always arrive under /_visit). Still key-gated in webSocketMessage.
    if (url.pathname === "/_daemon") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // Bound a flood of unauthenticated daemon-leg sockets (the id is public,
      // so anyone can dial the apex tunnel path): cap concurrency and let the
      // sweep alarm reap any that never authenticate.
      if (this.state.getWebSockets().length >= MAX_SOCKETS) {
        return new Response("too many connections", { status: 503 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ role: "daemon", authed: false, at: Date.now() } satisfies Attach);
      await this.ensureSweep(UNAUTH_MS);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Visitor leg: the Worker prefixes the real path with /_visit.
    const path = url.pathname.startsWith("/_visit") ? url.pathname.slice("/_visit".length) || "/" : url.pathname;

    // Visitor claim: swap a single-use token for a session cookie.
    if (path === "/_ay/claim") {
      return this.claim(url);
    }

    // Everything else is a visitor request → session gate, then tunnel.
    if (!(await this.hasSession(req))) {
      return new Response(lockedPage(url.hostname), {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const daemon = this.daemonSocket();
    if (!daemon) {
      return new Response("This exposure's daemon is offline (ay expose is not running).\n", {
        status: 502,
        headers: { "cache-control": "no-store" },
      });
    }
    const tunnel = this.tunnelFor(daemon);

    if (req.headers.get("Upgrade") === "websocket") {
      return this.visitorWebSocket(tunnel, url.hostname, path + url.search, req);
    }
    return this.visitorHttp(tunnel, url.hostname, path + url.search, req);
  }

  // ---- daemon socket / tunnel plumbing ----

  private daemonSocket(): WebSocket | null {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.authed) return ws;
    }
    return null;
  }

  private tunnelFor(ws: WebSocket): TunnelClient {
    if (this.tunnel && this.tunnelWs === ws) return this.tunnel;
    const transport: TunnelTransport = {
      // Copy into a fresh ArrayBuffer-backed view — the protocol's WS
      // fragmentation emits subarray views (byteOffset > 0) that some
      // WebSocket.send implementations mishandle.
      send: (frame) => {
        const copy = new Uint8Array(frame.byteLength);
        copy.set(frame);
        ws.send(copy);
      },
      isOpen: () => ws.readyState === WebSocket.READY_STATE_OPEN,
      bufferedAmount: () => 0,
      onFrame: (cb) => {
        this.frameCb = cb;
      },
      onClose: (cb) => {
        this.closeCb = cb;
      },
    };
    this.tunnelWs = ws;
    this.tunnel = new TunnelClient(transport);
    return this.tunnel;
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (a?.role !== "daemon") return;

    if (!a.authed) {
      if (typeof msg !== "string") return ws.close(1008, "expected hello");
      let hello: Hello;
      try {
        hello = JSON.parse(msg);
      } catch {
        return ws.close(1008, "expected hello");
      }
      if (hello.t !== "hello" || typeof hello.key !== "string" || hello.key.length < 32) {
        return ws.close(1008, "expected hello");
      }
      const stored = await this.state.storage.get<string>("key");
      if (stored === undefined) {
        await this.state.storage.put("key", hello.key);
        await this.state.storage.put("createdAt", Date.now());
      } else if (stored !== hello.key) {
        return ws.close(1008, "forbidden"); // key never echoed
      }
      await this.registerClaims(hello.claims);
      // One daemon at a time: drop any previous socket.
      for (const other of this.state.getWebSockets()) {
        if (other !== ws) other.close(1012, "replaced");
      }
      ws.serializeAttachment({ role: "daemon", authed: true, at: a.at } satisfies Attach);
      this.tunnel = null; // next visitor request binds to this socket
      this.tunnelWs = null;
      ws.send(JSON.stringify({ t: "ready" }));
      return;
    }

    if (typeof msg === "string") {
      if (msg === PING) return void ws.send(PONG); // auto-response fallback
      // A running daemon can register fresh claim tokens without reconnecting
      // (the console mints one each time the owner re-opens an exposure).
      let ctrl: { t?: string; claims?: string[] };
      try {
        ctrl = JSON.parse(msg);
      } catch {
        return;
      }
      if (ctrl.t === "claim") await this.registerClaims(ctrl.claims);
      return;
    }
    // Binary tunnel frame from the daemon → the in-memory client (if any).
    // After hibernation there may be no client yet; frames for dead streams
    // are dropped by the client core anyway.
    if (this.tunnelWs === ws) this.frameCb?.(new Uint8Array(msg));
  }

  webSocketClose(ws: WebSocket): void {
    if (this.tunnelWs === ws) {
      this.closeCb?.(); // fails pending visitor streams
      this.tunnel = null;
      this.tunnelWs = null;
    }
  }

  // ---- visitor session ----

  private async claim(url: URL): Promise<Response> {
    const token = url.searchParams.get("t") ?? "";
    const denied = new Response(
      "Invalid or already-used claim link. Ask the owner for a fresh one (re-run `ay expose`).\n",
      { status: 403, headers: { "cache-control": "no-store" } },
    );
    if (token.length < 16) return denied;

    const key = `claim:${await sha256hex(token)}`;
    const exp = await this.state.storage.get<number>(key);
    if (exp === undefined) return denied;
    // Consume the token whether or not it's expired (strictly single-use).
    await this.state.storage.delete(key);
    if (Date.now() > exp) return denied;

    const sess = randHex(32);
    await this.state.storage.put(`sess:${sess}`, Date.now() + SESSION_MS);
    await this.ensureSweep();
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": `${COOKIE}=${sess}; Max-Age=${SESSION_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    });
  }

  private async hasSession(req: Request): Promise<boolean> {
    const sess = cookieValue(req.headers.get("cookie") ?? "", COOKIE);
    if (!sess) return false;
    const exp = await this.state.storage.get<number>(`sess:${sess}`);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      await this.state.storage.delete(`sess:${sess}`);
      return false;
    }
    return true;
  }

  // Register fresh claim tokens (bounded: drop oldest beyond MAX_CLAIMS).
  // claim: values are expiry timestamps, and TTL is constant, so ascending
  // value == oldest-first — evict the truly oldest, not a random hash.
  private async registerClaims(raw: string[] | undefined): Promise<void> {
    const claims = (raw ?? []).filter((c) => /^[a-f0-9]{64}$/.test(c)).slice(0, MAX_CLAIMS);
    if (!claims.length) return;
    const existing = [...(await this.state.storage.list<number>({ prefix: "claim:" }))].sort((a, b) => a[1] - b[1]);
    const excess = existing.length + claims.length - MAX_CLAIMS;
    for (const [k] of existing.slice(0, Math.max(0, excess))) await this.state.storage.delete(k);
    const expires = Date.now() + CLAIM_TTL_MS;
    for (const c of claims) await this.state.storage.put(`claim:${c}`, expires);
    await this.ensureSweep();
  }

  // Schedule the sweep alarm so expired sess:/claim: keys and stale unauthed
  // sockets can't pile up. `withinMs` pulls an existing later alarm earlier
  // (e.g. a 15s unauth reap vs the hourly key sweep).
  private async ensureSweep(withinMs: number = SWEEP_MS): Promise<void> {
    const at = Date.now() + withinMs;
    const cur = await this.state.storage.getAlarm();
    if (cur === null || cur > at) await this.state.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let live = 0;
    for (const prefix of ["sess:", "claim:"] as const) {
      const entries = await this.state.storage.list<number>({ prefix });
      for (const [k, exp] of entries) {
        if (now > exp) await this.state.storage.delete(k);
        else live++;
      }
    }
    // Reap daemon-leg sockets that never authenticated within UNAUTH_MS.
    let pendingUnauth = false;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && !a.authed) {
        if (now - a.at >= UNAUTH_MS) ws.close(1008, "auth timeout");
        else pendingUnauth = true;
      }
    }
    // Reschedule while anything still needs watching.
    if (pendingUnauth) await this.state.storage.setAlarm(now + UNAUTH_MS);
    else if (live > 0) await this.state.storage.setAlarm(now + SWEEP_MS);
  }

  // ---- visitor request paths ----

  private async visitorHttp(tunnel: TunnelClient, hostname: string, pathAndQuery: string, req: Request): Promise<Response> {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return new Response("body too large", { status: 413 });

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (k === "cookie") {
        const rest = stripCookie(v, COOKIE); // the session is ours, not the app's
        if (rest) headers[k] = rest;
        return;
      }
      headers[k] = v;
    });
    // Do NOT send x-forwarded-host: the daemon's TunnelHost uses it AS the
    // upstream Host, and the public subdomain trips dev-server host allow-lists
    // (Vite/webpack/Next/Storybook → "host not allowed"). Omitting it makes
    // TunnelHost default Host to 127.0.0.1:<port>, which every dev server
    // accepts. The public host still reaches the app via x-forwarded-proto +
    // x-original-host (forwarded through untouched, unlike x-forwarded-host).
    // Drop any client-sent copies first so a visitor can't spoof them.
    delete headers["x-forwarded-host"];
    headers["x-forwarded-proto"] = "https";
    headers["x-original-host"] = hostname;

    let body: Uint8Array | undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      const capped = await readCapped(req.body, MAX_BODY);
      if (!capped) return new Response("body too large", { status: 413 });
      body = capped;
    }

    try {
      return await tunnel.fetch(req.method, pathAndQuery, headers, body);
    } catch (err) {
      return new Response(`upstream error: ${String(err)}\n`, { status: 502, headers: { "cache-control": "no-store" } });
    }
  }

  private visitorWebSocket(tunnel: TunnelClient, _hostname: string, pathAndQuery: string, req: Request): Response {
    const protoHeader = req.headers.get("Sec-WebSocket-Protocol");
    const protocols = protoHeader ? protoHeader.split(",").map((s) => s.trim()) : undefined;
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept(); // plain accept: an active visitor WS keeps the DO awake by design

    const handle = tunnel.openWs(pathAndQuery, protocols, {
      onOpenAck: (ok) => {
        if (!ok) server.close(1011, "upstream refused");
      },
      onText: (text) => server.send(text),
      onBin: (data) => server.send(data),
      onClose: (code, reason) => {
        try {
          server.close(sanitizeCloseCode(code), reason.slice(0, 123));
        } catch {
          /* already closed */
        }
      },
    });
    server.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") handle.sendText(ev.data);
      else handle.sendBin(new Uint8Array(ev.data as ArrayBuffer));
    });
    server.addEventListener("close", () => handle.close());
    server.addEventListener("error", () => handle.close());

    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(protocols?.[0] ? { headers: { "Sec-WebSocket-Protocol": protocols[0] } } : {}),
    });
  }
}

// ---- small pure helpers ----

/** Read a stream into one buffer, aborting (→ null) once it exceeds `max`, so a
 *  body without/with-a-lying Content-Length can't be buffered unboundedly. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function stripCookie(header: string, name: string): string {
  return header
    .split(";")
    .map((s) => s.trim())
    .filter((part) => part.split("=")[0] !== name)
    .join("; ");
}

/** Close codes a server may pass to close(): 1000 or 3000-4999. */
function sanitizeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lockedPage(host: string): string {
  return `<!doctype html><meta charset="utf-8"><title>locked — ${host}</title>
<meta name="robots" content="noindex">
<body style="font-family:system-ui;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#333">
<h1 style="font-size:1.3rem">🔒 This preview is private</h1>
<p><code>${host}</code> is a private port exposure served by <a href="https://agent-yes.com">agent-yes</a>.</p>
<p>Access requires a one-time claim link from the machine's owner (printed by <code>ay expose</code>).</p>
</body>`;
}
