// WebRTC signaling server for `ay serve --share=webrtc://room:token@s.agent-yes.com`.
//
// One Durable Object per room relays SDP offers/answers + ICE candidates between
// the local `ay serve` peer (role=host) and one or more browser peers
// (role=client). It is a *rendezvous* only — media/data never flow through here,
// they go peer-to-peer over the WebRTC DataChannel once signaling completes.
//
// Auth: the room token is carried in the WebSocket subprotocol (NOT the URL, so
// it can't leak into request logs). The first peer to open a room fixes its
// token; every later peer must present the same token or it is rejected. The
// token is never logged.

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const SUBPROTO = "ay-signal-1";

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

    // Everything else → the static console UI (agent-yes.com).
    return env.ASSETS.fetch(req);
  },
};

type Attach = { authed: boolean; role?: "host" | "client"; peer?: string };

export class Room {
  constructor(private state: DurableObjectState) {}

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
      const stored = await this.state.storage.get<string>("token");
      if (stored === undefined) {
        if (role !== "host") return ws.close(1008, "room not open");
        await this.state.storage.put("token", token);
      } else if (stored !== token) {
        return ws.close(1008, "forbidden"); // token never echoed
      }
      const peer = role === "host" ? "host" : crypto.randomUUID().slice(0, 8);
      ws.serializeAttachment({ authed: true, role, peer } satisfies Attach);
      ws.send(JSON.stringify({ type: "welcome", peer, role }));
      if (role === "client") this.toHost({ type: "peer-join", peer });
      return;
    }

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
