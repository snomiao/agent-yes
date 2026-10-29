import { describe, expect, it } from "vitest";
import {
  onClose,
  onFrame,
  onHello,
  type Attach,
  type Effect,
  type Sock,
  type Stored,
} from "../../lab/ui/cf/roomRouting";

// A tiny in-memory room: sockets are names, attachments and storage are kept
// the way the Durable Object keeps them.
function room() {
  const socks = new Map<string, Attach>();
  const stored: Stored = {};
  let now = 1000;
  let n = 0;
  const list = (): Sock<string>[] => [...socks].map(([s, a]) => ({ s, a }));
  const apply = (effects: Effect<string>[]) => {
    const sent: { to: string; msg: any }[] = [];
    const closed: { to: string; code: number }[] = [];
    for (const e of effects) {
      if (e.kind === "attach") socks.set(e.to, e.value);
      else if (e.kind === "send") sent.push({ to: e.to, msg: e.msg });
      else closed.push({ to: e.to, code: e.code });
    }
    return { sent, closed };
  };
  return {
    socks,
    stored,
    hello(name: string, msg: Record<string, unknown>) {
      socks.set(name, { authed: false });
      const r = onHello(
        name,
        { type: "hello", v: 2, token: "t", ...msg },
        stored,
        list(),
        now++,
        () => `uuid${++n}`.padEnd(12, "0"),
      );
      Object.assign(stored, r.store);
      const out = apply(r.effects);
      for (const c of out.closed) if (c.to === name) socks.delete(name);
      return out;
    },
    frame(name: string, msg: Record<string, unknown>) {
      return apply(onFrame(socks.get(name)!, { ...msg }, list())).sent;
    },
    close(name: string) {
      const a = socks.get(name)!;
      socks.delete(name);
      return apply(onClose(a, list())).sent;
    },
    peer: (name: string) => socks.get(name)?.peer,
  };
}

const host = (extra: Record<string, unknown> = {}) => ({ role: "host", ...extra });
const member = (id: string, extra: Record<string, unknown> = {}) =>
  host({ multi: true, hostId: id, name: `box-${id}`, hostToken: "ht", ...extra });

