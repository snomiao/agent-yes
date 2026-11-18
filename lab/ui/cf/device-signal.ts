import { betterAuth } from "better-auth";
import { authOptions, authOrigin } from "./auth";
import type { Env } from "./worker";

// Only SDP crosses this service. The user ID comes from the verified session.
// The two sockets live in memory for a short pairing window.
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
  private sockets = new Set<WebSocket>();
  fetch() {
    if (this.sockets.size >= 2) return new Response("Two devices already pairing", { status: 409 });
    const { 0: client, 1: ws } = new WebSocketPair();
    const role = this.sockets.size === 0 ? "offer" : "answer";
    ws.accept();
    this.sockets.add(ws);
    const timeout = setTimeout(() => ws.close(1000, "Pairing window ended"), 90000);
    const cleanup = () => {
      clearTimeout(timeout);
      if (this.sockets.delete(ws)) {
        for (const peer of this.sockets) peer.close(1000, "Peer left");
      }
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
    let sent = false;
    ws.addEventListener("message", ({ data }) => {
      try {
        if (sent || typeof data !== "string" || data.length > 48000) throw Error();
        const { type, sdp } = JSON.parse(data);
        if (
          this.sockets.size !== 2 ||
          type !== role ||
          typeof sdp !== "string" ||
          !sdp.startsWith("v=0")
        )
          throw Error();
        sent = true;
        for (const peer of this.sockets) if (peer !== ws) peer.send(JSON.stringify({ type, sdp }));
      } catch {
        ws.close(1008, "Invalid signal");
      }
    });
    if (this.sockets.size === 2) [...this.sockets][0].send('{"type":"start"}');
    return new Response(null, { status: 101, webSocket: client });
  }
}
