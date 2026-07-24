// Node/Bun WebRTC mesh peer for ONE channel.
//
// Unlike the share bridge (ts/share.ts), a channel is symmetric: there is no
// host, every participant holds a full replica, and BOTH ends of each pairwise
// DataChannel send application traffic (chat ops). But the transport reuses the
// share stack verbatim — the same node-datachannel loader + TURN credentials
// (importRTC / getIceServers, exported from share.ts) and the same E2E sealed
// frames + mandatory bidirectional key-confirmation handshake (lab/ui/e2e.js).
//
// Topology: the signaling Room DO runs in mesh mode (lab/ui/cf/worker.ts) and
// relays offer/answer/candidate between any two peers plus broadcasts
// peer-join/leave. Each pair forms one DataChannel; the peer with the smaller id
// is the offerer (deterministic, avoids offer glare). On connect the two run
// anti-entropy (exchange have-vectors, send the diff); new ops broadcast to all
// confirmed peers, and an op that is new to our replica is re-gossiped to every
// OTHER peer — dedup by id makes that loop-free and convergent even over a
// partial mesh.

import {
  CONFIRM_TIMEOUT_MS,
  FLAG_CONFIRM,
  computeTranscriptHash,
  deriveAuthToken,
  deriveDirKeys,
  open as e2eOpen,
  seal as e2eSeal,
  packEnvelope,
  randomHex,
  unpackEnvelope,
} from "../../lab/ui/e2e.js";
import { getIceServers, importRTC } from "../share.ts";
import { isValidOp, type Op } from "./op.ts";
import { haveVector, opsMissing } from "./store.ts";

const SIGNAL_SUBPROTOCOL = "ay-signal-1";
const HEARTBEAT_MS = 20_000; // keepalive ping to the rendezvous (edge auto-pongs)
const DC_LABEL = "ch";

/** Persistence the peer drives — the daemon supplies a jsonl-backed adapter. */
export interface ChannelPeerStore {
  all(): Promise<Op[]>;
  /** Merge + persist; returns only the ops that were genuinely new. */
  append(ops: Op[]): Promise<Op[]>;
}

export interface ChannelPeerOpts {
  room: string;
  sighost: string;
  /** Secret S (64-hex) — derives the authToken the server sees + the AES keys it never does. */
  s: string;
  store: ChannelPeerStore;
  /** Called for each op newly added to the replica (live tail / UI). */
  onOp?: (op: Op) => void;
  /** Called when the confirmed-peer count changes (presence). */
  onPeers?: (count: number) => void;
  log?: (msg: string) => void;
}

interface Conn {
  peerId: string;
  offerer: boolean;
  pc: any;
  dc: any;
  keyEnc?: CryptoKey;
  keyDec?: CryptoKey;
  th?: Uint8Array;
  localSdp?: string;
  remoteSdp?: string;
  pendingCandidates: any[];
  send: { sendCtr: bigint };
  recv: { lastSeen: bigint };
  myNonce: string;
  confirmedIn: boolean;
  confirmedOut: boolean;
  confirmed: boolean;
  confirmStarted: boolean;
  confirmTimer?: ReturnType<typeof setTimeout>;
  sendChain: Promise<void>;
  recvChain: Promise<void>;
}

