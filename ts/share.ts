// `ay serve --webrtc` host peer: connect to the signaling server as a room host
// and bridge each browser peer's WebRTC DataChannel to this machine's `ay serve`
// API handler, called in-process — no HTTP listener, no port, no tunnel. The
// browser (agent-yes.com) thus reaches local agents peer-to-peer. See
// lab/ui/cf/worker.ts for the signaling protocol and lab/ui/index.html for the
// browser side.
import { randomBytes } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

const SUB = "ay-signal-1";
const MAX_CHUNK = 15_000; // keep DataChannel messages under the SCTP limit
const DEFAULT_SIGHOST = "s.agent-yes.com";
const HOST_HEARTBEAT_MS = 20000; // keepalive ping to the rendezvous + silent-drop detection

type IceServer = { urls: string | string[]; username?: string; credential?: string };
const STUN: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// Short-lived Cloudflare TURN credentials, minted from a long-term TURN key, so
// browsers can RELAY when a direct P2P path is impossible (symmetric NAT /
// CGNAT — the main cause of "rooms offline"). Set CF_TURN_KEY_ID +
// CF_TURN_API_TOKEN (create a TURN key in the Cloudflare dashboard: Realtime →
// TURN) to enable; without them we use STUN only, exactly as before. Cached
// until just before expiry; STUN-only fallback on any error so sharing never
// breaks because TURN is misconfigured or unreachable.
let iceCache: { servers: IceServer[]; exp: number } | null = null;
async function getIceServers(): Promise<IceServer[]> {
  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !apiToken) return STUN;
  if (iceCache && iceCache.exp > Date.now()) return iceCache.servers;
  const ttl = 3600; // credential lifetime, seconds
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!r.ok) throw new Error(`Cloudflare TURN ${r.status}`);
    const j = (await r.json()) as { iceServers?: IceServer[] };
    const servers = j.iceServers?.length ? j.iceServers : STUN;
    iceCache = { servers, exp: Date.now() + (ttl - 300) * 1000 }; // refresh ~5min early
    return servers;
  } catch (e) {
    console.error(`[share] Cloudflare TURN credential fetch failed; using STUN only: ${e}`);
    return STUN;
  }
}

export interface ShareOpts {
  /** webrtc://room:token@host, or undefined to mint a fresh (unpersisted)
   *  room+token — callers wanting a stable room use loadOrCreateShareRoom() */
  url?: string;
  /** signaling host when minting (default s.agent-yes.com) */
  sighost?: string;
  /** the local ay-serve API handler the channel bridges to (called in-process) */
  localFetch: (req: Request) => Promise<Response>;
  /** bearer token for the local ay-serve API */
  apiToken: string;
}

// The room+token persist like the serve token, so the share link (and any
// browser that saved the room) survives restarts — important for daemons,
// which would otherwise mint a new link on every restart. Delete the file to
// rotate the room.
function shareRoomPath(): string {
  const home = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  return path.join(home, ".share-room");
}

export async function loadOrCreateShareRoom(sighost = DEFAULT_SIGHOST): Promise<string> {
  try {
    const url = (await readFile(shareRoomPath(), "utf-8")).trim();
    if (url.startsWith("webrtc://")) return url;
  } catch {
    /* not yet minted */
  }
  const room = "r" + randomBytes(3).toString("hex");
  const token = randomBytes(32).toString("hex");
  const url = `webrtc://${room}:${token}@${sighost}`;
  await mkdir(path.dirname(shareRoomPath()), { recursive: true });
  await writeFile(shareRoomPath(), url, { mode: 0o600 });
  return url;
}

function parseShareUrl(s: string): { room: string; token: string; host: string } {
  const m = /^webrtc:\/\/([^:@/]+):([^@/]+)@(.+)$/.exec(s);
  if (!m) throw new Error(`bad --share url: ${s} (want webrtc://room:token@host)`);
  return { room: m[1]!, token: m[2]!, host: m[3]! };
}