describe("signaling room routing", () => {
  it("keeps the single-host wire as it was", () => {
    const r = room();
    r.hello("H", host());
    expect(r.peer("H")).toBe("host");
    const { sent } = r.hello("C", { role: "client" });
    const c = r.peer("C")!;
    expect(sent).toContainEqual({ to: "H", msg: { type: "peer-join", peer: c } });
    expect(sent.find((s) => s.to === "C")!.msg).toMatchObject({
      type: "welcome",
      hostPresent: true,
    });
    expect(r.frame("H", { type: "offer", to: c, sdp: "o" })).toEqual([
      { to: "C", msg: { type: "offer", to: c, sdp: "o", from: "host" } },
    ]);
    expect(r.frame("C", { type: "answer", sdp: "a" })).toEqual([
      { to: "H", msg: { type: "answer", sdp: "a", from: c } },
    ]);
    expect(r.close("C")).toEqual([{ to: "H", msg: { type: "peer-leave", peer: c } }]);
  });

  it("lets a multi-host viewer reach every member separately", () => {
    const r = room();
    r.hello("A", member("aaaa"));
    r.hello("B", member("bbbb"));
    expect([r.peer("A"), r.peer("B")]).toEqual(["h-aaaa", "h-bbbb"]);
    const { sent } = r.hello("C", { role: "client", multi: true });
    const c = r.peer("C")!;
    expect(sent.find((s) => s.to === "C")!.msg.hosts).toEqual([
      { peer: "h-aaaa", name: "box-aaaa" },
      { peer: "h-bbbb", name: "box-bbbb" },
    ]);
    expect(sent.filter((s) => s.msg.type === "peer-join").map((s) => s.to)).toEqual(["A", "B"]);
    // Each member's frames say who sent them; the answer goes to one member only.
    expect(r.frame("B", { type: "offer", to: c })[0]!.msg.from).toBe("h-bbbb");
    expect(r.frame("C", { type: "answer", to: "h-bbbb" }).map((s) => s.to)).toEqual(["B"]);
  });

  it("hands an older viewer to the longest-present member only", () => {
    const r = room();
    r.hello("A", member("aaaa"));
    r.hello("B", member("bbbb"));
    const { sent } = r.hello("C", { role: "client" });
    expect(sent.filter((s) => s.msg.type === "peer-join").map((s) => s.to)).toEqual(["A"]);
    expect(sent.find((s) => s.to === "C")!.msg.hosts).toBeUndefined();
    expect(r.frame("C", { type: "candidate" }).map((s) => s.to)).toEqual(["A"]);
  });

  it("never relays a viewer's frame to another viewer", () => {
    const r = room();
    r.hello("A", member("aaaa"));
    r.hello("C", { role: "client", multi: true });
    r.hello("D", { role: "client", multi: true });
    expect(r.frame("C", { type: "relay", to: r.peer("D") })).toEqual([]);
  });

  it("requires the join secret's token once a member pinned it", () => {
    const r = room();
    r.hello("A", member("aaaa"));
    expect(r.stored.hostToken).toBe("ht");
    // The view token alone (a viewer, or an older host) cannot host any more.
    expect(r.hello("X", host()).closed).toEqual([{ to: "X", code: 1008 }]);
    expect(r.hello("Y", member("yyyy", { hostToken: "guess" })).closed).toEqual([
      { to: "Y", code: 1008 },
    ]);
    expect(r.hello("B", member("bbbb")).closed).toEqual([]);
  });

  it("lets a room that single hosts used so far become a members' room", () => {
    const r = room();
    r.hello("H", host());
    r.close("H");
    expect(r.stored.hostToken).toBeUndefined();
    expect(r.hello("A", member("aaaa")).closed).toEqual([]);
    expect(r.stored.hostToken).toBe("ht");
  });

  it("replaces a member's old socket on re-hello without telling viewers it left", () => {
    const r = room();
    r.hello("A1", member("aaaa"));
    r.hello("C", { role: "client", multi: true });
    const { closed } = r.hello("A2", member("aaaa"));
    expect(closed).toEqual([{ to: "A1", code: 4000 }]);
    expect(r.close("A1")).toEqual([]);
    expect(r.close("A2")).toEqual([{ to: "C", msg: { type: "host-leave", peer: "h-aaaa" } }]);
  });

  it("introduces a late member to the viewers already in the room", () => {
    const r = room();
    r.hello("A", member("aaaa"));
    r.hello("C", { role: "client", multi: true });
    r.hello("old", { role: "client" });
    const { sent } = r.hello("B", member("bbbb"));
    expect(sent).toContainEqual({
      to: "C",
      msg: { type: "host-join", peer: "h-bbbb", name: "box-bbbb" },
    });
    expect(sent).toContainEqual({ to: "B", msg: { type: "peer-join", peer: r.peer("C") } });
    expect(sent.some((s) => s.to === "old" || s.msg.peer === r.peer("old"))).toBe(false);
  });

  it("still opens and relays mesh rooms symmetrically", () => {
    const r = room();
    r.hello("P", { role: "client", mesh: true });
    const { sent } = r.hello("Q", { role: "client", mesh: true });
    expect(sent.find((s) => s.to === "Q")!.msg.peers).toEqual([r.peer("P")]);
    expect(sent).toContainEqual({ to: "P", msg: { type: "peer-join", peer: r.peer("Q") } });
    expect(r.frame("P", { type: "offer", to: r.peer("Q") }).map((s) => s.to)).toEqual(["Q"]);
  });

  it("rejects a viewer opening a star room", () => {
    const r = room();
    expect(r.hello("C", { role: "client" }).closed).toEqual([{ to: "C", code: 1008 }]);
  });
});
