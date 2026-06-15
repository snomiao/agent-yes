#!/usr/bin/env bun
// Host side of `ay serve --share=webrtc://room:token@s.agent-yes.com`.
//
// Connects to the signaling server as the room "host", and for every browser
// peer that joins, opens a WebRTC DataChannel and bridges it to the LOCAL
// `ay serve` HTTP API (ls / read / tail-SSE / send). The browser thus talks to
// the local agent over a peer-to-peer DataChannel — no public port, no tunnel.
//
// This is the dev/prototype host; the production host is ts/share.ts. Both run
// the SAME end-to-end-encryption protocol via the shared lab/ui/e2e.js module,
// so neither can ever bridge a plaintext channel for a v2 room. See that file
// and agent-yes.com/blog/e2ee-share-links for the design.
//
// Wire protocol: every DataChannel frame is an AES-256-GCM-sealed envelope
// (lab/ui/e2e.js). Envelope shapes, once decrypted:
//   browser → host : {t:"req", id, method, path, body?} | {t:"abort", id}
//                    {t:"confirm", nonce, echo?}
//   host → browser : {t:"res", id, status, ct} | {t:"data", id, seq, chunk}
//                    {t:"end", id, seq, error?} | {t:"confirm", nonce, echo?}
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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
} from "./e2e.js";

const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const SUB = "ay-signal-1";

// webrtc://room:token@host  →  { room, token, host }
function parseShare(s: string) {
  const m = /^webrtc:\/\/([^:@/]+):([^@/]+)@(.+)$/.exec(s);
  if (!m) throw new Error(`bad --share url: ${s} (want webrtc://room:token@host)`);
  return { room: m[1]!, token: m[2]!, host: m[3]! };
}

function localToken(): string {
  if (process.env.AY_TOKEN) return process.env.AY_TOKEN;
  return readFileSync(path.join(homedir(), ".agent-yes", ".serve-token"), "utf-8").trim();
}

// `--new [sighost]` mints a fresh encrypted room + prints a share link; otherwise
// pass a full webrtc://room:token@host url.
const arg = process.argv[2] ?? process.env.AY_SHARE;
let room: string, token: string, host: string;
if (!arg) {
  console.error("usage: bun share-host.ts --new [sighost]   |   webrtc://room:token@host");
  process.exit(1);
} else if (arg === "--new") {
  host = process.argv[3] ?? process.env.AY_SIGHOST ?? "s.agent-yes.com";
  room = "r" + randomBytes(3).toString("hex"); // short, non-secret mnemonic
  token = `${MARKER}${randomBytes(32).toString("hex")}`; // e1.<64hex> encrypted-link secret
  const ui = host === "s.agent-yes.com" ? "https://agent-yes.com" : "http://localhost:7778";
  const suffix = host === "s.agent-yes.com" ? "" : "@" + host;
  // The link embeds the room secret — only print it to a real terminal, never to
  // a redirected/log stream.
  if (process.stdout.isTTY) {
    console.log(`\n  share this link (the token is eaten from the URL on open):`);
    console.log(`  ${ui}/#${room}:${token}${suffix}\n`);
  } else {
    console.log(
      `[share] room=${room} — run in a TTY to print the share link (it carries a secret)`,
    );
  }
} else {
  ({ room, token, host } = parseShare(arg));
}

// E2E: split the URL secret into the server-visible authToken and the AES keys
// the server never sees. Refuse to host an unencrypted (legacy) room.
const { s: S, v2 } = parseSecret(token);
if (!v2) {
  console.error("[share] refusing to host an unencrypted room — mint a new link with --new");
  process.exit(1);
}
const authToken = await deriveAuthToken(S, room, host);

const API = process.env.AY_API ?? "http://127.0.0.1:7432";
const API_TOKEN = localToken();
const wsScheme = host.startsWith("localhost") || host.startsWith("127.") ? "ws" : "wss";

