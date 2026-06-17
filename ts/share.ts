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
import {
  CONFIRM_TIMEOUT_MS,
  FLAG_CONFIRM,
  MARKER,
  MAX_CHUNK,
  computeTranscriptHash,
  deriveAuthToken,
  deriveDirKeys,
  open as e2eOpen,
  seal as e2eSeal,
  packEnvelope,
  parseSecret,
  randomHex,
  unpackEnvelope,
} from "../lab/ui/e2e.js";

const SUB = "ay-signal-1";
// MAX_CHUNK is imported from e2e.js; ICE is replaced by STUN + getIceServers (TURN) below.
const DEFAULT_SIGHOST = "s.agent-yes.com";
const HOST_HEARTBEAT_MS = 20000; // keepalive ping to the rendezvous + silent-drop detection
// Proactively recycle the signaling connection on this interval. The 20s ping is
// answered at the Cloudflare edge (setWebSocketAutoResponse, see cf/worker.ts) so
// it can't wake a hibernated DO — but that also means an auto-answered ping only
// proves the *edge socket* is alive, NOT that the DO still routes peer-joins to
// us. A DO that hibernated/evicted can leave us a "zombie" host: socket
// ESTABLISHED, pings auto-ponged, yet new browsers can't reach us and the
// heartbeat never trips. Re-running the hello on a timer forces the DO to
// re-register us, self-healing that state. Cheap: one reconnect per few minutes.
const SIG_REFRESH_MS = 4 * 60_000;
// If building a peer connection fails this many times in a row, the native
// WebRTC stack (node-datachannel) is wedged — observed after long daemon uptime:
// signaling stays connected and peer-joins arrive, but every createOffer fails,
// so the host silently answers nobody and the room looks "offline". Reconnecting
// the socket can't clear it; only a fresh process can. Exit so the service
// manager restarts us with a clean stack (a fresh process provably works).
const MAX_PEER_SETUP_FAILURES = 3;

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
  /** When set, a persisted/auto-minted room may auto-rotate: if the signaling
   *  server rejects the room (close 1008 — pinned to a different protocol
   *  generation/token), startShare mints a fresh room, persists it, and calls
   *  this so the caller can refresh its stored link. Leave unset for explicit
   *  webrtc:// URLs, which must NOT be silently rotated. */
  onRotate?: (info: { room: string; link: string }) => void | Promise<void>;
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
    if (url.startsWith("webrtc://")) {
      // A v2 (encrypted) room carries the e1. marker on its secret — reuse it.
      // A legacy markerless room is rotated to a fresh encrypted room below: the
      // signaling DO has pinned the old room to its plaintext token, so we must
      // mint a NEW room name. This is a one-time, deliberate security upgrade —
      // old share links stop working; re-open the new printed link.
      if (parseShareUrl(url).token.startsWith(MARKER)) return url;
    }
  } catch {
    /* not yet minted */
  }
  const room = "r" + randomBytes(3).toString("hex");
  const s = randomBytes(32).toString("hex");
  const url = `webrtc://${room}:${MARKER}${s}@${sighost}`;
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

// Resolve node-datachannel's package dir — where its loader expects the native
// addon at build/Release/node_datachannel.node. null if it can't be resolved.
async function ndPackageDir(): Promise<string | null> {
  try {
    const path = (await import("path")).default;
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("node-datachannel/package.json"));
  } catch {
    return null;
  }
}