// node-datachannel ships a native addon. Under Bun the module sometimes resolves
// from the global cache where the prebuilt .node isn't linked; this best-effort
// shim symlinks it in before we import. In a normal npm/bunx install the binary
// resolves from node_modules and the first import just works.
async function importRTC(): Promise<any> {
  try {
    return (await import("node-datachannel/polyfill")).RTCPeerConnection;
  } catch {
    try {
      const { existsSync, symlinkSync, mkdirSync, readdirSync } = await import("fs");
      const path = (await import("path")).default;
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      const pkg = path.dirname(require.resolve("node-datachannel/package.json"));
      const bin = path.join(pkg, "build", "Release", "node_datachannel.node");
      const cacheRoot = path.join((await import("os")).homedir(), ".bun", "install", "cache");
      if (existsSync(bin) && existsSync(cacheRoot)) {
        for (const d of readdirSync(cacheRoot)) {
          if (!d.startsWith("node-datachannel@")) continue;
          const dst = path.join(cacheRoot, d, "build", "Release");
          mkdirSync(dst, { recursive: true });
          const link = path.join(dst, "node_datachannel.node");
          if (!existsSync(link)) symlinkSync(bin, link);
        }
      }
    } catch {
      /* fall through — rethrow the original import error below */
    }
    return (await import("node-datachannel/polyfill")).RTCPeerConnection;
  }
}

/** Start the share bridge. Resolves once signaling is connected; runs until the
 *  process exits, reconnecting signaling on drop. Returns the shareable link. */
