#!/usr/bin/env bun
// Host side of `ay serve --share=webrtc://room:token@s.agent-yes.com`.
//
// Connects to the signaling server as the room "host", and for every browser
// peer that joins, opens a WebRTC DataChannel and bridges it to the LOCAL
// `ay serve` HTTP API (ls / read / tail-SSE / send). The browser thus talks to
// the local agent over a peer-to-peer DataChannel — no public port, no tunnel.
//
// Wire protocol over the DataChannel (JSON strings, one message per line of work):
//   browser → host : {t:"req",   id, method, path, body?}   // an /api/* call
//                    {t:"abort", id}                         // cancel a stream
//   host → browser : {t:"res",   id, status, ct}            // response head
//                    {t:"data",  id, chunk}                  // a body/SSE chunk
//                    {t:"end",   id, error?}                 // response complete
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const SUB = "ay-signal-1";
const MAX_CHUNK = 15_000; // DataChannel messages must stay well under the SCTP limit

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

// `--new [sighost]` mints a fresh room + 64-char token and prints a share link;
// otherwise pass a full webrtc://room:token@host url.
const arg = process.argv[2] ?? process.env.AY_SHARE;
let room: string, token: string, host: string;
if (!arg) {
  console.error("usage: bun share-host.ts --new [sighost]   |   webrtc://room:token@host");
  process.exit(1);
} else if (arg === "--new") {
  host = process.argv[3] ?? process.env.AY_SIGHOST ?? "s.agent-yes.com";
  room = "r" + randomBytes(3).toString("hex"); // short, non-secret mnemonic
  token = randomBytes(32).toString("hex"); // 64 hex chars — unscreenshotable in the omnibox
  const ui = host === "s.agent-yes.com" ? "https://agent-yes.com" : "http://localhost:7778";
  const suffix = host === "s.agent-yes.com" ? "" : "@" + host;
  console.log(`\n  share this link (the token is eaten from the URL on open):`);
  console.log(`  ${ui}/#${room}:${token}${suffix}\n`);
} else {
  ({ room, token, host } = parseShare(arg));
}
const API = process.env.AY_API ?? "http://127.0.0.1:7432";
const API_TOKEN = localToken();
const wsScheme = host.startsWith("localhost") || host.startsWith("127.") ? "ws" : "wss";

const peers = new Map<string, { pc: RTCPeerConnection; aborts: Map<number, AbortController> }>();

const ws = new WebSocket(`${wsScheme}://${host}/${room}`, [SUB]);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "host", token })); // token in first msg, not URL/subprotocol
  console.log(`[share] host online · room=${room} · bridging ${API}`);
};
ws.onclose = (e) => console.log(`[share] signaling closed (${e.code})`);
ws.onerror = () => console.log(`[share] signaling error`);
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.type === "peer-join") startPeer(m.peer);
  else if (m.type === "answer")
    await peers.get(m.from)?.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
  else if (m.type === "candidate")
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
  const aborts = new Map<number, AbortController>();
  peers.set(peerId, { pc, aborts });

  pc.onicecandidate = (e) => {
    if (e.candidate) sig(peerId, { type: "candidate", candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) closePeer(peerId);
  };

  const dc = pc.createDataChannel("api");
  dc.onopen = () => console.log(`[share] datachannel open · ${peerId}`);
  dc.onmessage = (e) => onReq(dc, aborts, JSON.parse(e.data as string));

  pc.createOffer()
    .then((o) => pc.setLocalDescription(o))
    .then(() => sig(peerId, { type: "offer", sdp: pc.localDescription!.sdp }));
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
  console.log(`[share] peer ${peerId} gone`);
}

function send(dc: any, obj: object) {
  if (dc.readyState === "open") dc.send(JSON.stringify(obj));
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
    const res = await fetch(API + p, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ?? undefined,
      signal: ac.signal,
    });
    send(dc, { t: "res", id, status: res.status, ct: res.headers.get("content-type") ?? "" });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      for (let i = 0; i < text.length; i += MAX_CHUNK) {
        send(dc, { t: "data", id, chunk: text.slice(i, i + MAX_CHUNK) });
      }
    }
    send(dc, { t: "end", id });
  } catch (e) {
    if ((e as Error).name !== "AbortError") send(dc, { t: "end", id, error: String(e) });
  } finally {
    aborts.delete(id);
  }
}
