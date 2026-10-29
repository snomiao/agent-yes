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
import { hostname } from "os";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { probeSignalingHost, signalingFailureHint } from "./signalingHint.ts";
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
import {
  ConnectError,
  closeError,
  describeConnectFailure,
  memberOf,
  mergeMemberLs,
  otherMembers,
  reduceSignal,
  socketError,
  splitMemberKeyword,
  timeoutError,
  type RoomMember,
  type SignalState,
} from "./webrtcSignal.ts";

export { isWebrtcSpec, parseWebrtcLink } from "./webrtcLink.ts";
export type { WebrtcLink } from "./webrtcLink.ts";

const CONNECT_TIMEOUT_MS = 25_000;
// How long to wait for a direct data channel before using the signaling relay
// (only when both ends opted in with AGENT_YES_SIGNAL_RELAY=1).
const RELAY_AFTER_MS = 8_000;

const signalRelayEnabled = () =>
  ["1", "true", "yes"].includes((process.env.AGENT_YES_SIGNAL_RELAY ?? "").trim());

interface PendingReq {
  onRes: (status: number, ct: string) => void;
  onData: (chunk: string) => void;
  onEnd: (error?: string) => void;
}

/** Where a member connection sends its signaling frames (addressed to it). */
type SignalPort = (msg: Record<string, unknown>) => void;

/**
 * A live, key-confirmed WebRTC connection to one host (member) of a share
 * room. Its signaling travels over the room's shared socket (RoomSignal).
 */
class HostConn {
  private pc: any = null;
  private dc: any = null;
  private readonly send = { sendCtr: 0n };
  private readonly recv = { lastSeen: -1n };
  private keyC2H: CryptoKey | null = null; // client encrypts host-bound frames
  private keyH2C: CryptoKey | null = null; // client decrypts host-sent frames
  private th: Uint8Array | null = null;
  private readonly myNonce = randomHex(16);
  private confirmedIn = false;
  private confirmedOut = false;
  private confirmed = false;
  // Join progress, so a failure names the phase it happened in (webrtcSignal.ts).
  readonly sig: SignalState = { opened: true, offered: false, confirmed: false };
  // Host candidates that trickled in before the offer; applied once the peer exists.
  private earlyCandidates: any[] = [];
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private idCounter = 0;
  private readonly pending = new Map<string, PendingReq>();

  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  rejectReady!: (e: Error) => void;

  constructor(
    private readonly link: WebrtcLink,
    readonly member: RoomMember,
    private readonly signal: SignalPort,
  ) {
    this.ready = new Promise<void>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.then(
      () => (this.state = "ok"),
      (e) => ((this.state = "failed"), (this.error = e)),
    );
    const timer = setTimeout(
      () => this.rejectReady(timeoutError(this.sig, CONNECT_TIMEOUT_MS)),
      CONNECT_TIMEOUT_MS,
    );
    this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }

  get isConfirmed(): boolean {
    return this.confirmed;
  }

  /** Frames go over the signaling socket (see RelayState in rs/src/serve/share.rs). */
  private relayed = false;

  /** A sealed frame the host relayed over signaling. */
  onRelay(data: string): void {
    if (!this.relayed) return;
    const bytes = Buffer.from(data, "base64");
    this.recvChain = this.recvChain.then(() => this.onFrame(bytes)).catch(() => {});
  }

  state: "pending" | "ok" | "failed" = "pending";
  error: Error | null = null;

