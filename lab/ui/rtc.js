// agent-yes · shared WebRTC remote-room transport.
//
// One source of truth for the "ay-share" (rtc) wire used by BOTH the console
// (lab/ui/index.html) and the /r/ rgui viewer (lab/ui/rgui/main.ts). A remote
// room is an /api/* call tunnelled over a WebRTC DataChannel to a peer running
// `ay serve --share`, established through the signaling server. Same call
// sites, two wires — remote is selected by a URL hash: #room:token[@sighost]
// (or the webrtc://room:token@host share-link form).
//
// The envelope mirrors lab/ui/share-host.ts: {t:"req"|"abort"} out,
// {t:"res"|"data"|"end"} in. The e2e handshake (import "./e2e.js") is
// security-critical and byte-identical to the console's original inline copy.

import {
  ALLOW_LEGACY_PLAINTEXT,
  FLAG_CONFIRM,
  CONFIRM_TIMEOUT_MS,
  deriveAuthToken,
  deriveDirKeys,
  computeTranscriptHash,
  seal as e2eSeal,
  open as e2eOpen,
  packEnvelope,
  unpackEnvelope,
  parseSecret,
  randomHex,
} from "./e2e.js";

const SIG_DEFAULT = "s.agent-yes.com"; // signaling host (override in the hash with @host)
const SUB = "ay-signal-1";
export { SIG_DEFAULT };

const PERF_KEY = "ay.perf";
// Force-log ("this was slow") threshold. 750ms hid everything a LAN user
// would call slow — on a local network a 300ms round-trip is already an
// incident. Overridable per browser: localStorage["ay.perfSlowMs"] = "150"
// for strict LAN monitoring, or a bigger number on a high-latency link.
const PERF_SLOW_MS = (() => {
  try {
    const v = Number(localStorage.getItem("ay.perfSlowMs"));
    return Number.isFinite(v) && v > 0 ? v : 300;
  } catch {
    return 300;
  }
})();
const perfNow = () => Math.round(performance.now());
function perfEnabled() {
  try {
    return localStorage.getItem(PERF_KEY) === "1" || location.search.includes("ay_perf=1");
  } catch {
    return false;
  }
}
function perfLog(scope, event, data = {}, force = false) {
  const rec = { t: Date.now(), p: perfNow(), scope, event, ...data };
  const w = globalThis;
  const buf = (w.__ayPerf = Array.isArray(w.__ayPerf) ? w.__ayPerf : []);
  if (!w.__ayPerfReport)
    w.__ayPerfReport = () => {
      const rows = Array.isArray(w.__ayPerf) ? w.__ayPerf : [];
      const byEvent = {};
      for (const r of rows) {
        const k = `${r.scope}:${r.event}`;
        const b = (byEvent[k] ||= { count: 0, maxMs: 0, lastMs: 0, _ms: [] });
        b.count++;
        if (typeof r.ms === "number") {
          b.lastMs = r.ms;
          b.maxMs = Math.max(b.maxMs, r.ms);
          b._ms.push(r.ms);
        }
      }
      // Percentiles beat max/last for "is this link actually slow": the ring
      // buffer already holds every request, so slowness analysis shouldn't
      // depend on what crossed the console-print threshold.
      for (const b of Object.values(byEvent)) {
        const ms = b._ms.sort((a, z) => a - z);
        delete b._ms;
        if (ms.length) {
          b.p50 = ms[Math.floor((ms.length - 1) * 0.5)];
          b.p95 = ms[Math.floor((ms.length - 1) * 0.95)];
        }
      }
      return { count: rows.length, slowMs: PERF_SLOW_MS, byEvent, last: rows.slice(-40) };
    };
  if (!w.__ayPerfClear) w.__ayPerfClear = () => (w.__ayPerf = []);
  buf.push(rec);
  if (buf.length > 500) buf.splice(0, buf.length - 500);
  if (force || perfEnabled()) console.info("[ay-perf]", rec);
}
function maybeSlow(scope, event, startedAt, data = {}) {
  const ms = Math.round(performance.now() - startedAt);
  if (ms >= PERF_SLOW_MS) perfLog(scope, event, { ms, ...data }, true);
  else perfLog(scope, event, { ms, ...data });
}

