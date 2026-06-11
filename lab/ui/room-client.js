function F() {
  return crypto.randomUUID();
}
var v = 60000,
  w = 1e4,
  M = 1000,
  u = 120000,
  b = 25000;
class H {
  opts;
  peerId;
  ws = null;
  closed = !1;
  reconnectDelay = M;
  reconnectTimer = null;
  dormant = !1;
  heartbeat = null;
  stableTimer = null;
  openedAt = 0;
  constructor(z) {
    this.opts = z;
    this.peerId = z.peerId ?? F();
  }
  connect() {
    ((this.closed = !1), this.attachWakeListeners(), this.open());
  }
  onWake = () => {
    if (this.closed) return;
    let z = this.ws?.readyState;
    if (z === 1) return;
    if (z === 0) {
      try {
        this.ws?.close();
      } catch {}
      return;
    }
    if (this.dormant || this.reconnectTimer != null)
      ((this.dormant = !1), this.clearReconnectTimer(), this.open());
  };
  hidden() {
    return globalThis.document?.visibilityState === "hidden";
  }
  attachWakeListeners() {
    globalThis.document?.addEventListener("visibilitychange", this.onWake);
    let K = globalThis.window;
    (K?.addEventListener("focus", this.onWake), K?.addEventListener("online", this.onWake));
  }
  detachWakeListeners() {
    globalThis.document?.removeEventListener("visibilitychange", this.onWake);
    let K = globalThis.window;
    (K?.removeEventListener("focus", this.onWake), K?.removeEventListener("online", this.onWake));
  }
  roomUrl() {
    return `${this.opts.url.replace(/\/+$/, "")}/room/${encodeURIComponent(this.opts.token)}`;
  }
  open() {
    let z = new WebSocket(this.roomUrl());
    this.ws = z;
    let K = setTimeout(() => {
      if (z.readyState === 0)
        try {
          z.close();
        } catch {}
    }, w);
    ((z.onopen = () => {
      (clearTimeout(K),
        (this.openedAt = Date.now()),
        this.clearStableTimer(),
        (this.stableTimer = setTimeout(() => {
          this.reconnectDelay = M;
        }, v)));
      let Q = {
        type: "hello",
        role: this.opts.role,
        peerId: this.peerId,
        ...(this.opts.meta ? { meta: this.opts.meta } : {}),
      };
      (z.send(JSON.stringify(Q)), this.startHeartbeat(), this.opts.onOpen?.());
    }),
      (z.onmessage = (Q) => {
        let Y;
        try {
          Y = JSON.parse(String(Q.data));
        } catch {
          return;
        }
        if (Y.type === "peers") this.opts.onPeers?.(Y.peers);
        else if (Y.type === "signal") this.opts.onSignal?.(Y.from, Y.data);
      }),
      (z.onclose = (Q) => {
        (clearTimeout(K), this.clearStableTimer(), this.stopHeartbeat());
        let Y = this.openedAt ? Date.now() - this.openedAt : 0;
        if (
          ((this.openedAt = 0),
          this.opts.onClose?.({ code: Q?.code ?? 0, reason: Q?.reason ?? "", ms: Y }),
          !this.closed)
        )
          this.scheduleReconnect();
      }),
      (z.onerror = () => {
        try {
          z.close();
        } catch {}
      }));
  }
  startHeartbeat() {
    (this.stopHeartbeat(),
      (this.heartbeat = setInterval(() => {
        try {
          this.ws?.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }, b)));
  }
  stopHeartbeat() {
    if (this.heartbeat != null) (clearInterval(this.heartbeat), (this.heartbeat = null));
  }
  clearStableTimer() {
    if (this.stableTimer != null) (clearTimeout(this.stableTimer), (this.stableTimer = null));
  }
  scheduleReconnect() {
    if (this.hidden()) {
      this.dormant = !0;
      return;
    }
    let z = Math.round(this.reconnectDelay * (0.75 + Math.random() * 0.5));
    ((this.reconnectDelay = Math.min(this.reconnectDelay * 2, u)),
      this.clearReconnectTimer(),
      (this.reconnectTimer = setTimeout(() => {
        if (((this.reconnectTimer = null), this.closed)) return;
        if (this.hidden()) {
          this.dormant = !0;
          return;
        }
        this.open();
      }, z)));
  }
  clearReconnectTimer() {
    if (this.reconnectTimer != null)
      (clearTimeout(this.reconnectTimer), (this.reconnectTimer = null));
  }
  sendSignal(z, K) {
    let Q = { type: "signal", to: z, data: K };
    this.ws?.send(JSON.stringify(Q));
  }
  updateMeta(z) {
    if (((this.opts.meta = z), this.ws?.readyState === 1)) {
      let K = { type: "meta", meta: z };
      this.ws.send(JSON.stringify(K));
    }
  }
  close() {
    ((this.closed = !0),
      (this.dormant = !1),
      this.detachWakeListeners(),
      this.clearReconnectTimer(),
      this.stopHeartbeat(),
      this.clearStableTimer());
    try {
      this.ws?.close();
    } catch {}
  }
}
var R = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  A = "codehost";
class x {
  opts;
  pc;
  channel = null;
  constructor(z) {
    this.opts = z;
    ((this.pc = new RTCPeerConnection({ iceServers: R.map((K) => ({ urls: K })) })),
      (this.pc.onicecandidate = (K) => {
        if (K.candidate)
          this.opts.sendSignal({
            kind: "candidate",
            candidate: K.candidate.candidate,
            mid: K.candidate.sdpMid ?? "0",
          });
      }),
      (this.pc.onconnectionstatechange = () => {
        this.opts.onState?.(this.pc.connectionState);
      }));
  }
  async start() {
    let z = this.pc.createDataChannel(A, { ordered: !0 });
    ((z.binaryType = "arraybuffer"),
      (this.channel = z),
      (z.onopen = () => this.opts.onOpen?.(z)),
      (z.onclose = () => this.opts.onClose?.()));
    let K = await this.pc.createOffer();
    (await this.pc.setLocalDescription(K),
      this.opts.sendSignal({ kind: "offer", type: "offer", sdp: K.sdp ?? "" }));
  }
  async handleSignal(z) {
    let K = z;
    if (!K || typeof K !== "object") return;
    if (K.kind === "answer") await this.pc.setRemoteDescription({ type: "answer", sdp: K.sdp });
    else if (K.kind === "candidate")
      try {
        await this.pc.addIceCandidate({ candidate: K.candidate, sdpMid: K.mid });
      } catch (Q) {
        console.error("[rtc] addIceCandidate failed:", Q);
      }
  }
  get dataChannel() {
    return this.channel;
  }
  async selectedPath() {
    try {
      let z = await this.pc.getStats(),
        K = null;
      z.forEach(($) => {
        if ($.type === "transport" && $.selectedCandidatePairId) K = $.selectedCandidatePairId;
      });
      let Q = null;
      if (
        (z.forEach(($) => {
          if (
            K ? $.id === K : $.type === "candidate-pair" && $.state === "succeeded" && $.nominated
          )
            Q = $;
        }),
        !Q)
      )
        return null;
      let { localCandidateId: Y, remoteCandidateId: Z } = Q,
        q = !0,
        X = 0;
      if (
        (z.forEach(($) => {
          if ($.id === Y || $.id === Z) {
            if ((X++, $.candidateType !== "host")) q = !1;
          }
        }),
        X < 2)
      )
        return null;
      return q ? "lan" : "p2p";
    } catch {
      return null;
    }
  }
  close() {
    try {
      this.channel?.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
  }
}
var g = new TextEncoder(),
  N = new TextDecoder();
function D(z, K, Q) {
  let Y = Q?.byteLength ?? 0,
    Z = new Uint8Array(5 + Y);
  if (((Z[0] = z), new DataView(Z.buffer).setUint32(1, K >>> 0, !1), Q && Y)) Z.set(Q, 5);
  return Z;
}
function k(z, K, Q) {
  return D(z, K, g.encode(JSON.stringify(Q)));
}
function S(z) {
  let K = z instanceof Uint8Array ? z : new Uint8Array(z),
    Q = K[0],
    Y = new DataView(K.buffer, K.byteOffset, K.byteLength).getUint32(1, !1),
    Z = K.subarray(5);
  return { op: Q, streamId: Y, payload: Z };
}
function U(z) {
  return JSON.parse(N.decode(z));
}
function T(z) {
  return N.decode(z);
}
function* _(z) {
  for (let K = 0; K < z.byteLength; K += 65531) yield z.slice(K, Math.min(K + 65531, z.byteLength));
}
function O(z) {
  if (z.length === 1) return z[0];
  let K = z.reduce((Z, q) => Z + q.byteLength, 0),
    Q = new Uint8Array(K),
    Y = 0;
  for (let Z of z) (Q.set(Z, Y), (Y += Z.byteLength));
  return Q;
}
function* J(z, K, Q) {
  let Y = 0;
  while (Q.byteLength - Y > 65531) (yield D(13, K, Q.subarray(Y, Y + 65531)), (Y += 65531));
  yield D(z, K, Q.subarray(Y));
}
class W {
  pending = new Map();
  cont(z, K) {
    let Q = this.pending.get(z);
    if (Q) Q.push(K.slice());
    else this.pending.set(z, [K.slice()]);
  }
  finish(z, K) {
    let Q = this.pending.get(z);
    if (!Q) return K;
    return (this.pending.delete(z), Q.push(K), O(Q));
  }
  drop(z) {
    this.pending.delete(z);
  }
}
class j {
  channel;
  nextStreamId = 1;
  https = new Map();
  wss = new Map();
  wsRx = new W();
  textEncoder = new TextEncoder();
  constructor(z) {
    this.channel = z;
    ((z.binaryType = "arraybuffer"), z.addEventListener("message", (K) => this.onFrame(K.data)));
  }
  allocId() {
    let z = this.nextStreamId;
    return ((this.nextStreamId = (this.nextStreamId + 1) >>> 0 || 1), z);
  }
  onFrame(z) {
    if (typeof z === "string") return;
    let { op: K, streamId: Q, payload: Y } = S(z);
    switch (K) {
      case 4:
        this.https.get(Q)?.onHead(U(Y));
        break;
      case 5:
        this.https.get(Q)?.onBody(Y.slice());
        break;
      case 6:
        (this.https.get(Q)?.onEnd(), this.https.delete(Q));
        break;
      case 12: {
        let Z = this.https.get(Q);
        if (Z) (Z.onError(U(Y).message), this.https.delete(Q));
        break;
      }
      case 8: {
        let Z = U(Y);
        this.wss.get(Q)?.onOpenAck(Z.ok, Z.protocol);
        break;
      }
      case 13:
        this.wsRx.cont(Q, Y);
        break;
      case 9:
        this.wss.get(Q)?.onText(T(this.wsRx.finish(Q, Y)));
        break;
      case 10:
        this.wss.get(Q)?.onBin(this.wsRx.finish(Q, Y).slice());
        break;
      case 11: {
        let Z = U(Y);
        (this.wsRx.drop(Q),
          this.wss.get(Q)?.onClose(Z.code ?? 1000, Z.reason ?? ""),
          this.wss.delete(Q));
        break;
      }
    }
  }
  fetch(z, K, Q, Y) {
    let Z = this.allocId();
    return new Promise((q, X) => {
      let $ = null,
        P = null,
        V = new ReadableStream({
          start: (G) => {
            P = G;
          },
        }),
        C = typeof DecompressionStream < "u" ? { ...Q, "x-codehost-accept-gzip": "1" } : Q;
      if (
        (this.https.set(Z, {
          onHead: (G) => {
            $ = G;
            let B = new Headers(G.headers),
              L = V;
            if (B.get("content-encoding") === "gzip")
              ((L = V.pipeThrough(new DecompressionStream("gzip"))),
                B.delete("content-encoding"),
                B.delete("content-length"));
            q(
              new Response(L, {
                status: G.status === 204 || G.status === 304 ? G.status : G.status,
                statusText: G.statusText,
                headers: B,
              }),
            );
          },
          onBody: (G) => {
            try {
              P?.enqueue(G);
            } catch {}
          },
          onEnd: () => {
            try {
              P?.close();
            } catch {}
            if (!$) X(Error("stream ended before head"));
          },
          onError: (G) => {
            try {
              P?.error(Error(G));
            } catch {}
            if (!$) X(Error(G));
          },
        }),
        this.send(k(1, Z, { method: z, path: K, headers: C })),
        Y && Y.byteLength)
      )
        for (let G of _(Y)) this.send(D(2, Z, G));
      this.send(D(3, Z));
    });
  }
  openWs(z, K, Q) {
    let Y = this.allocId();
    return (
      this.wss.set(Y, Q),
      this.send(k(7, Y, { path: z, protocols: K })),
      {
        sendText: (Z) => {
          for (let q of J(9, Y, this.textEncoder.encode(Z))) this.send(q);
        },
        sendBin: (Z) => {
          for (let q of J(10, Y, Z)) this.send(q);
        },
        close: (Z, q) => {
          (this.send(k(11, Y, { code: Z, reason: q })), this.wss.delete(Y));
        },
      }
    );
  }
  send(z) {
    if (this.channel.readyState === "open") {
      let K = new Uint8Array(z.byteLength);
      (K.set(z), this.channel.send(K.buffer));
    }
  }
  get ready() {
    return this.channel.readyState === "open";
  }
}
var f = "wss://signal.codehost.dev",
  y = 1e4;
class E {
  peers = [];
  signaling;
  rtcs = new Map();
  tunnels = new Map();
  dialFailedAt = new Map();
  closed = !1;
  constructor(z) {
    ((this.signaling = new H({
      url: z.signalUrl ?? f,
      token: z.token,
      role: "viewer",
      onOpen: () => z.onStatus?.(!0),
      onClose: () => z.onStatus?.(!1),
      onPeers: (K) => {
        ((this.peers = K.filter((Q) => Q.role === "server")), z.onPeers?.(this.peers));
      },
      onSignal: (K, Q) => void this.rtcs.get(K)?.handleSignal(Q),
    })),
      this.signaling.connect());
  }
  async fetch(z, K, Q, Y = {}) {
    let Z = await this.dial(z),
      q = typeof Y.body === "string" ? new TextEncoder().encode(Y.body) : Y.body;
    return Z.fetch(K, Q, Y.headers ?? {}, q);
  }
  dial(z) {
    let K = this.tunnels.get(z);
    if (K) return K;
    let Q = this.dialFailedAt.get(z);
    if (Q != null && Date.now() - Q < y)
      return Promise.reject(Error("dial failed recently; cooling down"));
    let Y = () => {
        (this.tunnels.delete(z), this.rtcs.get(z)?.close(), this.rtcs.delete(z));
      },
      Z = new Promise((q, X) => {
        let $ = setTimeout(() => {
            (Y(), X(Error("dial timed out")));
          }, 15000),
          P = new x({
            sendSignal: (V) => this.signaling.sendSignal(z, V),
            onOpen: (V) => {
              (clearTimeout($), this.dialFailedAt.delete(z), q(new j(V)));
            },
            onClose: Y,
            onState: (V) => {
              if (V === "failed" || V === "disconnected") Y();
            },
          });
        (this.rtcs.set(z, P),
          P.start().catch((V) => {
            (clearTimeout($), Y(), X(V));
          }));
      });
    return (
      this.tunnels.set(z, Z),
      Z.catch(() => {
        (this.dialFailedAt.set(z, Date.now()), this.tunnels.delete(z));
      }),
      Z
    );
  }
  close() {
    if (this.closed) return;
    this.closed = !0;
    for (let z of this.rtcs.values()) z.close();
    (this.rtcs.clear(), this.tunnels.clear(), this.signaling.close());
  }
}
function a(z) {
  return new E(z);
}
export { a as joinRoom, f as DEFAULT_SIGNAL_URL, E as CodehostRoom };
