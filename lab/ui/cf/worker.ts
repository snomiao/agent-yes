// WebRTC signaling server for `ay serve --share=webrtc://room:token@s.agent-yes.com`.
//
// One Durable Object per room relays SDP offers/answers + ICE candidates between
// the local `ay serve` peer (role=host) and one or more browser peers
// (role=client). It is a *rendezvous* only — media/data never flow through here,
// they go peer-to-peer over the WebRTC DataChannel once signaling completes.
//
// Auth: the room token is carried in the first WS message (NOT the URL, so it
// can't leak into request logs). The first peer to open a room fixes its token;
// every later peer must present the same token or it is rejected. The token is
// never logged.
//
// For the v2 (e2e) protocol the token a peer sends is `authToken = HKDF(S,…)`,
// NOT the URL secret S — so even a fully compromised server learns nothing it
// could use to read or inject traffic (the AES keys never leave the endpoints;
// see lab/ui/e2e.js). This DO additionally TOFU-pins the protocol version so an
// HONEST server fails a cross-generation join closed; that pin is a UX/migration
// aid only — the real confidentiality/integrity guarantees are client-enforced.

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const SUBPROTO = "ay-signal-1";

// Defense-in-depth CSP for the console document. The console renders agent
// metadata (terminal title / prompt / cwd) supplied by whatever host a share
// link points at — untrusted by definition — so even with output escaping we
// lock down where a hypothetical injection could send data. Blocks arbitrary
// fetch/beacon exfil (connect-src / img-src), plugins (object-src), <base>
// hijack (base-uri), clickjacking (frame-ancestors) and form exfil
// (form-action). script-src keeps 'unsafe-inline' because the console is a
// single-file inline app (no inline event-handler attributes exist, so a
// stricter nonce split is a follow-up, not a regression risk); xterm loads from
// jsdelivr. connect-src allows any wss: so custom / self-hosted signaling hosts
// still work, while forbidding arbitrary https fetch exfil. Keep this in sync
// with the copy in ts/serve.ts (serveUiFile).
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'self' https://s.agent-yes.com https://agent-yes.com wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

// Heartbeat frames (host pings, server pongs). Defined once so the hibernation
// auto-response pair below matches the host's wire bytes EXACTLY — the runtime
// only auto-answers an incoming message that is byte-identical to PING.
const PING = JSON.stringify({ type: "ping" });
const PONG = JSON.stringify({ type: "pong" });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok\n");

    // WebSocket to /<room> → signaling DO (this is the s.agent-yes.com path).
    const m = /^\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (m && req.headers.get("Upgrade") === "websocket") {
      const id = env.ROOMS.idFromName(m[1]!);
      return env.ROOMS.get(id).fetch(req);
    }

    // Everything else → the static console UI (agent-yes.com). Serve the console
    // and its scripts with no-cache so a CDN/browser can't pin a stale client that
    // predates a protocol upgrade — combined with the v:2 hello assertion, a stale
    // client fails closed ("update required") rather than running an old wire.
    const res = await env.ASSETS.fetch(req);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/html") || ct.includes("javascript")) {
      const h = new Headers(res.headers);
      h.set("Cache-Control", "no-cache");
      if (ct.includes("text/html")) h.set("Content-Security-Policy", CSP);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },
};

type Attach = { authed: boolean; role?: "host" | "client"; peer?: string };

export class Room {
  constructor(private state: DurableObjectState) {
    // Answer the host's 20s keepalive ping from the runtime itself, so a ping on
    // a hibernated socket is pong'd WITHOUT waking the DO. Waking on every ping
    // would keep the DO out of hibernation and accrue billable duration — the
    // exact failure mode that drove ~99.9% of the account's DO time on the
    // codehost wire. setWebSocketAutoResponse persists across hibernation and
    // applies to all (current + future) accepted sockets. The inline ping
    // handler in webSocketMessage stays only as a fallback for a non-exact ping.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // The subprotocol only marks our protocol version — NO token here. (The token
    // is sent in the first message instead: Bun's WS client mangles long
    // subprotocol values, and keeping it out of the handshake also avoids any
    // chance of it reaching request logs.)
    const offered = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
      .split(",")
      .map((s) => s.trim());
    if (offered[0] && offered[0] !== SUBPROTO) {
      return new Response("bad subprotocol", { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ authed: false } satisfies Attach);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": SUBPROTO },
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
    const self = ws.deserializeAttachment() as Attach;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore non-JSON
    }

    if (!self.authed) {
      // First message must be the hello that carries role + token.
      if (msg.type !== "hello") return ws.close(1008, "expected hello");
      const role: "host" | "client" = msg.role === "host" ? "host" : "client";
      const token = String(msg.token ?? "");
      const proto = Number(msg.v ?? 1); // protocol generation (v2 = e2e)
      const stored = await this.state.storage.get<string>("token");
      const storedProto = (await this.state.storage.get<number>("proto")) ?? 1;
      if (stored === undefined) {
        if (role !== "host") return ws.close(1008, "room not open");
        await this.state.storage.put("token", token);
        await this.state.storage.put("proto", proto);
      } else {
        if (stored !== token) return ws.close(1008, "forbidden"); // token never echoed
        if (storedProto !== proto) return ws.close(1008, "protocol mismatch");
      }
      const peer = role === "host" ? "host" : crypto.randomUUID().slice(0, 8);
      ws.serializeAttachment({ authed: true, role, peer } satisfies Attach);
      ws.send(JSON.stringify({ type: "welcome", peer, role, v: proto }));
      if (role === "client") this.toHost({ type: "peer-join", peer });
      return;
    }

    // Heartbeat fallback: exact "{"type":"ping"}" frames are normally answered
    // by setWebSocketAutoResponse (see constructor) and never reach here, so the
    // DO stays hibernated. This only runs for a ping that didn't match the pair
    // byte-for-byte; answer it directly rather than relay it onward.
    if (msg.type === "ping") return void ws.send(PONG);

    if (self.role === "client") {
      msg.from = self.peer; // tag so the host can route the reply back
      this.toHost(msg);
    } else {
      const to = typeof msg.to === "string" ? msg.to : "";
      if (to) this.toPeer(to, msg);
    }
  }

  webSocketClose(ws: WebSocket): void {
    const self = ws.deserializeAttachment() as Attach;
    if (self.authed && self.role === "client") this.toHost({ type: "peer-leave", peer: self.peer });
  }

  // Role isn't a hibernation tag (it's only known after the hello), so route by
  // walking the sockets and reading each one's attachment.
  private toHost(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const s of this.state.getWebSockets()) {
      const a = s.deserializeAttachment() as Attach | null;
      if (a?.authed && a.role === "host") s.send(data);
    }
  }
  private toPeer(peer: string, obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const s of this.state.getWebSockets()) {
      const a = s.deserializeAttachment() as Attach | null;
      if (a?.authed && a.peer === peer) s.send(data);
    }
  }
}