// Tunnels request/response + streaming over one DataChannel. Mirrors the
// envelope in lab/ui/share-host.ts: {t:"req"|"abort"} out, {t:"res"|"data"|"end"} in.
export class RTCClient {
  constructor(host, room, token) {
    let resolveKeys;
    const keysReady = new Promise((r) => (resolveKeys = r));
    Object.assign(this, {
      host,
      room,
      token,
      dc: null,
      calls: new Map(),
      streams: new Map(),
      onstate: () => {},
      // e2e (v2) per-connection state
      _s: null,
      _v2: false,
      _send: { sendCtr: 0n },
      _recvState: { lastSeen: -1n },
      _tHash: null,
      _keyH2C: null, // host->client: client decrypts with this
      _keyC2H: null, // client->host: client encrypts with this
      _keysReady: keysReady,
      _resolveKeys: resolveKeys,
      _myNonce: randomHex(16),
      _confirmedIn: false,
      _confirmedOut: false,
      _confirmed: false,
      _confirmTimer: null,
      _recvChain: Promise.resolve(), // serialize decrypts (ordered replay check)
      _sendChain: Promise.resolve(), // serialize seals (wire order == counter order)
    });
  }
  async connect() {
    const connectStartedAt = performance.now();
    const mark = (event, data = {}) =>
      perfLog("rtc", event, { room: this.room, host: this.host, ...data });
    // Parse the secret marker (fail-closed on malformed) and split into the
    // server-visible authToken vs the end-to-end keys the server never sees.
    const { s, v2 } = parseSecret(this.token);
    this._s = s;
    this._v2 = v2;
    if (!v2 && !ALLOW_LEGACY_PLAINTEXT)
      throw new Error("this link uses the old unencrypted protocol — ask the host to upgrade");
    const authToken = v2 ? await deriveAuthToken(s, this.room, this.host) : this.token;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${this.host}/${this.room}`, [SUB]);
      this.ws = ws; // kept so close() can drop the signaling registration too
      mark("connect.start");
      let pc,
        settled = false;
      const fail = (e) => {
        if (!settled) {
          settled = true;
          maybeSlow("rtc", "connect.fail", connectStartedAt, {
            room: this.room,
            host: this.host,
            error: String(e?.message ?? e),
          });
          reject(e);
        }
      };
      // Resolve ONLY after the mutual key-confirmation completes (see _dcRecv),
      // never on bare dc.onopen — there must be no "connected but unverified" window.
      const done = () => {
        if (!settled) {
          settled = true;
          maybeSlow("rtc", "connect.open", connectStartedAt, {
            room: this.room,
            host: this.host,
            state: this.pc?.connectionState,
          });
          this.onstate("open");
          resolve();
        }
      };
      ws.onopen = () => (
        mark("signal.open"),
        ws.send(JSON.stringify({ type: "hello", role: "client", v: 2, token: authToken }))
      );
      ws.onmessage = async (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "welcome") {
          mark("signal.welcome", { v: m.v });
          if (this._v2 && m.v !== 2)
            return fail(new Error("host is running an old agent-yes — ask it to upgrade"));
          // pc is created on the offer below so it can use the host-supplied
          // iceServers (incl. short-lived TURN creds for relaying behind NAT).
        } else if (m.type === "offer") {
          mark("signal.offer", {
            iceServers: Array.isArray(m.iceServers) ? m.iceServers.length : 0,
          });
          if (!pc) {
            pc = new RTCPeerConnection({
              iceServers:
                m.iceServers && m.iceServers.length
                  ? m.iceServers
                  : [{ urls: "stun:stun.l.google.com:19302" }],
            });
            this.pc = pc;
            pc.onicecandidate = (e) => {
              if (e.candidate)
                ws.send(JSON.stringify({ type: "candidate", candidate: e.candidate }));
            };
            pc.onconnectionstatechange = () => {
              mark("pc.state", { state: pc.connectionState });
              this.onstate(pc.connectionState);
            };
            pc.ondatachannel = (e) => {
              this.dc = e.channel;
              this.dc.binaryType = "arraybuffer";
              this.dc.onopen = async () => {
                try {
                  mark("dc.open", { buffered: this.dc.bufferedAmount });
                  await this._keysReady;
                  // Open the bidirectional confirmation handshake.
                  this._dcSend(FLAG_CONFIRM, { t: "confirm", nonce: this._myNonce });
                  this._confirmTimer = setTimeout(() => {
                    if (!this._confirmed) fail(new Error("key confirmation timed out"));
                  }, CONFIRM_TIMEOUT_MS);
                } catch (err) {
                  fail(err);
                }
              };
              this.dc.onmessage = (ev2) => {
                this._recvChain = this._recvChain
                  .then(() => this._dcRecv(ev2.data, done))
                  .catch(() => {});
              };
              this.dc.onclose = () => this.onstate("closed");
            };
          }
          await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
          await pc.setLocalDescription(await pc.createAnswer());
          ws.send(JSON.stringify({ type: "answer", sdp: pc.localDescription.sdp }));
          // Derive per-connection keys now both descriptions are stable, before
          // the DataChannel opens. Client: remote=host offer, local=our answer.
          try {
            this._tHash = await computeTranscriptHash(
              pc.remoteDescription.sdp,
              pc.localDescription.sdp,
            );
            const { keyH2C, keyC2H } = await deriveDirKeys(this._s, this._tHash);
            this._keyH2C = keyH2C;
            this._keyC2H = keyC2H;
            this._resolveKeys();
            mark("keys.ready");
          } catch (err) {
            fail(err);
          }
        } else if (m.type === "candidate") {
          if (pc) await pc.addIceCandidate(m.candidate).catch(() => {});
        }
      };
      ws.onerror = () => fail(new Error("signaling error"));
      ws.onclose = () => fail(new Error("signaling closed"));
      setTimeout(() => fail(new Error("connect timeout")), 8000);
    });
  }
  // Seal an envelope and send it, serialized so wire order == counter order.
  _dcSend(flags, obj) {
    const queuedAt = performance.now();
    this._sendChain = this._sendChain.then(async () => {
      if (!this.dc || this.dc.readyState !== "open" || !this._keyC2H || !this._tHash) return;
      const queuedMs = Math.round(performance.now() - queuedAt);
      let frame;
      try {
        frame = await e2eSeal(this._keyC2H, this._send, flags, this._tHash, packEnvelope(obj));
      } catch {
        this.close();
        return;
      }
      try {
        this.dc.send(frame);
        if (queuedMs >= PERF_SLOW_MS || this.dc.bufferedAmount > 1_000_000)
          perfLog(
            "rtc",
            "send.slow",
            {
              room: this.room,
              kind: obj?.t,
              queuedMs,
              buffered: this.dc.bufferedAmount,
              bytes: frame.byteLength,
            },
            true,
          );
      } catch {}
    });
    return this._sendChain;
  }
  // Decrypt + route one frame. Fail-closed: any failure, replay, string
  // frame, or pre-confirmation app frame closes the connection.
  async _dcRecv(data, done) {
    if (!this.dc) return;
    if (typeof data === "string" || !this._keyH2C || !this._tHash) return this.close();
    let env;
    try {
      const { plaintext } = await e2eOpen(this._keyH2C, data, this._tHash, this._recvState);
      env = unpackEnvelope(plaintext);
    } catch {
      return this.close();
    }
    if (!this._confirmed) {
      if (!env || env.t !== "confirm") return this.close();
      if (typeof env.nonce === "string" && !this._confirmedOut) {
        // Send (and flush) our echo BEFORE marking confirmed-out, so connect()
        // can't resolve and let a req() race ahead of the echo on the wire.
        await this._dcSend(FLAG_CONFIRM, {
          t: "confirm",
          nonce: this._myNonce,
          echo: env.nonce,
        });
        this._confirmedOut = true;
      }
      if (env.echo && env.echo === this._myNonce) this._confirmedIn = true;
      if (this._confirmedIn && this._confirmedOut) {
        this._confirmed = true;
        if (this._confirmTimer) clearTimeout(this._confirmTimer);
        done(); // connect() resolves only now — the channel is mutually verified
      }
      return;
    }
    if (!env || env.t === "confirm") return; // stray confirm after handshake
    this._recv(env);
  }
  _recv(r) {
    // Frames are authenticated + replay-checked before they reach here, so an
    // id we don't know is a late/cancelled response from the legitimate host,
    // not an attack — drop it rather than tear down the channel.
    const call = this.calls.get(r.id),
      stream = this.streams.get(r.id);
    if (r.t === "res") {
      if (call) {
        call.status = r.status;
        call.headAt = performance.now();
        maybeSlow("rtc", "req.head", call.startedAt, {
          room: this.room,
          method: call.method,
          path: call.path,
          status: r.status,
        });
      }
    } else if (r.t === "data") {
      if (call) {
        call.body += r.chunk;
        call.dataCount = (call.dataCount || 0) + 1;
        call.bytes = (call.bytes || 0) + r.chunk.length;
      }
      if (stream) {
        if (!stream.firstAt) {
          stream.firstAt = performance.now();
          maybeSlow("rtc", "stream.first", stream.startedAt, {
            room: this.room,
            path: stream.path,
          });
        }
        stream.chunks++;
        stream.bytes += r.chunk.length;
        stream.lastAt = performance.now();
        stream(r.chunk);
      }
    } else if (r.t === "end") {
      if (call) {
        clearTimeout(call.timer);
        this.calls.delete(r.id);
        maybeSlow("rtc", "req.end", call.startedAt, {
          room: this.room,
          method: call.method,
          path: call.path,
          status: call.status,
          chunks: call.dataCount || 0,
          bytes: call.bytes || 0,
        });
        // end.seq is the count of data frames the host sent; a mismatch means
        // the stream was truncated, so don't resolve it as complete.
        if (typeof r.seq === "number" && r.seq !== (call.dataCount || 0))
          call.reject(new Error("truncated response"));
        else if (r.error) call.reject(new Error(r.error));
        else call.resolve({ status: call.status, text: call.body });
      }
    }
  }
  req(method, path, body) {
    const id = randomHex(16);
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      // Without a deadline a request over a silently-dead DataChannel (host
      // gone, ICE not yet timed out) never settles, so the caller — and the
      // poll loop — hangs forever and the room never reconnects. Reject on a
      // timeout so listSource sees the failure and triggers backoff.
      const timer = setTimeout(() => {
        if (this.calls.delete(id)) {
          maybeSlow("rtc", "req.timeout", startedAt, { room: this.room, method, path }, true);
          reject(new Error("request timed out"));
        }
      }, 12000);
      this.calls.set(id, {
        status: 0,
        body: "",
        dataCount: 0,
        bytes: 0,
        method,
        path,
        startedAt,
        resolve,
        reject,
        timer,
      });
      perfLog("rtc", "req.start", { room: this.room, method, path });
      this._dcSend(0, { t: "req", id, method, path, body }).catch((e) => {
        clearTimeout(timer);
        this.calls.delete(id);
        maybeSlow("rtc", "req.send_fail", startedAt, {
          room: this.room,
          method,
          path,
          error: String(e?.message ?? e),
        });
        reject(e); // channel already torn down
      });
    });
  }
  subscribe(path, onRaw) {
    const id = randomHex(16);
    const startedAt = performance.now();
    const wrapped = (chunk) => onRaw(chunk);
    Object.assign(wrapped, { path, startedAt, firstAt: 0, lastAt: 0, chunks: 0, bytes: 0 });
    this.streams.set(id, wrapped);
    perfLog("rtc", "stream.start", { room: this.room, path });
    this._dcSend(0, { t: "req", id, method: "GET", path });
    return () => {
      const stream = this.streams.get(id);
      if (stream)
        perfLog("rtc", "stream.close", {
          room: this.room,
          path,
          ms: Math.round(performance.now() - startedAt),
          chunks: stream.chunks,
          bytes: stream.bytes,
        });
      this.streams.delete(id);
      this._dcSend(0, { t: "abort", id });
    };
  }
  // Tear down BOTH wires. Closing only the pc leaves the signaling socket
  // open and this client registered in the room, so each reconnect would
  // leak another peer on the host. onstate is detached by the caller first.
  close() {
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    try {
      this.ws?.close();
    } catch {}
    try {
      this.pc?.close();
    } catch {}
    this.dc = null;
    // Settle anything still in flight now, rather than letting each req's
    // 12s timeout fire long after the client is gone.
    for (const c of this.calls.values()) {
      clearTimeout(c.timer);
      c.reject(new Error("connection closed"));
    }
    this.calls.clear();
    this.streams.clear();
  }
}

// Parse a room hash / share link into {room, token, host}. Accepts both the
// console hash form  #<room>:<token>[@<sighost>]  and the share-link URL form
// webrtc://<room>:<token>@<host>  (what `ay serve --share` writes to
// ~/.agent-yes/.share-link). host defaults to SIG_DEFAULT. Returns null when
// the input isn't a room reference (e.g. an empty hash, a bare "#room", or the
// local  #k=<token>  auth hash) so the caller falls back to the HTTP wire.
export function parseRoomHash(hash) {
  if (!hash) return null;
  const raw = String(hash).trim();
  // webrtc://<room>:<token>@<host> — the .share-link URL form (host is explicit).
  const wm = /^webrtc:\/\/([A-Za-z0-9_-]+):([^@\s]+)@([^\s]+)$/.exec(raw);
  if (wm) return { room: wm[1], token: wm[2], host: wm[3] };
  // #<room>:<token>[@<host>] — the console hash form. Strip a leading '#' and
  // percent-decode (a token may be URL-encoded in the hash).
  let h = raw.replace(/^#/, "");
  try {
    h = decodeURIComponent(h);
  } catch {}
  if (!h) return null;
  // Guard against the local-auth hash (#k=<token>) and launch hash (#launch=…).
  if (/^(k|t|launch)=/.test(h)) return null;
  const m = /^([A-Za-z0-9_-]+):([^@\s]+)(?:@([^\s]+))?$/.exec(h);
  if (!m) return null;
  // A bare  #room:<pid>  deep link (numeric id, no @host) is a selection, not a
  // token — it can't connect a fresh room without a cached secret, so ignore it.
  if (!m[3] && !/^e\d/i.test(m[2]) && /^\d{1,7}$/.test(m[2])) return null;
  return { room: m[1], token: m[2], host: m[3] || SIG_DEFAULT };
}

// Convenience: connect and return an open RTCClient for a parsed room.
export async function connectRoom({ room, token, host }) {
  const c = new RTCClient(host || SIG_DEFAULT, room, token);
  await c.connect();
  return c;
}
