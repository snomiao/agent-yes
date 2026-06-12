function k() {
  return crypto.randomUUID();
}
var g = 60000,
  u = 1e4,
  L = 1000,
  b = 120000,
  O = 25000;
class j {
  opts;
  peerId;
  ws = null;
  closed = !1;
  reconnectDelay = L;
  reconnectTimer = null;
  dormant = !1;
  heartbeat = null;
  stableTimer = null;
  openedAt = 0;
  constructor(z) {
    this.opts = z;
    this.peerId = z.peerId ?? k();
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
    let Q = globalThis.window;
    (Q?.addEventListener("focus", this.onWake), Q?.addEventListener("online", this.onWake));
  }
  detachWakeListeners() {
    globalThis.document?.removeEventListener("visibilitychange", this.onWake);
    let Q = globalThis.window;
    (Q?.removeEventListener("focus", this.onWake), Q?.removeEventListener("online", this.onWake));
  }
  roomUrl() {
    return `${this.opts.url.replace(/\/+$/, "")}/room/${encodeURIComponent(this.opts.token)}`;
  }
  open() {
    let z = new WebSocket(this.roomUrl());
    this.ws = z;
    let Q = setTimeout(() => {
      if (z.readyState === 0)
        try {
          z.close();
        } catch {}
    }, u);
    ((z.onopen = () => {
      (clearTimeout(Q),
        (this.openedAt = Date.now()),
        this.clearStableTimer(),
        (this.stableTimer = setTimeout(() => {
          this.reconnectDelay = L;
        }, g)));
      let Y = {
        type: "hello",
        role: this.opts.role,
        peerId: this.peerId,
        ...(this.opts.meta ? { meta: this.opts.meta } : {}),
      };
      (z.send(JSON.stringify(Y)), this.startHeartbeat(), this.opts.onOpen?.());
    }),
      (z.onmessage = (Y) => {
        let Z;
        try {
          Z = JSON.parse(String(Y.data));
        } catch {
          return;
        }
        if (Z.type === "peers") this.opts.onPeers?.(Z.peers);
        else if (Z.type === "signal") this.opts.onSignal?.(Z.from, Z.data);
      }),
      (z.onclose = (Y) => {
        (clearTimeout(Q), this.clearStableTimer(), this.stopHeartbeat());
        let Z = this.openedAt ? Date.now() - this.openedAt : 0;
        if (
          ((this.openedAt = 0),
          this.opts.onClose?.({ code: Y?.code ?? 0, reason: Y?.reason ?? "", ms: Z }),
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
      }, O)));
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
    ((this.reconnectDelay = Math.min(this.reconnectDelay * 2, b)),
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
  sendSignal(z, Q) {
    let Y = { type: "signal", to: z, data: Q };
    this.ws?.send(JSON.stringify(Y));
  }
  updateMeta(z) {
    if (((this.opts.meta = z), this.ws?.readyState === 1)) {
      let Q = { type: "meta", meta: z };
      this.ws.send(JSON.stringify(Q));
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
var A = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  N = "codehost",
  _ = "codehost-bulk";
class B {
  opts;
  pc;
  channel = null;
  bulk = null;
  constructor(z) {
    this.opts = z;
    ((this.pc = new RTCPeerConnection({ iceServers: A.map((Q) => ({ urls: Q })) })),
      (this.pc.onicecandidate = (Q) => {
        if (Q.candidate)
          this.opts.sendSignal({
            kind: "candidate",
            candidate: Q.candidate.candidate,
            mid: Q.candidate.sdpMid ?? "0",
          });
      }),
      (this.pc.onconnectionstatechange = () => {
        this.opts.onState?.(this.pc.connectionState);
      }));
  }
  async start() {
    let z = this.pc.createDataChannel(N, { ordered: !0 });
    ((z.binaryType = "arraybuffer"),
      (this.channel = z),
      (z.onopen = () => this.opts.onOpen?.(z)),
      (z.onclose = () => this.opts.onClose?.()));
    let Q = this.pc.createDataChannel(_, { ordered: !0 });
    ((Q.binaryType = "arraybuffer"), (this.bulk = Q));
    let Y = await this.pc.createOffer();
    (await this.pc.setLocalDescription(Y),
      this.opts.sendSignal({ kind: "offer", type: "offer", sdp: Y.sdp ?? "" }));
  }
  async handleSignal(z) {
    let Q = z;
    if (!Q || typeof Q !== "object") return;
    if (Q.kind === "answer") await this.pc.setRemoteDescription({ type: "answer", sdp: Q.sdp });
    else if (Q.kind === "candidate")
      try {
        await this.pc.addIceCandidate({ candidate: Q.candidate, sdpMid: Q.mid });
      } catch (Y) {
        console.error("[rtc] addIceCandidate failed:", Y);
      }
  }
  get dataChannel() {
    return this.channel;
  }
  get bulkChannel() {
    return this.bulk;
  }
  async selectedPath() {
    try {
      let z = await this.pc.getStats(),
        Q = null;
      z.forEach((q) => {
        if (q.type === "transport" && q.selectedCandidatePairId) Q = q.selectedCandidatePairId;
      });
      let Y = null;
      if (
        (z.forEach((q) => {
          if (
            Q ? q.id === Q : q.type === "candidate-pair" && q.state === "succeeded" && q.nominated
          )
            Y = q;
        }),
        !Y)
      )
        return null;
      let { localCandidateId: Z, remoteCandidateId: $ } = Y,
        G = !0,
        V = 0;
      if (
        (z.forEach((q) => {
          if (q.id === Z || q.id === $) {
            if ((V++, q.candidateType !== "host")) G = !1;
          }
        }),
        V < 2)
      )
        return null;
      return G ? "lan" : "p2p";
    } catch {
      return null;
    }
  }
  close() {
    try {
      this.channel?.close();
    } catch {}
    try {
      this.bulk?.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
  }
}
var y = new TextEncoder(),
  S = new TextDecoder();
function P(z, Q, Y) {
  let Z = Y?.byteLength ?? 0,
    $ = new Uint8Array(5 + Z);
  if ((($[0] = z), new DataView($.buffer).setUint32(1, Q >>> 0, !1), Y && Z)) $.set(Y, 5);
  return $;
}
function J(z, Q, Y) {
  return P(z, Q, y.encode(JSON.stringify(Y)));
}
function T(z) {
  let Q = z instanceof Uint8Array ? z : new Uint8Array(z),
    Y = Q[0],
    Z = new DataView(Q.buffer, Q.byteOffset, Q.byteLength).getUint32(1, !1),
    $ = Q.subarray(5);
  return { op: Y, streamId: Z, payload: $ };
}
function U(z) {
  return JSON.parse(S.decode(z));
}
function E(z) {
  return S.decode(z);
}
function* C(z) {
  for (let Q = 0; Q < z.byteLength; Q += 65531) yield z.slice(Q, Math.min(Q + 65531, z.byteLength));
}
function f(z) {
  if (z.length === 1) return z[0];
  let Q = z.reduce(($, G) => $ + G.byteLength, 0),
    Y = new Uint8Array(Q),
    Z = 0;
  for (let $ of z) (Y.set($, Z), (Z += $.byteLength));
  return Y;
}
function* H(z, Q, Y) {
  let Z = 0;
  while (Y.byteLength - Z > 65531) (yield P(13, Q, Y.subarray(Z, Z + 65531)), (Z += 65531));
  yield P(z, Q, Y.subarray(Z));
}
class F {
  pending = new Map();
  cont(z, Q) {
    let Y = this.pending.get(z);
    if (Y) Y.push(Q.slice());
    else this.pending.set(z, [Q.slice()]);
  }
  finish(z, Q) {
    let Y = this.pending.get(z);
    if (!Y) return Q;
    return (this.pending.delete(z), Y.push(Q), f(Y));
  }
  drop(z) {
    this.pending.delete(z);
  }
}
class R {
  channel;
  bulk;
  nextStreamId = 1;
  https = new Map();
  wss = new Map();
  wsRx = new F();
  textEncoder = new TextEncoder();
  constructor(z, Q = null) {
    this.channel = z;
    this.bulk = Q;
    if (
      ((z.binaryType = "arraybuffer"),
      z.addEventListener("message", (Y) => this.onFrame(Y.data)),
      Q)
    )
      ((Q.binaryType = "arraybuffer"), Q.addEventListener("message", (Y) => this.onFrame(Y.data)));
  }
  allocId() {
    let z = this.nextStreamId;
    return ((this.nextStreamId = (this.nextStreamId + 1) >>> 0 || 1), z);
  }
  onFrame(z) {
    if (typeof z === "string") return;
    let { op: Q, streamId: Y, payload: Z } = T(z);
    switch (Q) {
      case 4:
        this.https.get(Y)?.onHead(U(Z));
        break;
      case 5:
        this.https.get(Y)?.onBody(Z.slice());
        break;
      case 6:
        (this.https.get(Y)?.onEnd(), this.https.delete(Y));
        break;
      case 12: {
        let $ = this.https.get(Y);
        if ($) ($.onError(U(Z).message), this.https.delete(Y));
        break;
      }
      case 8: {
        let $ = U(Z);
        this.wss.get(Y)?.onOpenAck($.ok, $.protocol);
        break;
      }
      case 13:
        this.wsRx.cont(Y, Z);
        break;
      case 9:
        this.wss.get(Y)?.onText(E(this.wsRx.finish(Y, Z)));
        break;
      case 10:
        this.wss.get(Y)?.onBin(this.wsRx.finish(Y, Z).slice());
        break;
      case 11: {
        let $ = U(Z);
        (this.wsRx.drop(Y),
          this.wss.get(Y)?.onClose($.code ?? 1000, $.reason ?? ""),
          this.wss.delete(Y));
        break;
      }
    }
  }
  fetch(z, Q, Y, Z) {
    let $ = this.allocId();
    return new Promise((G, V) => {
      let q = null,
        D = null,
        X = new ReadableStream({
          start: (K) => {
            D = K;
          },
        }),
        v = typeof DecompressionStream < "u" ? { ...Y, "x-codehost-accept-gzip": "1" } : Y;
      this.https.set($, {
        onHead: (K) => {
          q = K;
          let x = new Headers(K.headers),
            M = X;
          if (x.get("content-encoding") === "gzip")
            ((M = X.pipeThrough(new DecompressionStream("gzip"))),
              x.delete("content-encoding"),
              x.delete("content-length"));
          G(
            new Response(M, {
              status: K.status === 204 || K.status === 304 ? K.status : K.status,
              statusText: K.statusText,
              headers: x,
            }),
          );
        },
        onBody: (K) => {
          try {
            D?.enqueue(K);
          } catch {}
        },
        onEnd: () => {
          try {
            D?.close();
          } catch {}
          if (!q) V(Error("stream ended before head"));
        },
        onError: (K) => {
          try {
            D?.error(Error(K));
          } catch {}
          if (!q) V(Error(K));
        },
      });
      let W = this.bulk?.readyState === "open" ? this.bulk : this.channel;
      if ((this.sendOn(W, J(1, $, { method: z, path: Q, headers: v })), Z && Z.byteLength))
        for (let K of C(Z)) this.sendOn(W, P(2, $, K));
      this.sendOn(W, P(3, $));
    });
  }
  openWs(z, Q, Y) {
    let Z = this.allocId();
    return (
      this.wss.set(Z, Y),
      this.send(J(7, Z, { path: z, protocols: Q })),
      {
        sendText: ($) => {
          for (let G of H(9, Z, this.textEncoder.encode($))) this.send(G);
        },
        sendBin: ($) => {
          for (let G of H(10, Z, $)) this.send(G);
        },
        close: ($, G) => {
          (this.send(J(11, Z, { code: $, reason: G })), this.wss.delete(Z));
        },
      }
    );
  }
  send(z) {
    this.sendOn(this.channel, z);
  }
  sendOn(z, Q) {
    if (z.readyState === "open") {
      let Y = new Uint8Array(Q.byteLength);
      (Y.set(Q), z.send(Y.buffer));
    }
  }
  get ready() {
    return this.channel.readyState === "open";
  }
}
var I = "wss://signal.codehost.dev",
  h = 1e4;
class w {
  peers = [];
  signaling;
  rtcs = new Map();
  tunnels = new Map();
  dialFailedAt = new Map();
  closed = !1;
  constructor(z) {
    ((this.signaling = new j({
      url: z.signalUrl ?? I,
      token: z.token,
      role: "viewer",
      onOpen: () => z.onStatus?.(!0),
      onClose: () => z.onStatus?.(!1),
      onPeers: (Q) => {
        ((this.peers = Q.filter((Y) => Y.role === "server")), z.onPeers?.(this.peers));
      },
      onSignal: (Q, Y) => void this.rtcs.get(Q)?.handleSignal(Y),
    })),
      this.signaling.connect());
  }
  async fetch(z, Q, Y, Z = {}) {
    let $ = await this.dial(z),
      G = typeof Z.body === "string" ? new TextEncoder().encode(Z.body) : Z.body;
    return $.fetch(Q, Y, Z.headers ?? {}, G);
  }
  dial(z) {
    let Q = this.tunnels.get(z);
    if (Q) return Q;
    let Y = this.dialFailedAt.get(z);
    if (Y != null && Date.now() - Y < h)
      return Promise.reject(Error("dial failed recently; cooling down"));
    let Z = () => {
        (this.tunnels.delete(z), this.rtcs.get(z)?.close(), this.rtcs.delete(z));
      },
      $ = new Promise((G, V) => {
        let q = setTimeout(() => {
            (Z(), V(Error("dial timed out")));
          }, 15000),
          D = new B({
            sendSignal: (X) => this.signaling.sendSignal(z, X),
            onOpen: (X) => {
              (clearTimeout(q), this.dialFailedAt.delete(z), G(new R(X, D.bulkChannel)));
            },
            onClose: Z,
            onState: (X) => {
              if (X === "failed" || X === "disconnected") Z();
            },
          });
        (this.rtcs.set(z, D),
          D.start().catch((X) => {
            (clearTimeout(q), Z(), V(X));
          }));
      });
    return (
      this.tunnels.set(z, $),
      $.catch(() => {
        (this.dialFailedAt.set(z, Date.now()), this.tunnels.delete(z));
      }),
      $
    );
  }
  close() {
    if (this.closed) return;
    this.closed = !0;
    for (let z of this.rtcs.values()) z.close();
    (this.rtcs.clear(), this.tunnels.clear(), this.signaling.close());
  }
}
function zz(z) {
  return new w(z);
}
export { zz as joinRoom, I as DEFAULT_SIGNAL_URL, w as CodehostRoom };