// `bunx agent-yes` / `bun add -g agent-yes` skip node-datachannel's install
// script (bun only honors trustedDependencies from the *root* package, and there
// agent-yes is a dependency), so the prebuilt .node is never downloaded. Fetch it
// with the prebuild-install CLI from node-datachannel's own dependency tree — the
// exact `prebuild-install -r napi` its install script would have run. Must run
// BEFORE the first import: Bun caches a failed dynamic import, so downloading
// after a miss wouldn't take effect until the process restarts.
async function ensureAddon(ndDir: string): Promise<void> {
  const { existsSync } = await import("fs");
  const path = (await import("path")).default;
  if (existsSync(path.join(ndDir, "build", "Release", "node_datachannel.node"))) return;
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const binJs = require.resolve("prebuild-install/bin.js", { paths: [ndDir] });
    const { spawnSync } = await import("child_process");
    process.stderr.write("fetching node-datachannel prebuilt binary (one-time)…\n");
    // process.execPath is bun (or node) — both execute the prebuild-install CLI.
    spawnSync(process.execPath, [binJs, "-r", "napi"], { cwd: ndDir, stdio: "ignore" });
  } catch {
    /* best effort — the import below surfaces a clear error if it's still missing */
  }
}

async function importRTC(): Promise<any> {
  // Ensure the native addon is on disk before the first import — a failed
  // dynamic import is cached by Bun, so post-import healing can't recover it.
  const ndDir = await ndPackageDir();
  if (ndDir) await ensureAddon(ndDir);
  try {
    return (await import("node-datachannel/polyfill")).RTCPeerConnection;
  } catch (firstErr) {
    // Fallback for linked/global installs: the binary lives in the resolved pkg
    // but Bun's cache copy lacks it — symlink it across, then retry once.
    await linkFromBunCache().catch(() => {});
    try {
      return (await import("node-datachannel/polyfill")).RTCPeerConnection;
    } catch {
      throw firstErr;
    }
  }
}

/** Start the share bridge. Resolves once signaling is connected; runs until the
 *  process exits, reconnecting signaling on drop. Returns the shareable link. */
