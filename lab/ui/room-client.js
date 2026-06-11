function W() {
  return crypto.randomUUID();
}
var E = 1e4,
  T = 1e4;
class U {
  opts;
  peerId;
  ws = null;
  closed = !1;
  reconnectDelay = 1000;
  heartbeat = null;
  stableTimer = null;
  openedAt = 0;
  constructor(q) {
    this.opts = q;
    this.peerId = q.peerId ?? W();
  }
  connect() {
    ((this.closed = !1), this.open());
  }
  roomUrl() {
    return `${this.opts.url.replace(/\/+$/, "")}/room/${encodeURIComponent(this.opts.token)}`;
  }
  open() {
    let q = new WebSocket(this.roomUrl());
    this.ws = q;
    let z = setTimeout(() => {
      if (q.readyState === 0)
        try {
          q.close();
        } catch {}
    }, T);
    ((q.onopen = () => {
      (clearTimeout(z),
        (this.openedAt = Date.now()),
        this.clearStableTimer(),
        (this.stableTimer = setTimeout(() => {
          this.reconnectDelay = 1000;
        }, E)));
      let K = {
        type: "hello",
        role: this.opts.role,
        peerId: this.peerId,
        ...(this.opts.meta ? { meta: this.opts.meta } : {}),
      };
      (q.send(JSON.stringify(K)), this.startHeartbeat(), this.opts.onOpen?.());
    }),
      (q.onmessage = (K) => {
        let Q;
        try {
          Q = JSON.parse(String(K.data));
        } catch {
          return;
        }
        if (Q.type === "peers") this.opts.onPeers?.(Q.peers);
        else if (Q.type === "signal") this.opts.onSignal?.(Q.from, Q.data);
      }),
      (q.onclose = (K) => {
        (clearTimeout(z), this.clearStableTimer(), this.stopHeartbeat());
        let Q = this.openedAt ? Date.now() - this.openedAt : 0;
        if (
          ((this.openedAt = 0),
          this.opts.onClose?.({ code: K?.code ?? 0, reason: K?.reason ?? "", ms: Q }),
          !this.closed)
        )
          this.scheduleReconnect();
      }),
      (q.onerror = () => {
        try {
          q.close();
        } catch {}
      }));
  }
  startHeartbeat() {
    (this.stopHeartbeat(),
      (this.heartbeat = setInterval(() => {
        try {
          this.ws?.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }, 1e4)));
  }
  stopHeartbeat() {
    if (this.heartbeat != null) (clearInterval(this.heartbeat), (this.heartbeat = null));
  }
  clearStableTimer() {
    if (this.stableTimer != null) (clearTimeout(this.stableTimer), (this.stableTimer = null));
  }
  scheduleReconnect() {
    let q = this.reconnectDelay;
    ((this.reconnectDelay = Math.min(q * 2, 15000)),
      setTimeout(() => {
        if (!this.closed) this.open();
      }, q));
  }
  sendSignal(q, z) {
    let K = { type: "signal", to: q, data: z };
    this.ws?.send(JSON.stringify(K));
  }
  updateMeta(q) {
    if (((this.opts.meta = q), this.ws?.readyState === 1)) {
      let z = { type: "meta", meta: q };
      this.ws.send(JSON.stringify(z));
    }
  }
  close() {
    ((this.closed = !0), this.stopHeartbeat(), this.clearStableTimer());
    try {
      this.ws?.close();
    } catch {}
  }
}
var A = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  _ = "codehost";
class B {
  opts;
  pc;
  channel = null;
  constructor(q) {
    this.opts = q;
    ((this.pc = new RTCPeerConnection({ iceServers: A.map((z) => ({ urls: z })) })),
      (this.pc.onicecandidate = (z) => {
        if (z.candidate)
          this.opts.sendSignal({
            kind: "candidate",
            candidate: z.candidate.candidate,
            mid: z.candidate.sdpMid ?? "0",
          });
      }),
      (this.pc.onconnectionstatechange = () => {
        this.opts.onState?.(this.pc.connectionState);
      }));
  }
  async start() {
    let q = this.pc.createDataChannel(_, { ordered: !0 });
    ((q.binaryType = "arraybuffer"),
      (this.channel = q),
      (q.onopen = () => this.opts.onOpen?.(q)),
      (q.onclose = () => this.opts.onClose?.()));
    let z = await this.pc.createOffer();
    (await this.pc.setLocalDescription(z),
      this.opts.sendSignal({ kind: "offer", type: "offer", sdp: z.sdp ?? "" }));
  }
  async handleSignal(q) {
    let z = q;
    if (!z || typeof z !== "object") return;
    if (z.kind === "answer") await this.pc.setRemoteDescription({ type: "answer", sdp: z.sdp });
    else if (z.kind === "candidate")
      try {
        await this.pc.addIceCandidate({ candidate: z.candidate, sdpMid: z.mid });
      } catch (K) {
        console.error("[rtc] addIceCandidate failed:", K);
      }
  }
  get dataChannel() {
    return this.channel;
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
var F = new TextEncoder(),
  x = new TextDecoder();
function G(q, z, K) {
  let Q = K?.byteLength ?? 0,
    X = new Uint8Array(5 + Q);
  if (((X[0] = q), new DataView(X.buffer).setUint32(1, z >>> 0, !1), K && Q)) X.set(K, 5);
  return X;
}
function P(q, z, K) {
  return G(q, z, F.encode(JSON.stringify(K)));
}
function J(q) {
  let z = q instanceof Uint8Array ? q : new Uint8Array(q),
    K = z[0],
    Q = new DataView(z.buffer, z.byteOffset, z.byteLength).getUint32(1, !1),
    X = z.subarray(5);
  return { op: K, streamId: Q, payload: X };
}
function H(q) {
  return JSON.parse(x.decode(q));
}
function L(q) {
  return x.decode(q);
}
function* S(q) {
  for (let z = 0; z < q.byteLength; z += 16379) yield q.slice(z, Math.min(z + 16379, q.byteLength));
}
function C(q) {
  if (q.length === 1) return q[0];
  let z = q.reduce((X, Z) => X + Z.byteLength, 0),
    K = new Uint8Array(z),
    Q = 0;
  for (let X of q) (K.set(X, Q), (Q += X.byteLength));
  return K;
}
function* M(q, z, K) {
  let Q = 0;
  while (K.byteLength - Q > 16379) (yield G(13, z, K.subarray(Q, Q + 16379)), (Q += 16379));
  yield G(q, z, K.subarray(Q));
}
class k {
  pending = new Map();
  cont(q, z) {
    let K = this.pending.get(q);
    if (K) K.push(z.slice());
    else this.pending.set(q, [z.slice()]);
  }
  finish(q, z) {
    let K = this.pending.get(q);
    if (!K) return z;
    return (this.pending.delete(q), K.push(z), C(K));
  }
  drop(q) {
    this.pending.delete(q);
  }
}
class N {
  channel;
  nextStreamId = 1;
  https = new Map();
  wss = new Map();
  wsRx = new k();
  textEncoder = new TextEncoder();
  constructor(q) {
    this.channel = q;
    ((q.binaryType = "arraybuffer"), q.addEventListener("message", (z) => this.onFrame(z.data)));
  }
  allocId() {
    let q = this.nextStreamId;
    return ((this.nextStreamId = (this.nextStreamId + 1) >>> 0 || 1), q);
  }
  onFrame(q) {
    if (typeof q === "string") return;
    let { op: z, streamId: K, payload: Q } = J(q);
    switch (z) {
      case 4:
        this.https.get(K)?.onHead(H(Q));
        break;
      case 5:
        this.https.get(K)?.onBody(Q.slice());
        break;
      case 6:
        (this.https.get(K)?.onEnd(), this.https.delete(K));
        break;
      case 12: {
        let X = this.https.get(K);
        if (X) (X.onError(H(Q).message), this.https.delete(K));
        break;
      }
      case 8: {
        let X = H(Q);
        this.wss.get(K)?.onOpenAck(X.ok, X.protocol);
        break;
      }
      case 13:
        this.wsRx.cont(K, Q);
        break;
      case 9:
        this.wss.get(K)?.onText(L(this.wsRx.finish(K, Q)));
        break;
      case 10:
        this.wss.get(K)?.onBin(this.wsRx.finish(K, Q).slice());
        break;
      case 11: {
        let X = H(Q);
        (this.wsRx.drop(K),
          this.wss.get(K)?.onClose(X.code ?? 1000, X.reason ?? ""),
          this.wss.delete(K));
        break;
      }
    }
  }
  fetch(q, z, K, Q) {
    let X = this.allocId();
    return new Promise((Z, V) => {
      let D = null,
        $ = null,
        j = new ReadableStream({
          start: (Y) => {
            $ = Y;
          },
        });
      if (
        (this.https.set(X, {
          onHead: (Y) => {
            ((D = Y),
              Z(
                new Response(j, {
                  status: Y.status === 204 || Y.status === 304 ? Y.status : Y.status,
                  statusText: Y.statusText,
                  headers: Y.headers,
                }),
              ));
          },
          onBody: (Y) => {
            try {
              $?.enqueue(Y);
            } catch {}
          },
          onEnd: () => {
            try {
              $?.close();
            } catch {}
            if (!D) V(Error("stream ended before head"));
          },
          onError: (Y) => {
            try {
              $?.error(Error(Y));
            } catch {}
            if (!D) V(Error(Y));
          },
        }),
        this.send(P(1, X, { method: q, path: z, headers: K })),
        Q && Q.byteLength)
      )
        for (let Y of S(Q)) this.send(G(2, X, Y));
      this.send(G(3, X));
    });
  }
  openWs(q, z, K) {
    let Q = this.allocId();
    return (
      this.wss.set(Q, K),
      this.send(P(7, Q, { path: q, protocols: z })),
      {
        sendText: (X) => {
          for (let Z of M(9, Q, this.textEncoder.encode(X))) this.send(Z);
        },
        sendBin: (X) => {
          for (let Z of M(10, Q, X)) this.send(Z);
        },
        close: (X, Z) => {
          (this.send(P(11, Q, { code: X, reason: Z })), this.wss.delete(Q));
        },
      }
    );
  }
  send(q) {
    if (this.channel.readyState === "open") {
      let z = new Uint8Array(q.byteLength);
      (z.set(q), this.channel.send(z.buffer));
    }
  }
  get ready() {
    return this.channel.readyState === "open";
  }
}
var w = "wss://signal.codehost.dev";
class R {
  peers = [];
  signaling;
  rtcs = new Map();
  tunnels = new Map();
  closed = !1;
  constructor(q) {
    ((this.signaling = new U({
      url: q.signalUrl ?? w,
      token: q.token,
      role: "viewer",
      onOpen: () => q.onStatus?.(!0),
      onClose: () => q.onStatus?.(!1),
      onPeers: (z) => {
        ((this.peers = z.filter((K) => K.role === "server")), q.onPeers?.(this.peers));
      },
      onSignal: (z, K) => void this.rtcs.get(z)?.handleSignal(K),
    })),
      this.signaling.connect());
  }
  async fetch(q, z, K, Q = {}) {
    let X = await this.dial(q),
      Z = typeof Q.body === "string" ? new TextEncoder().encode(Q.body) : Q.body;
    return X.fetch(z, K, Q.headers ?? {}, Z);
  }
  dial(q) {
    let z = this.tunnels.get(q);
    if (z) return z;
    let K = () => {
        (this.tunnels.delete(q), this.rtcs.get(q)?.close(), this.rtcs.delete(q));
      },
      Q = new Promise((X, Z) => {
        let V = setTimeout(() => {
            (K(), Z(Error("dial timed out")));
          }, 15000),
          D = new B({
            sendSignal: ($) => this.signaling.sendSignal(q, $),
            onOpen: ($) => {
              (clearTimeout(V), X(new N($)));
            },
            onClose: K,
            onState: ($) => {
              if ($ === "failed" || $ === "disconnected") K();
            },
          });
        (this.rtcs.set(q, D),
          D.start().catch(($) => {
            (clearTimeout(V), K(), Z($));
          }));
      });
    return (this.tunnels.set(q, Q), Q.catch(() => this.tunnels.delete(q)), Q);
  }
  close() {
    if (this.closed) return;
    this.closed = !0;
    for (let q of this.rtcs.values()) q.close();
    (this.rtcs.clear(), this.tunnels.clear(), this.signaling.close());
  }
}
function n(q) {
  return new R(q);
}
export { n as joinRoom, w as DEFAULT_SIGNAL_URL, R as CodehostRoom };
