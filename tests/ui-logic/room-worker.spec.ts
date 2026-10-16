import { beforeAll, describe, expect, it } from "vitest";

// The signaling room's routing for a STAR room with several hosts (one per
// machine, `ay share --room`), driven directly through the Durable Object's
// message/close hooks with fake sockets. What must hold:
//   - every host has a unique id and a `from` tag on what it sends;
//   - a legacy client (no `host`, no `watch`) still works like the single-host
//     days: every host is told of its join, un-addressed frames reach every host;
//   - a bound client reaches only its host; a watcher is never offered to;
//   - clients learn the roster (welcome.hosts) and host-join/host-leave.

type Attach = Record<string, unknown>;

class FakeWS {
  sent: any[] = [];
  closed: [number, string] | null = null;
  private attachment: Attach = {};
  serializeAttachment(a: Attach) {
    this.attachment = a;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
  }
  /** Frames of one type, in order. */
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

class FakeState {
  sockets: FakeWS[] = [];
  storage = {
    map: new Map<string, unknown>(),
    async get<T>(k: string) {
      return this.map.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      this.map.set(k, v);
    },
  };
  getWebSockets() {
    return this.sockets;
  }
  acceptWebSocket(ws: FakeWS) {
    this.sockets.push(ws);
  }
  setWebSocketAutoResponse() {}
}

let RoomCtor: any;
beforeAll(async () => {
  // Cloudflare-only globals the module touches at construction time.
  (globalThis as any).WebSocketRequestResponsePair = class {
    constructor(
      public req: string,
      public res: string,
    ) {}
  };
  RoomCtor = (await import("../../lab/ui/cf/worker.ts")).Room;
});

async function room() {
  const state = new FakeState();
  const r = new RoomCtor(state);
  const join = async (hello: Record<string, unknown>) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ authed: false });
    state.sockets.push(ws);
    await r.webSocketMessage(ws, JSON.stringify({ type: "hello", v: 2, token: "t", ...hello }));
    return ws;
  };
  const leave = (ws: FakeWS) => {
    r.webSocketClose(ws);
    state.sockets = state.sockets.filter((s) => s !== ws);
  };
  const say = (ws: FakeWS, frame: Record<string, unknown>) =>
    r.webSocketMessage(ws, JSON.stringify(frame));
  return { r, state, join, leave, say };
}

const peerOf = (ws: FakeWS) => ws.of("welcome")[0].peer as string;