export class ChannelPeer {
  private ws?: WebSocket;
  private myId = "";
  private authToken = "";
  private RTCPeerConnection: any;
  private conns = new Map<string, Conn>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private opts: ChannelPeerOpts) {}

  /** Connect to signaling and start meshing. Resolves once the socket is open. */
  async start(): Promise<void> {
    this.RTCPeerConnection = await importRTC();
    this.authToken = await deriveAuthToken(this.opts.s, this.opts.room, this.opts.sighost);
    await this.connectSignaling();
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    // Materialize ids first — dropConn mutates the map we're iterating.
    const ids = Array.from(this.conns.keys());
    for (const id of ids) this.dropConn(id);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  /** Publish a locally-authored op: persist, then broadcast to every confirmed peer. */
  async publish(op: Op): Promise<void> {
    await this.opts.store.append([op]);
    this.broadcast({ t: "op", op });
  }

  private log(msg: string) {
    this.opts.log?.(`[ch:peer] ${msg}`);
  }

  private wsUrl(): string {
    const scheme =
      this.opts.sighost.startsWith("localhost") || this.opts.sighost.startsWith("127.")
        ? "ws"
        : "wss";
    return `${scheme}://${this.opts.sighost}/${this.opts.room}`;
  }

  private async connectSignaling(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(), [SIGNAL_SUBPROTOCOL]);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.send(
          JSON.stringify({
            type: "hello",
            role: "client",
            v: 2,
            mesh: true,
            token: this.authToken,
          }),
        );
        this.heartbeat = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* dropped */
          }
        }, HEARTBEAT_MS);
        resolve();
      };
      ws.onmessage = (e: MessageEvent) =>
        void this.onSignal(String(e.data)).catch((err) => this.log(`signal: ${err}`));
      ws.onclose = () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (!opened) reject(new Error("signaling closed before open"));
        // Reconnect unless we were told to stop (mirrors the browser's resilience).
        if (!this.closed) setTimeout(() => void this.connectSignaling().catch(() => {}), 1000);
      };
      ws.onerror = () => {
        if (!opened) reject(new Error("signaling error before open"));
      };
    });
  }

  private async onSignal(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome": {
        this.myId = String(msg.peer ?? "");
        // Existing peers with a larger id: we are the offerer to them.
        for (const other of (msg.peers as string[] | undefined) ?? []) {
          if (this.myId < other) void this.beginOffer(other);
        }
        this.opts.onPeers?.(this.confirmedCount());
        return;
      }
      case "peer-join": {
        const other = String(msg.peer ?? "");
        if (other && this.myId && this.myId < other) void this.beginOffer(other);
        return;
      }
      case "peer-leave":
        this.dropConn(String(msg.peer ?? ""));
        return;
      case "offer":
        return this.onOffer(String(msg.from ?? ""), msg.sdp, msg.iceServers);
      case "answer":
        return this.onAnswer(String(msg.from ?? ""), msg.sdp);
      case "candidate":
        return this.onCandidate(String(msg.from ?? ""), msg.candidate);
      case "pong":
        return;
    }
  }

  private confirmedCount(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.confirmed) n++;
    return n;
  }

  private newConn(peerId: string, offerer: boolean, pc: any): Conn {
    const c: Conn = {
      peerId,
      offerer,
      pc,
      dc: undefined,
      pendingCandidates: [],
      send: { sendCtr: 0n },
      recv: { lastSeen: -1n },
      myNonce: randomHex(16),
      confirmedIn: false,
      confirmedOut: false,
      confirmed: false,
      confirmStarted: false,
      sendChain: Promise.resolve(),
      recvChain: Promise.resolve(),
    };
    this.conns.set(peerId, c);
    pc.onicecandidate = (e: any) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify({ type: "candidate", to: peerId, candidate: e.candidate }));
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.dropConn(peerId);
    };
    return c;
  }

  private wireDataChannel(c: Conn, dc: any): void {
    c.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = async () => {
      // keyEnc/keyDec are derived once both SDPs are exchanged (below); the open
      // handler waits for them, then opens the confirmation handshake.
      if (!c.keyEnc) return; // keys not ready yet — deriveKeys() re-invokes confirm
      this.beginConfirm(c);
    };
    dc.onmessage = (e: any) => {
      c.recvChain = c.recvChain.then(() => this.onFrame(c, e.data)).catch(() => {});
    };
  }

  private beginConfirm(c: Conn): void {
    // Reachable from both dc.onopen and deriveKeys (whichever completes last) —
    // open the handshake exactly once.
    if (c.confirmStarted) return;
    c.confirmStarted = true;
    this.enqueueSeal(c, FLAG_CONFIRM, { t: "confirm", nonce: c.myNonce });
    c.confirmTimer = setTimeout(() => {
      if (!c.confirmed) this.dropConn(c.peerId);
    }, CONFIRM_TIMEOUT_MS);
  }

  private async beginOffer(peerId: string): Promise<void> {
    if (this.conns.has(peerId) || this.closed) return;
    try {
      const iceServers = await getIceServers();
      const pc = new this.RTCPeerConnection({ iceServers });
      const c = this.newConn(peerId, true, pc);
      const dc = pc.createDataChannel(DC_LABEL);
      this.wireDataChannel(c, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      c.localSdp = pc.localDescription.sdp;
      if (this.conns.get(peerId) !== c || this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "offer", to: peerId, sdp: c.localSdp, iceServers }));
    } catch (err) {
      this.log(`beginOffer ${peerId}: ${err}`);
      this.dropConn(peerId);
    }
  }

  private async onOffer(peerId: string, sdp: string, iceServers: any): Promise<void> {
    if (!peerId || this.conns.has(peerId)) return;
    try {
      const pc = new this.RTCPeerConnection({ iceServers: iceServers ?? (await getIceServers()) });
      const c = this.newConn(peerId, false, pc);
      pc.ondatachannel = (e: any) => this.wireDataChannel(c, e.channel);
      c.remoteSdp = sdp;
      await pc.setRemoteDescription({ type: "offer", sdp });
      this.flushCandidates(c);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      c.localSdp = pc.localDescription.sdp;
      await this.deriveKeys(c);
      if (this.conns.get(peerId) !== c || this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "answer", to: peerId, sdp: c.localSdp }));
    } catch (err) {
      this.log(`onOffer ${peerId}: ${err}`);
      this.dropConn(peerId);
    }
  }

  private async onAnswer(peerId: string, sdp: string): Promise<void> {
    const c = this.conns.get(peerId);
    if (!c || !c.offerer) return;
    try {
      c.remoteSdp = sdp;
      await c.pc.setRemoteDescription({ type: "answer", sdp });
      this.flushCandidates(c);
      await this.deriveKeys(c);
    } catch (err) {
      this.log(`onAnswer ${peerId}: ${err}`);
      this.dropConn(peerId);
    }
  }

  private onCandidate(peerId: string, candidate: any): void {
    const c = this.conns.get(peerId);
    if (!c || !candidate) return;
    // Buffer until the remote description is set, else addIceCandidate throws.
    if (!c.remoteSdp) {
      c.pendingCandidates.push(candidate);
      return;
    }
    c.pc.addIceCandidate(candidate).catch(() => {});
  }

  private flushCandidates(c: Conn): void {
    for (const cand of c.pendingCandidates.splice(0)) c.pc.addIceCandidate(cand).catch(() => {});
  }

  /** Derive the directional AES keys once both SDPs are known, then confirm. */
  private async deriveKeys(c: Conn): Promise<void> {
    if (c.keyEnc || !c.localSdp || !c.remoteSdp) return;
    // Offerer: local=offer, remote=answer. Answerer: remote=offer, local=answer.
    const [offerSdp, answerSdp] = c.offerer ? [c.localSdp, c.remoteSdp] : [c.remoteSdp, c.localSdp];
    c.th = await computeTranscriptHash(offerSdp, answerSdp);
    const { keyH2C, keyC2H } = await deriveDirKeys(this.opts.s, c.th);
    // The offerer takes the host->client key to encrypt (client->host to decrypt);
    // the answerer takes the mirror. Either way both directions are full-duplex.
    c.keyEnc = c.offerer ? keyH2C : keyC2H;
    c.keyDec = c.offerer ? keyC2H : keyH2C;
    // If the DataChannel already opened before keys were ready, confirm now.
    if (c.dc && c.dc.readyState === "open") this.beginConfirm(c);
  }

  private enqueueSeal(c: Conn, flags: number, obj: object): Promise<void> {
    c.sendChain = c.sendChain.then(async () => {
      if (!c.dc || c.dc.readyState !== "open" || !c.keyEnc || !c.th) return;
      let frame: ArrayBuffer;
      try {
        frame = await e2eSeal(c.keyEnc, c.send, flags, c.th, packEnvelope(obj));
      } catch {
        this.dropConn(c.peerId); // counter overflow — fail closed
        return;
      }
      try {
        c.dc.send(frame);
      } catch {
        /* peer vanished mid-send */
      }
    });
    return c.sendChain;
  }

  private async onFrame(c: Conn, data: any): Promise<void> {
    if (!this.conns.has(c.peerId)) return;
    if (typeof data === "string" || !c.keyDec || !c.th) return this.dropConn(c.peerId);
    let env: any;
    try {
      const { plaintext } = await e2eOpen(c.keyDec, data, c.th, c.recv);
      env = unpackEnvelope(plaintext);
    } catch {
      return this.dropConn(c.peerId); // bad tag/replay/AAD
    }
    if (!c.confirmed) {
      if (!env || env.t !== "confirm") return this.dropConn(c.peerId);
      if (typeof env.nonce === "string" && !c.confirmedOut) {
        await this.enqueueSeal(c, FLAG_CONFIRM, {
          t: "confirm",
          nonce: c.myNonce,
          echo: env.nonce,
        });
        c.confirmedOut = true;
      }
      if (env.echo && env.echo === c.myNonce) c.confirmedIn = true;
      if (c.confirmedIn && c.confirmedOut) {
        c.confirmed = true;
        if (c.confirmTimer) clearTimeout(c.confirmTimer);
        this.opts.onPeers?.(this.confirmedCount());
        void this.startSync(c); // anti-entropy once the channel is trusted
      }
      return;
    }
    if (!env || env.t === "confirm") return; // stray confirm — ignore
    await this.onEnvelope(c, env);
  }

  /** Kick off anti-entropy: tell the peer what we hold; it replies with the diff. */
  private async startSync(c: Conn): Promise<void> {
    const ops = await this.opts.store.all();
    this.enqueueSeal(c, 0, { t: "sync-req", have: haveVector(ops) });
  }

  private async onEnvelope(c: Conn, env: any): Promise<void> {
    if (env.t === "sync-req" && env.have && typeof env.have === "object") {
      const missing = opsMissing(await this.opts.store.all(), env.have);
      this.enqueueSeal(c, 0, { t: "sync-res", ops: missing });
      return;
    }
    if (env.t === "sync-res" && Array.isArray(env.ops)) {
      await this.ingest(env.ops.filter(isValidOp), c.peerId);
      return;
    }
    if (env.t === "op" && isValidOp(env.op)) {
      await this.ingest([env.op], c.peerId);
      return;
    }
  }

  /** Merge inbound ops; surface + re-gossip only the ones new to our replica. */
  private async ingest(ops: Op[], fromPeer: string): Promise<void> {
    if (ops.length === 0) return;
    const added = await this.opts.store.append(ops);
    for (const op of added) this.opts.onOp?.(op);
    // Gossip: forward genuinely-new ops to every OTHER confirmed peer. Dedup-by-id
    // upstream makes this loop-free and terminating even on a partial mesh.
    for (const op of added) this.broadcast({ t: "op", op }, fromPeer);
  }

  private broadcast(obj: { t: string; [k: string]: unknown }, exceptPeer?: string): void {
    for (const c of this.conns.values()) {
      if (!c.confirmed || c.peerId === exceptPeer) continue;
      this.enqueueSeal(c, 0, obj);
    }
  }

  private dropConn(peerId: string): void {
    const c = this.conns.get(peerId);
    if (!c) return;
    if (c.confirmTimer) clearTimeout(c.confirmTimer);
    try {
      c.pc.close();
    } catch {
      /* already closed */
    }
    this.conns.delete(peerId);
    this.opts.onPeers?.(this.confirmedCount());
  }
}