type Peer = {
  pc: RTCPeerConnection;
  aborts: Map<string, AbortController>;
  send: { sendCtr: bigint };
  recv: { lastSeen: bigint };
  th?: Uint8Array;
  keyH2C?: CryptoKey;
  keyC2H?: CryptoKey;
  keysReady: Promise<void>;
  resolveKeys: () => void;
  myNonce: string;
  confirmedIn: boolean;
  confirmedOut: boolean;
  confirmed: boolean;
  confirmTimer?: ReturnType<typeof setTimeout>;
  recvChain: Promise<void>;
  sendChain: Promise<void>;
};
const peers = new Map<string, Peer>();

const ws = new WebSocket(`${wsScheme}://${host}/${room}`, [SUB]);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "host", v: 2, token: authToken })); // authToken, never S
  console.log(`[share] host online · room=${room} · bridging ${API}`);
};
ws.onclose = (e) => {
  if (e.code === 1008)
    console.log(
      `[share] room rejected (1008) — mint a new link with --new (token/version mismatch)`,
    );
  else console.log(`[share] signaling closed (${e.code})`);
};
ws.onerror = () => console.log(`[share] signaling error`);
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.type === "peer-join") startPeer(m.peer);
  else if (m.type === "answer") {
    const peer = peers.get(m.from);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      peer.th = await computeTranscriptHash(
        peer.pc.localDescription!.sdp,
        peer.pc.remoteDescription!.sdp,
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

function sig(to: string, obj: object) {
  ws.send(JSON.stringify({ ...obj, to }));
}

function startPeer(peerId: string) {
  console.log(`[share] peer ${peerId} joined`);
  const pc = new RTCPeerConnection({ iceServers: ICE });
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

  pc.onicecandidate = (e) => {
    if (e.candidate) sig(peerId, { type: "candidate", candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) closePeer(peerId);
  };

  const dc = pc.createDataChannel("api");
  dc.binaryType = "arraybuffer";
  dc.onopen = async () => {
    try {
      await peer.keysReady;
      console.log(`[share] datachannel open · ${peerId}`);
      enqueueSeal(peerId, dc, peer, FLAG_CONFIRM, { t: "confirm", nonce: peer.myNonce });
      peer.confirmTimer = setTimeout(() => {
        if (!peer.confirmed) closePeer(peerId);
      }, CONFIRM_TIMEOUT_MS);
    } catch {
      closePeer(peerId);
    }
  };
  dc.onmessage = (e) => {
    peer.recvChain = peer.recvChain.then(() => onFrame(peerId, dc, peer, e.data)).catch(() => {});
  };

  pc.createOffer()
    .then((o) => pc.setLocalDescription(o))
    .then(() => sig(peerId, { type: "offer", sdp: pc.localDescription!.sdp }));
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
  console.log(`[share] peer ${peerId} gone`);
}

function enqueueSeal(peerId: string, dc: any, peer: Peer, flags: number, obj: object) {
  peer.sendChain = peer.sendChain.then(async () => {
    if (dc.readyState !== "open" || !peer.keyH2C || !peer.th) return;
    let frame: ArrayBuffer;
    try {
      frame = await e2eSeal(peer.keyH2C, peer.send, flags, peer.th, packEnvelope(obj));
    } catch {
      closePeer(peerId);
      return;
    }
    try {
      dc.send(frame);
    } catch {
      /* peer vanished mid-send */
    }
  });
  return peer.sendChain;
}

async function onFrame(peerId: string, dc: any, peer: Peer, data: any) {
  if (!peers.has(peerId)) return;
  if (typeof data === "string" || !peer.keyC2H || !peer.th) return closePeer(peerId);
  let env: any;
  try {
    const { plaintext } = await e2eOpen(peer.keyC2H, data, peer.th, peer.recv);
    env = unpackEnvelope(plaintext);
  } catch {
    return closePeer(peerId);
  }
  if (!peer.confirmed) {
    if (!env || env.t !== "confirm") return closePeer(peerId);
    if (typeof env.nonce === "string" && !peer.confirmedOut) {
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
  if (!env || env.t === "confirm") return;
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
    const res = await fetch(API + p, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ?? undefined,
      signal: ac.signal,
    });
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
      enqueueSeal(peerId, dc, peer, 0, { t: "end", id, error: String((e as Error).message ?? e) });
  } finally {
    peer.aborts.delete(id);
  }
}