describe("star room with several hosts", () => {
  it("gives hosts unique ids and tells a client the roster", async () => {
    const { join } = await room();
    const h1 = await join({ role: "host", meta: { label: "alice@box-a" } });
    const h2 = await join({ role: "host" });
    expect(peerOf(h1)).toMatch(/^h-[0-9a-f]{8}$/);
    expect(peerOf(h2)).toMatch(/^h-[0-9a-f]{8}$/);
    expect(peerOf(h1)).not.toBe(peerOf(h2));
    // The second host's arrival is announced to clients only (none yet).
    expect(h1.of("host-join")).toEqual([]);

    const c = await join({ role: "client" });
    const w = c.of("welcome")[0];
    expect(w.hostPresent).toBe(true);
    expect(w.hosts).toEqual([{ peer: peerOf(h1), label: "alice@box-a" }, { peer: peerOf(h2) }]);
  });

  it("fast-fails a client when no host is left, and never lists hosts to a host", async () => {
    const { join, leave } = await room();
    const h = await join({ role: "host" });
    expect(h.of("welcome")[0].hosts).toBeUndefined();
    leave(h);
    const c = await join({ role: "client" });
    expect(c.of("welcome")[0]).toMatchObject({ hostPresent: false, hosts: [] });
  });

  it("legacy client: join reaches every host, un-addressed frames reach every host, addressed frames one", async () => {
    const { join, say } = await room();
    const h1 = await join({ role: "host" });
    const h2 = await join({ role: "host" });
    const c = await join({ role: "client" });
    const cid = peerOf(c);
    expect(h1.of("peer-join")).toEqual([{ type: "peer-join", peer: cid }]);
    expect(h2.of("peer-join")).toEqual([{ type: "peer-join", peer: cid }]);

    await say(c, { type: "answer", sdp: "a" });
    expect(h1.of("answer")).toEqual([{ type: "answer", sdp: "a", from: cid }]);
    expect(h2.of("answer")).toEqual([{ type: "answer", sdp: "a", from: cid }]);

    await say(c, { type: "candidate", to: peerOf(h2), candidate: {} });
    expect(h1.of("candidate")).toEqual([]);
    expect(h2.of("candidate")).toEqual([
      { type: "candidate", to: peerOf(h2), candidate: {}, from: cid },
    ]);
  });

  it("tags host → client frames with the host's id so the client can address it back", async () => {
    const { join, say } = await room();
    const h = await join({ role: "host" });
    const c = await join({ role: "client" });
    await say(h, { type: "offer", to: peerOf(c), sdp: "o" });
    expect(c.of("offer")).toEqual([{ type: "offer", to: peerOf(c), sdp: "o", from: peerOf(h) }]);
  });

  it("bound client: only its host hears the join and its un-addressed frames; it is re-announced when that host returns", async () => {
    const { join, say, leave } = await room();
    const h1 = await join({ role: "host" });
    const h2 = await join({ role: "host" });
    const c = await join({ role: "client", host: peerOf(h2) });
    expect(h1.of("peer-join")).toEqual([]);
    expect(h2.of("peer-join")).toEqual([{ type: "peer-join", peer: peerOf(c) }]);
    await say(c, { type: "answer", sdp: "a" });
    expect(h1.of("answer")).toEqual([]);
    expect(h2.of("answer")).toHaveLength(1);

    // h2 drops and comes back under a new id: the client bound to the OLD id is
    // not replayed (it will re-bind from host-join); a client bound to the new
    // id, waiting for it, is.
    leave(h2);
    expect(c.of("host-leave")).toEqual([{ type: "host-leave", peer: peerOf(h2) }]);
    const h3 = await join({ role: "host", meta: { label: "box-b" } });
    expect(c.of("host-join")).toEqual([{ type: "host-join", peer: peerOf(h3), label: "box-b" }]);
    expect(h3.of("peer-join")).toEqual([]);

    const c2 = await join({ role: "client", host: "h-future00" });
    const h4 = await join({ role: "host" });
    expect(h4.of("peer-join")).toEqual([]); // not bound to h4
    // leave of a bound client reaches only its host (gone here) — no crash, no fan-out.
    leave(c2);
    expect(h4.of("peer-leave")).toEqual([]);
    expect(h1.of("peer-leave")).toEqual([]);
  });

  it("watcher: sees the roster and host events, is never offered to, and leaves silently", async () => {
    const { join, leave } = await room();
    const h1 = await join({ role: "host" });
    const w = await join({ role: "client", watch: true });
    expect(w.of("welcome")[0].hosts).toEqual([{ peer: peerOf(h1) }]);
    expect(h1.of("peer-join")).toEqual([]);
    const h2 = await join({ role: "host" });
    expect(w.of("host-join")).toEqual([{ type: "host-join", peer: peerOf(h2) }]);
    leave(h1);
    expect(w.of("host-leave")).toEqual([{ type: "host-leave", peer: peerOf(h1) }]);
    leave(w);
    expect(h2.of("peer-leave")).toEqual([]);
  });

  it("legacy client leave still reaches every host", async () => {
    const { join, leave } = await room();
    const h1 = await join({ role: "host" });
    const h2 = await join({ role: "host" });
    const c = await join({ role: "client" });
    leave(c);
    expect(h1.of("peer-leave")).toEqual([{ type: "peer-leave", peer: peerOf(c) }]);
    expect(h2.of("peer-leave")).toEqual([{ type: "peer-leave", peer: peerOf(c) }]);
  });
});

describe("mesh room is untouched", () => {
  it("rosters and broadcasts between equal peers", async () => {
    const { join, say } = await room();
    const a = await join({ role: "client", mesh: true });
    const b = await join({ role: "client", mesh: true });
    expect(b.of("welcome")[0].peers).toEqual([peerOf(a)]);
    expect(a.of("peer-join")).toEqual([{ type: "peer-join", peer: peerOf(b) }]);
    await say(a, { type: "offer", to: peerOf(b), sdp: "o" });
    expect(b.of("offer")).toEqual([{ type: "offer", to: peerOf(b), sdp: "o", from: peerOf(a) }]);
  });
});
