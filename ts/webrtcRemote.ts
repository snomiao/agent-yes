// CLI WebRTC remote: dial an `ay serve --share` room as a CLIENT peer over an
// end-to-end-encrypted WebRTC DataChannel, then expose it as a local HTTP
// endpoint (the "bridge") so every existing fetch-based remote command — ls,
// send, status, and streaming `tail -f` — works unchanged against a remote host
// that has no reachable HTTP port.
//
// The host side lives in ts/share.ts; this is its inverse. The host offers and
// responds; we answer and request. Crypto is reused verbatim from lab/ui/e2e.js
// so the AES-GCM / transcript-hash handshake is byte-identical to the browser
// console and the host.
import { RTCPeerConnection } from "node-datachannel/polyfill";
import {
  deriveAuthToken,
  deriveDirKeys,
  computeTranscriptHash,
  seal as e2eSeal,
  open as e2eOpen,
  packEnvelope,
  unpackEnvelope,
  randomHex,
  FLAG_CONFIRM,
} from "../lab/ui/e2e.js";
import { SIGNAL_SUBPROTOCOL as SUB, parseWebrtcLink, type WebrtcLink } from "./webrtcLink.ts";

export { isWebrtcSpec, parseWebrtcLink } from "./webrtcLink.ts";
export type { WebrtcLink } from "./webrtcLink.ts";

const CONNECT_TIMEOUT_MS = 25_000;

interface PendingReq {
  onRes: (status: number, ct: string) => void;
  onData: (chunk: string) => void;
  onEnd: (error?: string) => void;
}

/** A live, key-confirmed WebRTC connection to a single share room. */
class WebRtcConn {
  private ws: WebSocket;
  private pc: any = null;
  private dc: any = null;
  private readonly send = { sendCtr: 0n };
  private readonly recv = { lastSeen: -1n };
  private keyC2H: CryptoKey | null = null; // client encrypts host-bound frames
  private keyH2C: CryptoKey | null = null; // client decrypts host-sent frames
  private th: Uint8Array | null = null;
  private hostPeer: string | null = null;
  private readonly myNonce = randomHex(16);
  private confirmedIn = false;
  private confirmedOut = false;
  private confirmed = false;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private idCounter = 0;
  private readonly pending = new Map<string, PendingReq>();

  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;