export async function startShare(
  opts: ShareOpts,
): Promise<{ room: string; link: string; close: () => void }> {
  const minted = !opts.url;
  const sighost = opts.sighost ?? DEFAULT_SIGHOST;
  const { room, token, host } = opts.url
    ? parseShareUrl(opts.url)
    : {
        room: "r" + randomBytes(3).toString("hex"),
        token: randomBytes(32).toString("hex"),
        host: sighost,
      };

  const RTCPeerConnection = await importRTC();
  const wsScheme = host.startsWith("localhost") || host.startsWith("127.") ? "ws" : "wss";
  const ui = host === "s.agent-yes.com" ? "https://agent-yes.com" : "http://localhost:7778";
  const suffix = host === "s.agent-yes.com" ? "" : "@" + host;
  const link = `${ui}/#${room}:${token}${suffix}`;

  type Peer = { pc: any; aborts: Map<number, AbortController> };
  const peers = new Map<string, Peer>();
  let closed = false; // set by close(); stops signaling reconnect + new peers
  let currentWs: WebSocket | undefined; // the live rendezvous socket, for close()

  const connectSignaling = (onReady: () => void) => {
    if (closed) return; // a reconnect timer queued before close() must not revive it
    const ws = new WebSocket(`${wsScheme}://${host}/${room}`, [SUB]);
    currentWs = ws;
    let ready = false;
    let lastRecv = Date.now();
    let hb: ReturnType<typeof setInterval> | undefined;
    const stopHb = () => {
      if (hb) {
        clearInterval(hb);
        hb = undefined;
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", role: "host", token }));
      ready = true;
      lastRecv = Date.now();
      // Keepalive + dead-link detection: ping the rendezvous and expect a pong.
      // A silently dropped ws (idle DO timeout, network flap) never fires
      // onclose, so if the server goes quiet for ~2 intervals, close+reconnect
      // ourselves — otherwise new browsers can't join until the process restarts.
      stopHb();
      hb = setInterval(() => {
        if (Date.now() - lastRecv > HOST_HEARTBEAT_MS * 2 + 5000) {
          stopHb();
          try {
            ws.close();
          } catch {}
          return;
        }
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }, HOST_HEARTBEAT_MS);
      onReady();
    };
    ws.onmessage = async (ev) => {
      if (closed) return;
      lastRecv = Date.now();
      const m = JSON.parse(ev.data as string);
      if (m.type === "pong") return; // heartbeat ack — liveness already recorded
      if (m.type === "peer-join") startPeer(ws, m.peer).catch(() => {});
      else if (m.type === "answer")
        await peers.get(m.from)?.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      else if (m.type === "candidate")
        await peers
          .get(m.from)
          ?.pc.addIceCandidate(m.candidate)
          .catch(() => {});
      else if (m.type === "peer-leave") closePeer(m.peer);
    };
    ws.onclose = () => {
      stopHb();
      if (closed) return; // shutting down — don't resurrect the rendezvous
      // Keep established WebRTC peers; just re-establish the rendezvous so new
      // browsers can still join. Backoff a little to avoid hot-looping.
      setTimeout(() => connectSignaling(() => {}), ready ? 1000 : 2000);
    };
    ws.onerror = () => {};
    return ws;
  };

  async function startPeer(ws: WebSocket, peerId: string) {
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    const aborts = new Map<number, AbortController>();
    peers.set(peerId, { pc, aborts });
    pc.onicecandidate = (e: any) => {
      if (e.candidate)
        ws.send(JSON.stringify({ type: "candidate", to: peerId, candidate: e.candidate }));
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) closePeer(peerId);
    };
    const dc = pc.createDataChannel("api");
    dc.onmessage = (e: any) => onReq(dc, aborts, JSON.parse(e.data));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Hand the browser the same ICE servers (incl. the short-lived TURN creds)
    // so it can relay too when there's no direct path.
    ws.send(
      JSON.stringify({ type: "offer", to: peerId, sdp: pc.localDescription.sdp, iceServers }),
    );
  }

  function closePeer(peerId: string) {
    const p = peers.get(peerId);
    if (!p) return;
    for (const a of p.aborts.values()) a.abort();
    try {
      p.pc.close();
    } catch {
      /* already closed */
    }
    peers.delete(peerId);
  }

  function send(dc: any, obj: object) {
    // readyState alone is racy: node-datachannel can still report "open" for a
    // tick after a dropped peer's channel is torn down underneath, so dc.send()
    // throws "DataChannel is closed". Swallow it — the frame is for a peer that's
    // already gone (closePeer aborts its in-flight requests right behind this).
    if (dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify(obj));
    } catch {
      /* peer vanished mid-send; dropping the frame is correct */
    }
  }

  async function onReq(dc: any, aborts: Map<number, AbortController>, req: any) {
    if (req.t === "abort") {
      aborts.get(req.id)?.abort();
      aborts.delete(req.id);
      return;
    }
    if (req.t !== "req") return;
    const { id, method, path: p, body } = req;
    const ac = new AbortController();
    aborts.set(id, ac);
    try {
      // The host part is a placeholder — the handler only routes on the path.
      const res = await opts.localFetch(
        new Request(`http://ay.local${p}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ?? undefined,
          signal: ac.signal,
        }),
      );
      send(dc, { t: "res", id, status: res.status, ct: res.headers.get("content-type") ?? "" });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        for (let i = 0; i < text.length; i += MAX_CHUNK)
          send(dc, { t: "data", id, chunk: text.slice(i, i + MAX_CHUNK) });
      }
      send(dc, { t: "end", id });
    } catch (e) {
      if ((e as Error).name !== "AbortError") send(dc, { t: "end", id, error: String(e) });
    } finally {
      aborts.delete(id);
    }
  }

  await new Promise<void>((resolve) => connectSignaling(resolve));
  void minted; // (informational) caller decides how to surface the link

  // Clean shutdown: stop the rendezvous (so it can't reconnect or accept new
  // peers) and close every peer connection so browsers get an immediate
  // DataChannel close and reconnect right away, instead of waiting out the
  // ~15-30s ICE timeout that an abrupt process exit would otherwise force.
  const close = () => {
    closed = true;
    try {
      currentWs?.close();
    } catch {
      /* already closing */
    }
    for (const peerId of [...peers.keys()]) closePeer(peerId);
  };
  return { room, link, close };
}
