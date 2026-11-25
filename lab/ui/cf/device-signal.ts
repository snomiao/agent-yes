import { betterAuth } from "better-auth";
import { authOptions, authOrigin } from "./auth";
import type { Env } from "./worker";

// The service exchanges peer IDs, negotiation controls and SDP. The user ID comes from the verified session.
// Connection identifiers last only for this rendezvous and are never written to D1.
export async function signal(req: Request, env: Env) {
  if (req.method !== "GET" || req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response(null, { status: 426 });
  const origin = authOrigin(env);
  if (req.headers.get("Origin") !== origin || new URL(req.url).origin !== origin)
    return new Response(null, { status: 403 });
  const session = await betterAuth(authOptions(env)).api.getSession({ headers: req.headers });
  if (!session) return new Response(null, { status: 401 });
  const id = env.DEVICE_SIGNAL.idFromName(session.user.id);
  return env.DEVICE_SIGNAL.get(id).fetch("https://internal/pair", {
    headers: { Upgrade: "websocket" },
  });
}

export class DeviceSignal {
  private sockets = new Map<string, WebSocket>();

  fetch() {
    const { 0: client, 1: ws } = new WebSocketPair();
    ws.accept();
    this.attach(ws);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws: WebSocket) {
    const id = crypto.randomUUID();
    const pair = () => {
      for (const [peer, socket] of this.sockets) {
        if (peer === id) continue;
        const round = crypto.randomUUID();
        socket.send(JSON.stringify({ type: "start", peer: id, round, offer: false }));
        ws.send(JSON.stringify({ type: "start", peer, round, offer: true }));
      }
    };
    this.sockets.set(id, ws);
    // Renew through the authenticated HTTP upgrade. A socket must not outlive
    // a revoked session indefinitely, even if its browser never signs out.
    const lease = setTimeout(() => ws.close(1000, "Renew session"), 90000);
    const cleanup = () => {
      clearTimeout(lease);
      this.sockets.delete(id);
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
    ws.addEventListener("message", ({ data }) => {
      try {
        if (typeof data !== "string" || data.length > 48000) throw Error();
        const { type, peer, round, sdp } = JSON.parse(data);
        if (type === "refresh") return pair();
        if (
          (type !== "offer" && type !== "answer") ||
          typeof sdp !== "string" ||
          !sdp.startsWith("v=0") ||
          typeof round !== "string" ||
          !/^[0-9a-f-]{36}$/.test(round)
        )
          throw Error();
        this.sockets.get(peer)?.send(JSON.stringify({ type, peer: id, round, sdp }));
      } catch {
        ws.close(1008, "Invalid signal");
      }
    });
    pair();
  }
}