  constructor(private readonly link: WebrtcLink) {
    this.ready = new Promise<void>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    const timer = setTimeout(
      () => this.rejectReady(new Error(`WebRTC connect timeout after ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    );
    this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    this.ws = this.dial();
  }

  private dial(): WebSocket {
    const { room, host } = this.link;
    const ws = new WebSocket(`wss://${host}/${room}`, [SUB]);
    ws.onopen = async () => {
      const authToken = await deriveAuthToken(this.link.s, room, host);
      ws.send(JSON.stringify({ type: "hello", role: "client", v: 2, token: authToken }));
    };
    ws.onerror = (e: any) =>
      this.rejectReady(new Error(`signaling error: ${String(e?.message ?? e)}`));
    ws.onclose = () => {
      if (!this.confirmed) this.rejectReady(new Error("signaling closed before connect"));
    };
    ws.onmessage = (ev: any) => void this.onSignal(ev);
    return ws;
  }

  private async onSignal(ev: any): Promise<void> {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : await ev.data.text());
    if (m.type === "offer") {
      this.hostPeer = m.from;
      const pc = new RTCPeerConnection({ iceServers: m.iceServers || [] });
      this.pc = pc;
      pc.onicecandidate = (e: any) => {
        if (e.candidate)
          this.ws.send(
            JSON.stringify({ type: "candidate", to: this.hostPeer, candidate: e.candidate }),
          );
      };
      pc.ondatachannel = (e: any) => {
        const dc = e.channel;
        this.dc = dc;
        dc.binaryType = "arraybuffer";
        dc.onopen = () => this.enqueueSeal(FLAG_CONFIRM, { t: "confirm", nonce: this.myNonce });
        dc.onmessage = (ev2: any) => {
          this.recvChain = this.recvChain.then(() => this.onFrame(ev2.data)).catch(() => {});
        };
      };
      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.th = await computeTranscriptHash(m.sdp, pc.localDescription.sdp);
      const keys = await deriveDirKeys(this.link.s, this.th);
      this.keyC2H = keys.keyC2H;
      this.keyH2C = keys.keyH2C;
      this.ws.send(
        JSON.stringify({ type: "answer", to: this.hostPeer, sdp: pc.localDescription.sdp }),
      );
    } else if (m.type === "candidate" && this.pc) {
      await this.pc.addIceCandidate(m.candidate).catch(() => {});
    }
  }

  private enqueueSeal(flags: number, obj: object): Promise<void> {
    this.sendChain = this.sendChain.then(async () => {
      if (!this.dc || this.dc.readyState !== "open" || !this.keyC2H || !this.th) return;
      const frame = await e2eSeal(this.keyC2H, this.send, flags, this.th, packEnvelope(obj));
      try {
        this.dc.send(frame);
      } catch {}
    });
    return this.sendChain;
  }

  private async onFrame(data: any): Promise<void> {
    if (typeof data === "string" || !this.keyH2C || !this.th) return;
    let env: any;
    try {
      const { plaintext } = await e2eOpen(this.keyH2C, data, this.th, this.recv);
      env = unpackEnvelope(plaintext);
    } catch {
      return; // drop undecryptable frames
    }
    if (!this.confirmed) {
      if (!env || env.t !== "confirm") return;
      if (typeof env.nonce === "string" && !this.confirmedOut) {
        await this.enqueueSeal(FLAG_CONFIRM, {
          t: "confirm",
          nonce: this.myNonce,
          echo: env.nonce,
        });
        this.confirmedOut = true;
      }
      if (env.echo && env.echo === this.myNonce) this.confirmedIn = true;
      if (this.confirmedIn && this.confirmedOut) {
        this.confirmed = true;
        this.resolveReady();
      }
      return;
    }
    if (!env || env.t === "confirm") return;
    const p = this.pending.get(env.id);
    if (!p) return;
    if (env.t === "res") p.onRes(env.status, env.ct);
    else if (env.t === "data") p.onData(env.chunk);
    else if (env.t === "end") p.onEnd(env.error);
  }

  /**
   * Issue one request over the channel. Resolves once the response head (status,
   * content-type) arrives; the body is a ReadableStream fed by `data` frames as
   * they land, so streaming endpoints (SSE `tail`) flow without buffering.
   */
  request(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; ct: string; stream: ReadableStream<Uint8Array> }> {
    const id = String(++this.idCounter);
    return new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const enc = new TextEncoder();
      let head = false;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        cancel: () => {
          this.pending.delete(id);
          void this.enqueueSeal(0, { t: "abort", id });
        },
      });
      this.pending.set(id, {
        onRes: (status, ct) => {
          if (!head) {
            head = true;
            resolve({ status, ct, stream });
          }
        },
        onData: (chunk) => {
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {}
        },
        onEnd: (error) => {
          this.pending.delete(id);
          if (error) {
            if (!head) {
              head = true;
              reject(new Error(error));
            }
            try {
              controller.error(new Error(error));
            } catch {}
          } else {
            try {
              controller.close();
            } catch {}
          }
        },
      });
      void this.enqueueSeal(0, { t: "req", id, method, path, body });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
    try {
      this.pc?.close();
    } catch {}
  }
}

export interface WebrtcBridge {
  baseUrl: string;
  token: string;
  close: () => void;
}

/**
 * Connect to a share room and start a local HTTP server that forwards every
 * request over the encrypted DataChannel. Returns the loopback base URL the
 * existing remote commands can `fetch()` against. The process owns teardown:
 * `ay` subcommands `process.exit()` when done, which closes the socket/peer.
 */
export async function startWebrtcBridge(link: string): Promise<WebrtcBridge> {
  const parsed = parseWebrtcLink(link);
  if (!parsed) throw new Error(`not a WebRTC share link: ${link}`);
  const conn = new WebRtcConn(parsed);
  await conn.ready;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0, // streaming tail can idle indefinitely between log lines
    async fetch(req: Request) {
      const u = new URL(req.url);
      const pathWithQuery = u.pathname + u.search;
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? await req.text() : undefined;
      try {
        const { status, ct, stream } = await conn.request(req.method, pathWithQuery, body);
        return new Response(stream, { status, headers: ct ? { "content-type": ct } : {} });
      } catch (e: any) {
        return new Response(String(e?.message ?? e), { status: 502 });
      }
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "webrtc", // auth is the E2E secret; the host injects its own bearer
    close: () => {
      try {
        server.stop(true);
      } catch {}
      conn.close();
    },
  };
}