  async onCandidate(candidate: any): Promise<void> {
    if (!this.pc) this.earlyCandidates.push(candidate);
    else await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  async onOffer(sdp: string, iceServers: any[], relay = false): Promise<void> {
    if (this.sig.offered) return; // a repeat offer from the same host
    this.sig.offered = true;
    const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    this.pc = pc;
    // Our candidates go out only after the answer: setLocalDescription below
    // fires onicecandidate before the answer is sent, and a host that gets a
    // candidate before the answer cannot add it (ayrs up to 1.302.x dropped
    // the whole peer over it).
    let held: any[] | null = [];
    const sendCandidate = (candidate: any) => this.signal({ type: "candidate", candidate });
    pc.onicecandidate = (e: any) => {
      if (!e.candidate) return;
      if (held) held.push(e.candidate);
      else sendCandidate(e.candidate);
    };
    pc.ondatachannel = (e: any) => {
      const dc = e.channel;
      this.dc = dc;
      dc.binaryType = "arraybuffer";
      dc.onopen = () => {
        if (!this.relayed)
          void this.enqueueSeal(FLAG_CONFIRM, { t: "confirm", nonce: this.myNonce });
      };
      dc.onmessage = (ev2: any) => {
        this.recvChain = this.recvChain.then(() => this.onFrame(ev2.data)).catch(() => {});
      };
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    // Candidates the host trickled before its offer (the Rust host does) are
    // only valid once the remote description is set — flush them now, or the
    // host's LAN routes are lost and the handshake limps to a timeout.
    const early = this.earlyCandidates;
    this.earlyCandidates = [];
    for (const c of early) await pc.addIceCandidate(c).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.th = await computeTranscriptHash(sdp, pc.localDescription.sdp);
    const keys = await deriveDirKeys(this.link.s, this.th);
    this.keyC2H = keys.keyC2H;
    this.keyH2C = keys.keyH2C;
    this.signal({ type: "answer", sdp: pc.localDescription.sdp });
    const queued = held;
    held = null;
    for (const c of queued) sendCandidate(c);
    // No direct path yet: fall back to the signaling relay, when both ends allow it.
    if (relay && signalRelayEnabled())
      setTimeout(() => {
        if (this.confirmed || this.dc?.readyState === "open") return;
        process.stderr.write(
          `[webrtc] no direct path to ${this.member.name || this.member.peer}; using the signaling relay\n`,
        );
        this.relayed = true;
        void this.enqueueSeal(FLAG_CONFIRM, { t: "confirm", nonce: this.myNonce });
      }, RELAY_AFTER_MS).unref?.();
  }

  private enqueueSeal(flags: number, obj: object): Promise<void> {
    this.sendChain = this.sendChain.then(async () => {
      if (!this.keyC2H || !this.th) return;
      if (!this.relayed && (!this.dc || this.dc.readyState !== "open")) return;
      const frame = await e2eSeal(this.keyC2H, this.send, flags, this.th, packEnvelope(obj));
      if (this.relayed) {
        this.signal({ type: "relay", data: Buffer.from(frame).toString("base64") });
        return;
      }
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
        this.sig.confirmed = true;
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
      this.pc?.close();
    } catch {}
  }
}

/**
 * The room's signaling socket, shared by one HostConn per member. A room can
 * have several hosts (lab/ui/cf/roomRouting.ts); the welcome lists them, and
 * each one offers to us on its own. An older signaling server lists nobody and
 * has one host, "host".
 */
class RoomSignal {
  private readonly ws: WebSocket;
  private readonly sig: SignalState = { opened: false, offered: false, confirmed: false };
  /** Members the welcome named; null until it arrives or when the server predates rooms with several hosts. */
  private roster: RoomMember[] | null = null;
  readonly conns = new Map<string, HostConn>();
  private settled = false;
  /** Resolves with the members that connected, once every one has connected or failed. */
  readonly ready: Promise<HostConn[]>;
  private resolveReady!: (c: HostConn[]) => void;
  private rejectReady!: (e: Error) => void;

  constructor(
    private readonly link: WebrtcLink,
    /** Members to skip (this machine's own host). */
    private readonly skip: (m: RoomMember) => boolean,
  ) {
    this.ready = new Promise<HostConn[]>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    const timer = setTimeout(
      () => this.fail(timeoutError(this.sig, CONNECT_TIMEOUT_MS)),
      CONNECT_TIMEOUT_MS + 1000,
    );
    this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    this.ws = this.dial();
  }

  private fail(e: Error): void {
    if (this.settled) return;
    // Members that already connected are still worth using.
    if (this.connected().length) return this.settle();
    this.settled = true;
    for (const c of this.conns.values()) c.rejectReady(e);
    this.rejectReady(e);
  }

  private connected(): HostConn[] {
    return [...this.conns.values()].filter((c) => c.isConfirmed);
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveReady(this.connected());
  }

  /** Settle once every member we expect has connected or failed. */
  private check(): void {
    if (this.settled || !this.roster) return;
    const expected = this.roster.filter((m) => !this.skip(m));
    const conns = expected.map((m) => this.conns.get(m.peer));
    if (!expected.length || conns.some((c) => !c || c.state === "pending")) return;
    if (this.connected().length) return this.settle();
    this.fail(conns.find((c) => c!.error)?.error ?? new Error("no host connected"));
  }

  private dial(): WebSocket {
    const { room, host } = this.link;
    // A local signaling server (wrangler dev) speaks plain ws, like ayrs's.
    const scheme = /^(localhost|127\.)/.test(host) ? "ws" : "wss";
    const ws = new WebSocket(`${scheme}://${host}/${room}`, [SUB]);
    ws.onopen = async () => {
      this.sig.opened = true;
      const authToken = await deriveAuthToken(this.link.s, room, host);
      ws.send(
        JSON.stringify({ type: "hello", role: "client", v: 2, token: authToken, multi: true }),
      );
    };
    ws.onerror = (e: any) => this.fail(socketError(this.sig, String(e?.message ?? e)));
    ws.onclose = (ev: any) => {
      // The close code and reason are the server's own diagnosis (1008 "forbidden",
      // "room not open"); dropping them left only "closed before connect".
      this.fail(closeError(this.sig, Number(ev?.code ?? 0), String(ev?.reason ?? "")));
    };
    ws.onmessage = (ev: any) => void this.onSignal(ev);
    return ws;
  }

  private memberConn(peer: string): HostConn | null {
    let c = this.conns.get(peer);
    if (c) return c;
    if (this.settled) return null; // a member that arrived after we chose
    const member = this.roster?.find((m) => m.peer === peer) ?? { peer, name: "" };
    if (this.skip(member)) return null;
    c = new HostConn(this.link, member, (msg) =>
      this.ws.send(JSON.stringify({ ...msg, to: peer })),
    );
    this.conns.set(peer, c);
    c.ready.then(
      () => this.check(),
      () => this.check(),
    );
    // An older server has no roster: its one host is all there is.
    if (!this.roster)
      c.ready.then(
        () => this.settle(),
        (e) => this.fail(e),
      );
    return c;
  }

  private async onSignal(ev: any): Promise<void> {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : await ev.data.text());
    if (m?.type === "welcome") {
      if (Array.isArray(m.hosts)) {
        this.roster = m.hosts
          .filter((h: any) => h && typeof h.peer === "string")
          .map((h: any) => ({ peer: h.peer, name: String(h.name ?? "") }));
        // Ask each member we want for a connection; it then offers.
        for (const h of this.roster!) this.join(h);
      }
      const action = reduceSignal(this.sig, m);
      if (action.kind === "fail") this.fail(action.error);
      return;
    }
    if (m?.type === "host-join" && this.roster && typeof m.peer === "string") {
      if (!this.roster.some((h) => h.peer === m.peer)) {
        const h = { peer: m.peer, name: String(m.name ?? "") };
        this.roster.push(h);
        this.join(h);
      }
      return;
    }
    if (m?.type === "host-leave" && this.roster && typeof m.peer === "string") {
      this.roster = this.roster.filter((h) => h.peer !== m.peer);
      this.conns.get(m.peer)?.rejectReady(new ConnectError("no-host", "the host left the room"));
      this.check();
      return;
    }
    if (m?.type === "offer") {
      this.sig.offered = true;
      await this.memberConn(memberOf(m))?.onOffer(m.sdp, m.iceServers || [], m.relay === true);
    } else if (m?.type === "candidate") {
      await this.memberConn(memberOf(m))?.onCandidate(m.candidate);
    } else if (m?.type === "relay" && typeof m.data === "string") {
      this.conns.get(memberOf(m))?.onRelay(m.data);
    }
  }

  private join(m: RoomMember): void {
    if (this.settled || this.skip(m) || this.conns.has(m.peer)) return;
    this.ws.send(JSON.stringify({ type: "join", to: m.peer }));
  }

  /** Every member the room listed (or the one that offered, on an older server). */
  members(): RoomMember[] {
    return this.roster ?? [...this.conns.values()].map((c) => c.member);
  }

  /** Drop the members we will not use, so their hosts can free the peer. */
  keepOnly(keep: HostConn[]): void {
    for (const [peer, c] of this.conns)
      if (!keep.includes(c)) {
        c.close();
        this.conns.delete(peer);
      }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
    for (const c of this.conns.values()) c.close();
  }
}

export interface WebrtcBridge {
  baseUrl: string;
  token: string;
  close: () => void;
  /** The room's members (one, for a room with a single host). */
  members: RoomMember[];
  /** The keyword left once a leading `<member>:` picked the member. */
  keyword?: string;
}

/** This machine's member name, as ayrs reports it (rs/src/serve/room_member.rs). */
function selfMemberName(): string {
  const n = process.env.AY_NAME?.trim();
  return n || hostname();
}

async function readJson(conn: HostConn, path: string): Promise<unknown> {
  const { status, stream } = await conn.request("GET", path);
  const text = await new Response(stream).text();
  if (status < 200 || status >= 300) throw new Error(`${status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * The member a `<alias>:<keyword>` reference means in a room with several
 * hosts: the one named by a leading `<member>:`, else the only one with an
 * agent matching the keyword. Throws with the candidates when that is not
 * exactly one.
 */
async function chooseMember(
  conns: HostConn[],
  keyword: string,
): Promise<{ conn: HostConn; keyword: string | undefined }> {
  const members = conns.map((c) => c.member);
  const named = splitMemberKeyword(keyword, members);
  if (named) return { conn: conns.find((c) => c.member === named.member)!, keyword: named.keyword };
  const q = `/api/ls?all=1&keyword=${encodeURIComponent(keyword)}`;
  const hits = await Promise.all(
    conns.map(async (c) => {
      const rows = await readJson(c, q).catch(() => []);
      return Array.isArray(rows) && rows.length ? c : null;
    }),
  );
  const found = hits.filter((c): c is HostConn => !!c);
  if (found.length === 1) return { conn: found[0]!, keyword };
  const names = (found.length ? found : conns).map((c) => c.member.name || c.member.peer);
  throw new Error(
    found.length
      ? `"${keyword}" matches agents on several hosts in this room: ${names.join(", ")} — ` +
          `say which as <remote>:<host>:${keyword}`
      : `no agent matches "${keyword}" on any host in this room (${names.join(", ")})`,
  );
}

/**
 * Connect to a share room and start a local HTTP server that forwards every
 * request over the encrypted DataChannel. Returns the loopback base URL the
 * existing remote commands can `fetch()` against. The process owns teardown:
 * `ay` subcommands `process.exit()` when done, which closes the socket/peer.
 *
 * A room with several hosts: with a `keyword`, the bridge talks to the one
 * member it means (see chooseMember); without one, `GET /api/ls` lists every
 * member's agents (each row tagged `member`) and anything else is refused
 * with a hint to name the member.
 */
export async function startWebrtcBridge(
  link: string,
  opts: { keyword?: string } = {},
): Promise<WebrtcBridge> {
  const parsed = parseWebrtcLink(link);
  if (!parsed) throw new Error(`not a WebRTC share link: ${link}`);
  const self = selfMemberName();
  // Skip this machine's own member, but only while others exist (decided
  // per member as offers arrive, so a one-host room still works from itself).
  const room: RoomSignal = new RoomSignal(
    parsed,
    (m) =>
      m.name === self &&
      otherMembers(room?.members?.() ?? [m], self).every((o) => o.peer !== m.peer),
  );
  let conns: HostConn[];
  try {
    conns = await room.ready;
  } catch (e) {
    room.close();
    // Every remote command routes through here, so this is the one place a
    // signaling failure has to become actionable. The failure names its phase
    // (webrtcSignal.ts); only a socket that never opened gets the HTTPS-probe
    // sandbox/proxy hint (signalingHint.ts) — every later phase proves the
    // WebSocket upgrade worked, so that hint would be a misdiagnosis there.
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(
      await describeConnectFailure(err, parsed.host, async (cause) =>
        signalingFailureHint(cause, await probeSignalingHost(parsed.host), parsed.host),
      ),
    );
  }

  let keyword = opts.keyword;
  if (conns.length > 1 && keyword) {
    try {
      const pick = await chooseMember(conns, keyword);
      conns = [pick.conn];
      keyword = pick.keyword;
    } catch (e) {
      room.close();
      throw e;
    }
  }
  room.keepOnly(conns);
  const members = room.members();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0, // streaming tail can idle indefinitely between log lines
    async fetch(req: Request) {
      const u = new URL(req.url);
      const pathWithQuery = u.pathname + u.search;
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const body = hasBody ? await req.text() : undefined;
      if (conns.length > 1) {
        if (req.method === "GET" && u.pathname === "/api/ls") {
          const parts = await Promise.all(
            conns.map(async (c) => ({
              member: c.member,
              rows: await readJson(c, pathWithQuery).catch(() => []),
            })),
          );
          return Response.json(mergeMemberLs(parts));
        }
        const names = conns.map((c) => c.member.name || c.member.peer).join(", ");
        return new Response(
          `this room has several hosts (${names}); address one as <remote>:<host>:<agent>`,
          { status: 409 },
        );
      }
      try {
        const { status, ct, stream } = await conns[0]!.request(req.method, pathWithQuery, body);
        return new Response(stream, { status, headers: ct ? { "content-type": ct } : {} });
      } catch (e: any) {
        return new Response(String(e?.message ?? e), { status: 502 });
      }
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "webrtc", // auth is the E2E secret; the host injects its own bearer
    members,
    keyword,
    close: () => {
      try {
        server.stop(true);
      } catch {}
      room.close();
    },
  };
}