export async function startShare(
  opts: ShareOpts,
): Promise<{ room: string; link: string; close: () => void }> {
  const minted = !opts.url;
  const sighost = opts.sighost ?? DEFAULT_SIGHOST;
  const initial = opts.url
    ? parseShareUrl(opts.url)
    : {
        room: "r" + randomBytes(3).toString("hex"),
        token: `${MARKER}${randomBytes(32).toString("hex")}`,
        host: sighost,
      };
  const host = initial.host;
  // Mutable: auto-rotation (below) re-mints room/token/S/authToken/link in place
  // when the signaling server rejects the room as pinned to another generation.
  let room = initial.room;
  let token = initial.token;

  // E2E: the URL secret S splits into authToken (the only value the server sees,
  // for room matching) and per-connection AES keys the server never sees. We
  // refuse to host a legacy plaintext room — old rooms are auto-rotated to v2 by
  // loadOrCreateShareRoom (delete ~/.agent-yes/.share-room to force a rotation).
  const { s: firstS, v2 } = parseSecret(token);
  if (!v2) {
    throw new Error(
      "refusing to host an unencrypted room — delete ~/.agent-yes/.share-room to rotate to an encrypted link",
    );
  }
  let S = firstS;

  const wsScheme = host.startsWith("localhost") || host.startsWith("127.") ? "ws" : "wss";
  const ui = host === "s.agent-yes.com" ? "https://agent-yes.com" : "http://localhost:7778";
  const suffix = host === "s.agent-yes.com" ? "" : "@" + host;
  const mkLink = () => `${ui}/#${room}:${MARKER}${S}${suffix}`;
  let authToken = await deriveAuthToken(S, room, host);
  let link = mkLink();

  const RTCPeerConnection = await importRTC();

  // Auto-rotate a rejected persisted room to a fresh one. A signaling 1008 means
  // the room is pinned to a different generation/token (e.g. a pre-E2E room), so
  // re-using it can never succeed; mint+persist a new room and let the caller
  // refresh its stored link. Gated on opts.onRotate (only the persisted-room
  // caller sets it) and a small cap so a persistent reject can't spin forever.
  let rotateCount = 0;
  const rotate = async (): Promise<boolean> => {
    if (!opts.onRotate || closed || rotateCount >= 5) return false;
    rotateCount++;
    room = "r" + randomBytes(3).toString("hex");
    token = `${MARKER}${randomBytes(32).toString("hex")}`;
    S = parseSecret(token).s;
    authToken = await deriveAuthToken(S, room, host);
    link = mkLink();
    // close() may have run during the await above — don't persist/announce or let
    // the caller reconnect a room for a share that's shutting down.
    if (closed) return false;
    try {
      await mkdir(path.dirname(shareRoomPath()), { recursive: true });
      await writeFile(shareRoomPath(), `webrtc://${room}:${token}@${host}`, { mode: 0o600 });
    } catch {
      /* best effort — in-memory rotation still lets new browsers join */
    }
    await opts.onRotate({ room, link });
    return true;
  };

  type Peer = {
    pc: any;
    aborts: Map<string, AbortController>;
    send: { sendCtr: bigint };
    recv: { lastSeen: bigint };
    th?: Uint8Array;
    keyH2C?: CryptoKey; // host encrypts with H2C, decrypts with C2H
    keyC2H?: CryptoKey;
    keysReady: Promise<void>;
    resolveKeys: () => void;
    myNonce: string;
    confirmedIn: boolean; // peer echoed our nonce
    confirmedOut: boolean; // we echoed peer's nonce
    confirmed: boolean;
    confirmTimer?: ReturnType<typeof setTimeout>;
    recvChain: Promise<void>; // serialize decrypts so the replay counter stays ordered
    sendChain: Promise<void>; // serialize seals so wire order == counter order
  };
  const peers = new Map<string, Peer>();
  let closed = false; // set by close(); stops signaling reconnect + new peers
  let currentWs: WebSocket | undefined; // the live rendezvous socket, for close()
  let peerSetupFailures = 0; // consecutive startPeer() throws — see MAX_PEER_SETUP_FAILURES

  const connectSignaling = (onReady: () => void) => {
    if (closed) return; // a reconnect timer queued before close() must not revive it
    const ws = new WebSocket(`${wsScheme}://${host}/${room}`, [SUB]);
    currentWs = ws;
    let ready = false;
    let lastRecv = Date.now();
    let hb: ReturnType<typeof setInterval> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const stopHb = () => {
      if (hb) {
        clearInterval(hb);
        hb = undefined;
      }
      if (refresh) {
        clearTimeout(refresh);
        refresh = undefined;
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", role: "host", v: 2, token: authToken }));
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
      // Proactive re-registration (see SIG_REFRESH_MS): the edge-answered ping
      // above can't detect a DO that hibernated/evicted our routing while the
      // socket stays up, so periodically recycle the connection to force a fresh
      // hello. onclose then reconnects (~1s), re-registering us as host.
      refresh = setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, SIG_REFRESH_MS);
      onReady();
    };
    ws.onmessage = async (ev) => {
      if (closed) return;
      lastRecv = Date.now();
      const m = JSON.parse(ev.data as string);
      if (m.type === "pong") return; // heartbeat ack — liveness already recorded
      if (m.type === "peer-join")
        startPeer(ws, m.peer).then(
          () => {
            peerSetupFailures = 0; // a delivered offer proves the WebRTC stack works
          },
          (err) => {
            // Don't swallow this: a failed createOffer is why a long-up host goes
            // silently "offline". Surface it, and if it keeps failing, self-heal.
            peerSetupFailures++;
            process.stderr.write(
              `[share] peer setup failed (${peerSetupFailures}/${MAX_PEER_SETUP_FAILURES}): ${(err as Error)?.message ?? err}\n`,
            );
            closePeer(m.peer);
            if (peerSetupFailures >= MAX_PEER_SETUP_FAILURES) {
              process.stderr.write(
                "[share] WebRTC stack wedged after repeated peer-setup failures — exiting so the service manager restarts with a fresh stack\n",
              );
              process.exit(1);
            }
          },
        );
      else if (m.type === "answer") {
        const peer = peers.get(m.from);
        if (!peer) return;
        try {
          await peer.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
          // Derive per-connection keys the moment both descriptions are stable —
          // before the DataChannel can open and deliver a frame. Host's offer is
          // local, the browser's answer is remote.
          peer.th = await computeTranscriptHash(
            peer.pc.localDescription.sdp,
            peer.pc.remoteDescription.sdp,
          );
          const { keyH2C, keyC2H } = await deriveDirKeys(S, peer.th);
          peer.keyH2C = keyH2C;
          peer.keyC2H = keyC2H;
          peer.resolveKeys();
        } catch {
          closePeer(m.from);
        }
      } else if (m.type === "candidate")
        await peers
          .get(m.from)
          ?.pc.addIceCandidate(m.candidate)
          .catch(() => {});
      else if (m.type === "peer-leave") closePeer(m.peer);
    };
    ws.onclose = (ev: any) => {
      stopHb();
      if (closed) return; // shutting down — don't resurrect the rendezvous
      // The signaling server pins a room to its first host's authToken+protocol.
      // A 1008 means a different generation already owns this room, so reusing it
      // can never succeed. For a persisted/auto-minted room, rotate to a fresh one
      // and reconnect; otherwise (explicit URL) give up with a secret-free hint.
      if (ev?.code === 1008) {
        rotate()
          .then((rotated) => {
            if (rotated) {
              connectSignaling(() => {});
            } else {
              closed = true;
              process.stderr.write(
                "[share] room rejected by signaling server — delete ~/.agent-yes/.share-room to rotate the room\n",
              );
            }
          })
          .catch(() => {
            closed = true;
            process.stderr.write(
              "[share] room rejected and rotation failed — delete ~/.agent-yes/.share-room to rotate manually\n",
            );
          });
        return;
      }
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
    let resolveKeys!: () => void;
    const keysReady = new Promise<void>((r) => (resolveKeys = r));
    const peer: Peer = {
      pc,
      aborts: new Map<string, AbortController>(),
      send: { sendCtr: 0n },
      recv: { lastSeen: -1n },
      keysReady,
      resolveKeys,
      myNonce: randomHex(16),
      confirmedIn: false,
      confirmedOut: false,
      confirmed: false,
      recvChain: Promise.resolve(),
      sendChain: Promise.resolve(),
    };
    peers.set(peerId, peer);
    pc.onicecandidate = (e: any) => {
      if (e.candidate)
        ws.send(JSON.stringify({ type: "candidate", to: peerId, candidate: e.candidate }));
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) closePeer(peerId);
    };
    const dc = pc.createDataChannel("api");
    dc.binaryType = "arraybuffer";
    dc.onopen = async () => {
      try {
        await peer.keysReady; // keys derived in the answer handler
        // Open the mandatory bidirectional key-confirmation handshake. Nothing
        // the peer sends is acted on until BOTH directions confirm (see onFrame).
        enqueueSeal(peerId, dc, peer, FLAG_CONFIRM, { t: "confirm", nonce: peer.myNonce });
        peer.confirmTimer = setTimeout(() => {
          if (!peer.confirmed) closePeer(peerId);
        }, CONFIRM_TIMEOUT_MS);
      } catch {
        closePeer(peerId);
      }
    };
    // Serialize decrypts: WebCrypto open() is async, and a reliable+ordered
    // channel must be processed in order or the monotonic replay check would
    // spuriously reject a reordered await.
    dc.onmessage = (e: any) => {
      peer.recvChain = peer.recvChain.then(() => onFrame(peerId, dc, peer, e.data)).catch(() => {});
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // The signaling socket may have been recycled (SIG_REFRESH_MS) while we built
    // the offer. Sending on a closing socket would throw and be miscounted as a
    // wedged-stack failure — but it's benign: the browser re-joins on the fresh
    // socket. Skip cleanly so only real createOffer failures trip the self-heal.
    if (ws.readyState !== WebSocket.OPEN) {
      closePeer(peerId);
      return;
    }
    // Hand the browser the same ICE servers (incl. the short-lived TURN creds)
    // so it can relay too when there's no direct path.
    ws.send(
      JSON.stringify({ type: "offer", to: peerId, sdp: pc.localDescription.sdp, iceServers }),
    );
  }

  function closePeer(peerId: string) {
    const p = peers.get(peerId);
    if (!p) return;
    if (p.confirmTimer) clearTimeout(p.confirmTimer);
    for (const a of p.aborts.values()) a.abort();
    try {
      p.pc.close();
    } catch {
      /* already closed */
    }
    peers.delete(peerId);
  }

  // Seal an envelope and send it, serialized per peer so the wire order matches
  // the nonce-counter order (so the receiver's monotonic check never trips).
  function enqueueSeal(peerId: string, dc: any, peer: Peer, flags: number, obj: object) {
    peer.sendChain = peer.sendChain.then(async () => {
      if (dc.readyState !== "open" || !peer.keyH2C || !peer.th) return;
      let frame: ArrayBuffer;
      try {
        frame = await e2eSeal(peer.keyH2C, peer.send, flags, peer.th, packEnvelope(obj));
      } catch {
        closePeer(peerId); // counter overflow — fail closed
        return;
      }
      try {
        dc.send(frame);
      } catch {
        /* peer vanished mid-send; dropping the frame is correct */
      }
    });
    return peer.sendChain;
  }

  // Decrypt + route one inbound frame. Fail-closed: any decryption failure,
  // replay, pre-confirmation app frame, or string frame closes the peer.
  async function onFrame(peerId: string, dc: any, peer: Peer, data: any) {
    if (!peers.has(peerId)) return;
    if (typeof data === "string" || !peer.keyC2H || !peer.th) return closePeer(peerId);
    let env: any;
    try {
      const { plaintext } = await e2eOpen(peer.keyC2H, data, peer.th, peer.recv);
      env = unpackEnvelope(plaintext);
    } catch {
      return closePeer(peerId); // bad version/epoch/tag/AAD or replay
    }
    if (!peer.confirmed) {
      if (!env || env.t !== "confirm") return closePeer(peerId);
      if (typeof env.nonce === "string" && !peer.confirmedOut) {
        // Flush our echo before marking confirmed-out (so no app frame is acted on
        // until the peer can also complete its side).
        await enqueueSeal(peerId, dc, peer, FLAG_CONFIRM, {
          t: "confirm",
          nonce: peer.myNonce,
          echo: env.nonce,
        });
        peer.confirmedOut = true;
      }
      if (env.echo && env.echo === peer.myNonce) peer.confirmedIn = true;
      if (peer.confirmedIn && peer.confirmedOut) {
        peer.confirmed = true;
        if (peer.confirmTimer) clearTimeout(peer.confirmTimer);
      }
      return;
    }
    if (!env || env.t === "confirm") return; // stray confirm after handshake — ignore
    onReq(peerId, dc, peer, env);
  }

  async function onReq(peerId: string, dc: any, peer: Peer, req: any) {
    if (req.t === "abort") {
      peer.aborts.get(req.id)?.abort();
      peer.aborts.delete(req.id);
      return;
    }
    if (req.t !== "req") return;
    const { id, method, path: p, body } = req;
    const ac = new AbortController();
    peer.aborts.set(id, ac);
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
      enqueueSeal(peerId, dc, peer, 0, {
        t: "res",
        id,
        status: res.status,
        ct: res.headers.get("content-type") ?? "",
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let seq = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        // Slice on UTF-16 boundaries: JSON round-trips lone surrogates as \uXXXX,
        // so the receiver reassembles the exact text by concatenating in seq order.
        for (let i = 0; i < text.length; i += MAX_CHUNK)
          enqueueSeal(peerId, dc, peer, 0, {
            t: "data",
            id,
            seq: seq++,
            chunk: text.slice(i, i + MAX_CHUNK),
          });
      }
      enqueueSeal(peerId, dc, peer, 0, { t: "end", id, seq });
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        enqueueSeal(peerId, dc, peer, 0, {
          t: "end",
          id,
          error: String((e as Error).message ?? e),
        });
    } finally {
      peer.aborts.delete(id);
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
