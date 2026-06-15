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
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const MAX_CHUNK = 15_000; // keep DataChannel messages under the SCTP limit
const DEFAULT_SIGHOST = "s.agent-yes.com";

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
async function linkFromBunCache(): Promise<void> {
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
}

// `bunx agent-yes` / `bun add -g agent-yes` skip node-datachannel's install
// script (bun only honors trustedDependencies from the *root* package, and there
// agent-yes is a dependency), so the prebuilt .node is never downloaded and
// `--webrtc`/`--share` can't load the addon. Fetch it on demand with the
// prebuild-install CLI that ships in node-datachannel's dependency tree — the
// same `prebuild-install -r napi` its install script would have run.
async function fetchPrebuiltAddon(): Promise<boolean> {
  try {
    const path = (await import("path")).default;
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const ndDir = path.dirname(require.resolve("node-datachannel/package.json"));
    const binJs = require.resolve("prebuild-install/bin.js", { paths: [ndDir] });
    const { spawnSync } = await import("child_process");
    process.stderr.write("fetching node-datachannel prebuilt binary (one-time)…\n");
    // process.execPath is bun (or node) — both execute the prebuild-install CLI.
    const res = spawnSync(process.execPath, [binJs, "-r", "napi"], { cwd: ndDir, stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

async function importRTC(): Promise<any> {
  try {
    return (await import("node-datachannel/polyfill")).RTCPeerConnection;
  } catch (firstErr) {
    // Heal 1: symlink a built .node from the bun global cache into the resolved pkg.
    await linkFromBunCache().catch(() => {});
    try {
      return (await import("node-datachannel/polyfill")).RTCPeerConnection;
    } catch {
      /* still missing — try downloading the prebuilt binary below */
    }
    // Heal 2: the prebuilt binary was never downloaded — fetch it, then retry.
    if (await fetchPrebuiltAddon())
      return (await import("node-datachannel/polyfill")).RTCPeerConnection;
    throw firstErr;
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
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", role: "host", token }));
      ready = true;
      onReady();
    };
    ws.onmessage = async (ev) => {
      if (closed) return;
      const m = JSON.parse(ev.data as string);
      if (m.type === "peer-join") startPeer(ws, m.peer);
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
      if (closed) return; // shutting down — don't resurrect the rendezvous
      // Keep established WebRTC peers; just re-establish the rendezvous so new
      // browsers can still join. Backoff a little to avoid hot-looping.
      setTimeout(() => connectSignaling(() => {}), ready ? 1500 : 4000);
    };
    ws.onerror = () => {};
    return ws;
  };

  function startPeer(ws: WebSocket, peerId: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
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
    pc.createOffer()
      .then((o: any) => pc.setLocalDescription(o))
      .then(() =>
        ws.send(JSON.stringify({ type: "offer", to: peerId, sdp: pc.localDescription.sdp })),
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
