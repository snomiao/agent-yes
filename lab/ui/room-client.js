// src/shared/signaling.ts
function newPeerId() {
  return crypto.randomUUID();
}

// src/shared/signaling-client.ts
var STABLE_MS = 60000;
var CONNECT_TIMEOUT_MS = 1e4;
var RECONNECT_MIN_MS = 1000;
var RECONNECT_MAX_MS = 120000;
var HEARTBEAT_MS = 25000;

class SignalingClient {
  opts;
  peerId;
  ws = null;
  closed = false;
  reconnectDelay = RECONNECT_MIN_MS;
  reconnectTimer = null;
  dormant = false;
  heartbeat = null;
  stableTimer = null;
  openedAt = 0;
  constructor(opts) {
    this.opts = opts;
    this.peerId = opts.peerId ?? newPeerId();
  }
  connect() {
    this.closed = false;
    this.attachWakeListeners();
    this.open();
  }
  onWake = () => {
    if (this.closed) return;
    const state = this.ws?.readyState;
    if (state === 1) return;
    if (state === 0) {
      try {
        this.ws?.close();
      } catch {}
      return;
    }
    if (this.dormant || this.reconnectTimer != null) {
      this.dormant = false;
      this.clearReconnectTimer();
      this.open();
    }
  };
  hidden() {
    const doc = globalThis.document;
    return doc?.visibilityState === "hidden";
  }
  attachWakeListeners() {
    const doc = globalThis.document;
    doc?.addEventListener("visibilitychange", this.onWake);
    const win = globalThis.window;
    win?.addEventListener("focus", this.onWake);
    win?.addEventListener("online", this.onWake);
  }
  detachWakeListeners() {
    const doc = globalThis.document;
    doc?.removeEventListener("visibilitychange", this.onWake);
    const win = globalThis.window;
    win?.removeEventListener("focus", this.onWake);
    win?.removeEventListener("online", this.onWake);
  }
  roomUrl() {
    const base = this.opts.url.replace(/\/+$/, "");
    return `${base}/room/${encodeURIComponent(this.opts.token)}`;
  }
  open() {
    const ws = new WebSocket(this.roomUrl());
    this.ws = ws;
    const connectTimer = setTimeout(() => {
      if (ws.readyState === 0) {
        try {
          ws.close();
        } catch {}
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      this.openedAt = Date.now();
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.reconnectDelay = RECONNECT_MIN_MS;
      }, STABLE_MS);
      const hello = {
        type: "hello",
        role: this.opts.role,
        peerId: this.peerId,
        ...(this.opts.meta ? { meta: this.opts.meta } : {}),
      };
      ws.send(JSON.stringify(hello));
      this.startHeartbeat();
      this.opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "peers") this.opts.onPeers?.(msg.peers);
      else if (msg.type === "signal") this.opts.onSignal?.(msg.from, msg.data);
    };
    ws.onclose = (ev) => {
      clearTimeout(connectTimer);
      this.clearStableTimer();
      this.stopHeartbeat();
      const ms = this.openedAt ? Date.now() - this.openedAt : 0;
      this.openedAt = 0;
      this.opts.onClose?.({ code: ev?.code ?? 0, reason: ev?.reason ?? "", ms });
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }, HEARTBEAT_MS);
  }
  stopHeartbeat() {
    if (this.heartbeat != null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
  clearStableTimer() {
    if (this.stableTimer != null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }
  scheduleReconnect() {
    if (this.hidden()) {
      this.dormant = true;
      return;
    }
    const delay = Math.round(this.reconnectDelay * (0.75 + Math.random() * 0.5));
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      if (this.hidden()) {
        this.dormant = true;
        return;
      }
      this.open();
    }, delay);
  }
  clearReconnectTimer() {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  sendSignal(to, data) {
    const msg = { type: "signal", to, data };
    this.ws?.send(JSON.stringify(msg));
  }
  updateMeta(meta) {
    this.opts.meta = meta;
    if (this.ws?.readyState === 1) {
      const msg = { type: "meta", meta };
      this.ws.send(JSON.stringify(msg));
    }
  }
  close() {
    this.closed = true;
    this.dormant = false;
    this.detachWakeListeners();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStableTimer();
    try {
      this.ws?.close();
    } catch {}
  }
}

// src/shared/rtc.ts
var ICE_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
var CHANNEL_LABEL = "codehost";

// src/web/rtc-client.ts
class RtcClient {
  opts;
  pc;
  channel = null;
  constructor(opts) {
    this.opts = opts;
    this.pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS.map((urls) => ({ urls })),
    });
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.opts.sendSignal({
          kind: "candidate",
          candidate: ev.candidate.candidate,
          mid: ev.candidate.sdpMid ?? "0",
        });
      }
    };
    this.pc.onconnectionstatechange = () => {
      this.opts.onState?.(this.pc.connectionState);
    };
  }
  async start() {
    const channel = this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    channel.binaryType = "arraybuffer";
    this.channel = channel;
    channel.onopen = () => this.opts.onOpen?.(channel);
    channel.onclose = () => this.opts.onClose?.();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.opts.sendSignal({ kind: "offer", type: "offer", sdp: offer.sdp ?? "" });
  }
  async handleSignal(data) {
    const sig = data;
    if (!sig || typeof sig !== "object") return;
    if (sig.kind === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
    } else if (sig.kind === "candidate") {
      try {
        await this.pc.addIceCandidate({ candidate: sig.candidate, sdpMid: sig.mid });
      } catch (err) {
        console.error("[rtc] addIceCandidate failed:", err);
      }
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

// src/shared/protocol.ts
var FRAME_HEADER = 5;
var MAX_FRAME = 16 * 1024;
var MAX_CHUNK = MAX_FRAME - FRAME_HEADER;
var enc = new TextEncoder();
var dec = new TextDecoder();
function encodeFrame(op, streamId, payload) {
  const len = payload?.byteLength ?? 0;
  const buf = new Uint8Array(5 + len);
  buf[0] = op;
  new DataView(buf.buffer).setUint32(1, streamId >>> 0, false);
  if (payload && len) buf.set(payload, 5);
  return buf;
}
function encodeJson(op, streamId, obj) {
  return encodeFrame(op, streamId, enc.encode(JSON.stringify(obj)));
}
function decodeFrame(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const op = u8[0];
  const streamId = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, false);
  const payload = u8.subarray(5);
  return { op, streamId, payload };
}
function payloadJson(payload) {
  return JSON.parse(dec.decode(payload));
}
function payloadText(payload) {
  return dec.decode(payload);
}
function* chunk(body) {
  for (let off = 0; off < body.byteLength; off += MAX_CHUNK) {
    yield body.slice(off, Math.min(off + MAX_CHUNK, body.byteLength));
  }
}
function concatBytes(parts) {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
function* wsMessageFrames(terminal, streamId, payload) {
  let off = 0;
  while (payload.byteLength - off > MAX_CHUNK) {
    yield encodeFrame(13 /* WsCont */, streamId, payload.subarray(off, off + MAX_CHUNK));
    off += MAX_CHUNK;
  }
  yield encodeFrame(terminal, streamId, payload.subarray(off));
}

class WsReassembler {
  pending = new Map();
  cont(streamId, payload) {
    const buf = this.pending.get(streamId);
    if (buf) buf.push(payload.slice());
    else this.pending.set(streamId, [payload.slice()]);
  }
  finish(streamId, payload) {
    const buf = this.pending.get(streamId);
    if (!buf) return payload;
    this.pending.delete(streamId);
    buf.push(payload);
    return concatBytes(buf);
  }
  drop(streamId) {
    this.pending.delete(streamId);
  }
}

// src/web/tunnel-client.ts
class TunnelClient {
  channel;
  nextStreamId = 1;
  https = new Map();
  wss = new Map();
  wsRx = new WsReassembler();
  textEncoder = new TextEncoder();
  constructor(channel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", (ev) => this.onFrame(ev.data));
  }
  allocId() {
    const id = this.nextStreamId;
    this.nextStreamId = (this.nextStreamId + 1) >>> 0 || 1;
    return id;
  }
  onFrame(data) {
    if (typeof data === "string") return;
    const { op, streamId, payload } = decodeFrame(data);
    switch (op) {
      case 4 /* HttpResHead */:
        this.https.get(streamId)?.onHead(payloadJson(payload));
        break;
      case 5 /* HttpResBody */:
        this.https.get(streamId)?.onBody(payload.slice());
        break;
      case 6 /* HttpResEnd */:
        this.https.get(streamId)?.onEnd();
        this.https.delete(streamId);
        break;
      case 12 /* Error */: {
        const waiter = this.https.get(streamId);
        if (waiter) {
          waiter.onError(payloadJson(payload).message);
          this.https.delete(streamId);
        }
        break;
      }
      case 8 /* WsOpenAck */: {
        const info = payloadJson(payload);
        this.wss.get(streamId)?.onOpenAck(info.ok, info.protocol);
        break;
      }
      case 13 /* WsCont */:
        this.wsRx.cont(streamId, payload);
        break;
      case 9 /* WsText */:
        this.wss.get(streamId)?.onText(payloadText(this.wsRx.finish(streamId, payload)));
        break;
      case 10 /* WsBin */:
        this.wss.get(streamId)?.onBin(this.wsRx.finish(streamId, payload).slice());
        break;
      case 11 /* WsClose */: {
        const info = payloadJson(payload);
        this.wsRx.drop(streamId);
        this.wss.get(streamId)?.onClose(info.code ?? 1000, info.reason ?? "");
        this.wss.delete(streamId);
        break;
      }
    }
  }
  fetch(method, path, headers, body) {
    const streamId = this.allocId();
    return new Promise((resolve, reject) => {
      let head = null;
      let controller = null;
      const stream = new ReadableStream({
        start: (c) => {
          controller = c;
        },
      });
      this.https.set(streamId, {
        onHead: (h) => {
          head = h;
          resolve(
            new Response(stream, {
              status: h.status === 204 || h.status === 304 ? h.status : h.status,
              statusText: h.statusText,
              headers: h.headers,
            }),
          );
        },
        onBody: (b) => {
          try {
            controller?.enqueue(b);
          } catch {}
        },
        onEnd: () => {
          try {
            controller?.close();
          } catch {}
          if (!head) reject(new Error("stream ended before head"));
        },
        onError: (msg) => {
          try {
            controller?.error(new Error(msg));
          } catch {}
          if (!head) reject(new Error(msg));
        },
      });
      this.send(encodeJson(1 /* HttpReq */, streamId, { method, path, headers }));
      if (body && body.byteLength) {
        for (const part of chunk(body)) this.send(encodeFrame(2 /* HttpReqBody */, streamId, part));
      }
      this.send(encodeFrame(3 /* HttpReqEnd */, streamId));
    });
  }
  openWs(path, protocols, handlers) {
    const streamId = this.allocId();
    this.wss.set(streamId, handlers);
    this.send(encodeJson(7 /* WsOpen */, streamId, { path, protocols }));
    return {
      sendText: (text) => {
        for (const f of wsMessageFrames(9 /* WsText */, streamId, this.textEncoder.encode(text)))
          this.send(f);
      },
      sendBin: (data) => {
        for (const f of wsMessageFrames(10 /* WsBin */, streamId, data)) this.send(f);
      },
      close: (code, reason) => {
        this.send(encodeJson(11 /* WsClose */, streamId, { code, reason }));
        this.wss.delete(streamId);
      },
    };
  }
  send(frame) {
    if (this.channel.readyState === "open") {
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      this.channel.send(copy.buffer);
    }
  }
  get ready() {
    return this.channel.readyState === "open";
  }
}

// src/web/room-client.ts
var DEFAULT_SIGNAL_URL = "wss://signal.codehost.dev";
var DIAL_FAIL_COOLDOWN_MS = 1e4;

class CodehostRoom {
  peers = [];
  signaling;
  rtcs = new Map();
  tunnels = new Map();
  dialFailedAt = new Map();
  closed = false;
  constructor(opts) {
    this.signaling = new SignalingClient({
      url: opts.signalUrl ?? DEFAULT_SIGNAL_URL,
      token: opts.token,
      role: "viewer",
      onOpen: () => opts.onStatus?.(true),
      onClose: () => opts.onStatus?.(false),
      onPeers: (peers) => {
        this.peers = peers.filter((p) => p.role === "server");
        opts.onPeers?.(this.peers);
      },
      onSignal: (from, data) => void this.rtcs.get(from)?.handleSignal(data),
    });
    this.signaling.connect();
  }
  async fetch(peerId, method, path, init = {}) {
    const tunnel = await this.dial(peerId);
    const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
    return tunnel.fetch(method, path, init.headers ?? {}, body);
  }
  dial(peerId) {
    const existing = this.tunnels.get(peerId);
    if (existing) return existing;
    const failedAt = this.dialFailedAt.get(peerId);
    if (failedAt != null && Date.now() - failedAt < DIAL_FAIL_COOLDOWN_MS) {
      return Promise.reject(new Error("dial failed recently; cooling down"));
    }
    const drop = () => {
      this.tunnels.delete(peerId);
      this.rtcs.get(peerId)?.close();
      this.rtcs.delete(peerId);
    };
    const dialing = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        drop();
        reject(new Error("dial timed out"));
      }, 15000);
      const rtc = new RtcClient({
        sendSignal: (data) => this.signaling.sendSignal(peerId, data),
        onOpen: (channel) => {
          clearTimeout(timer);
          this.dialFailedAt.delete(peerId);
          resolve(new TunnelClient(channel));
        },
        onClose: drop,
        onState: (state) => {
          if (state === "failed" || state === "disconnected") drop();
        },
      });
      this.rtcs.set(peerId, rtc);
      rtc.start().catch((err) => {
        clearTimeout(timer);
        drop();
        reject(err);
      });
    });
    this.tunnels.set(peerId, dialing);
    dialing.catch(() => {
      this.dialFailedAt.set(peerId, Date.now());
      this.tunnels.delete(peerId);
    });
    return dialing;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const rtc of this.rtcs.values()) rtc.close();
    this.rtcs.clear();
    this.tunnels.clear();
    this.signaling.close();
  }
}
function joinRoom(opts) {
  return new CodehostRoom(opts);
}
export { joinRoom, DEFAULT_SIGNAL_URL, CodehostRoom };
