// Routing decisions for the signaling Room (worker.ts), kept free of Durable
// Object APIs so they can be unit tested (tests/ui-logic/room-routing.spec.ts).
//
// A star room has hosts (`ay serve --webrtc`) and clients (the console, `ay
// connect`). It used to have exactly one host: every host was the peer "host",
// and every client frame went to all of them, so a second host in a room broke
// answering for every viewer. A host that says `multi: true` in its hello is a
// room MEMBER instead:
//
// - it has its own peer id, `h-<hostId>` (stable across the host's periodic
//   re-hello, so viewers keep their connection to it), and a display name;
// - joining requires the room's host token, a second secret that viewers do not
//   hold (see deriveHostToken in lab/ui/e2e.js), once a member has pinned one;
// - a client that also says `multi: true` gets the member roster in its welcome
//   and host-join / host-leave afterwards, and addresses each member with `to`;
// - a client that does not (an older console or CLI) talks to one host only,
//   the longest-present one, exactly as before.
//
// Host frames carry `from` so a viewer can tell the members apart.

export type Attach = {
  authed: boolean;
  role?: "host" | "client";
  peer?: string;
  mesh?: boolean;
  /** Host or client that understands multi-host rooms. */
  multi?: boolean;
  /** Host display name (AY_NAME or hostname). */
  name?: string;
  /** When the socket said hello (host order for older clients). */
  since?: number;
  /** Older client: the one host it was handed to. */
  host?: string;
};

export type Sock<S> = { s: S; a: Attach | null };

export type Effect<S> =
  | { kind: "send"; to: S; msg: unknown }
  | { kind: "close"; to: S; code: number; reason: string }
  | { kind: "attach"; to: S; value: Attach };

export type Stored = {
  token?: string;
  proto?: number;
  mesh?: boolean;
  hostToken?: string;
};

export type HelloResult<S> = { effects: Effect<S>[]; store?: Partial<Stored> };

const NAME_MAX = 64;
const HOST_ID = /^[A-Za-z0-9_-]{1,32}$/;

const isHost = (a: Attach | null | undefined): a is Attach => !!a?.authed && a.role === "host";
const isClient = (a: Attach | null | undefined): a is Attach => !!a?.authed && a.role === "client";

/** The member list a multi-host client sees, one entry per peer id. */
export function hostRoster<S>(socks: Sock<S>[]): { peer: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const { a } of socks) if (isHost(a) && a.peer) seen.set(a.peer, a.name ?? "");
  return [...seen].map(([peer, name]) => ({ peer, name }));
}

/** The host an older (single-host) client is handed to: the longest-present one. */
export function primaryHost<S>(socks: Sock<S>[]): string | undefined {
  let best: Attach | undefined;
  for (const { a } of socks)
    if (isHost(a) && (!best || (a.since ?? 0) < (best.since ?? 0))) best = a;
  return best?.peer;
}

export function onHello<S>(
  self: S,
  msg: Record<string, unknown>,
  stored: Stored,
  socks: Sock<S>[],
  now: number,
  uuid: () => string,
): HelloResult<S> {
  const reject = (reason: string): HelloResult<S> => ({
    effects: [{ kind: "close", to: self, code: 1008, reason }],
  });
  const role: "host" | "client" = msg.role === "host" ? "host" : "client";
  const token = String(msg.token ?? "");
  const proto = Number(msg.v ?? 1);
  const mesh = msg.mesh === true;
  const multi = !mesh && msg.multi === true;
  const hostToken = typeof msg.hostToken === "string" ? msg.hostToken : "";
  const store: Partial<Stored> = {};
  if (stored.token === undefined) {
    // Opening the room: a star room must be opened by its host; a mesh room
    // is opened by whoever arrives first (all peers are equal).
    if (!mesh && role !== "host") return reject("room not open");
    Object.assign(store, { token, proto, mesh });
  } else {
    if (stored.token !== token) return reject("forbidden"); // token never echoed
    if ((stored.proto ?? 1) !== proto) return reject("protocol mismatch");
    if ((stored.mesh ?? false) !== mesh) return reject("room mode mismatch");
  }
  if (role === "host" && !mesh) {
    if (stored.hostToken) {
      if (hostToken !== stored.hostToken) return reject("forbidden");
    } else if (hostToken) {
      // The first member to present a host token pins it, in a new room or in
      // one that single hosts have used so far. From then on the view token
      // alone no longer lets anyone host here.
      store.hostToken = hostToken;
    }
  }

  const effects: Effect<S>[] = [];
  let peer: string;
  if (mesh || role === "client") peer = uuid().slice(0, 8);
  else if (multi) {
    const id = typeof msg.hostId === "string" && HOST_ID.test(msg.hostId) ? msg.hostId : "";
    peer = `h-${id || uuid().slice(0, 8)}`;
  } else peer = "host";
  const name = role === "host" && typeof msg.name === "string" ? msg.name.slice(0, NAME_MAX) : "";
  const attach: Attach = { authed: true, role, peer, mesh, since: now };
  if (multi) attach.multi = true;
  if (name) attach.name = name;

  // A member re-saying hello (its periodic refresh, or a restart) replaces
  // its own previous socket instead of becoming a second member.
  if (multi && role === "host") {
    for (const o of socks)
      if (o.s !== self && isHost(o.a) && o.a.peer === peer)
        effects.push({ kind: "close", to: o.s, code: 4000, reason: "replaced" });
  }
  const others = socks.filter(
    (o) => o.s !== self && !effects.some((e) => e.kind === "close" && e.to === o.s),
  );

  // Older client: bound to one host for the whole handshake.
  if (role === "client" && !mesh && !multi) {
    const h = primaryHost(others);
    if (h) attach.host = h;
  }
  effects.push({ kind: "attach", to: self, value: attach });

  if (mesh) {
    // In a mesh, tell the newcomer who is already here (roster) and announce it
    // to everyone else, so both sides can open a direct DataChannel.
    const roster = others.filter((o) => o.a?.authed && o.a.peer).map((o) => o.a!.peer!);
    effects.push({
      kind: "send",
      to: self,
      msg: { type: "welcome", peer, role, v: proto, mesh, peers: roster },
    });
    for (const o of others)
      if (o.a?.authed) effects.push({ kind: "send", to: o.s, msg: { type: "peer-join", peer } });
    return { effects, store };
  }

  if (role === "host") {
    effects.push({ kind: "send", to: self, msg: { type: "welcome", peer, role, v: proto, mesh } });
    if (multi) {
      for (const o of others) {
        if (!isClient(o.a) || !o.a.multi) continue;
        // Tell every multi-host viewer about the member, and have the member
        // offer to each of them (a viewer that is already connected to it
        // ignores the repeat; the host ignores peers it already has).
        effects.push({ kind: "send", to: o.s, msg: { type: "host-join", peer, name } });
        effects.push({ kind: "send", to: self, msg: { type: "peer-join", peer: o.a.peer } });
      }
    }
    return { effects, store };
  }

  // hostPresent lets a client FAST-FAIL a previously-opened star room whose
  // host has since left (see rtc.js).
  const hostPresent = others.some((o) => isHost(o.a));
  const welcome: Record<string, unknown> = {
    type: "welcome",
    peer,
    role,
    v: proto,
    mesh,
    hostPresent,
  };
  if (multi) welcome.hosts = hostRoster(others);
  effects.push({ kind: "send", to: self, msg: welcome });
  for (const o of others) {
    if (!isHost(o.a)) continue;
    if (multi || o.a.peer === attach.host)
      effects.push({ kind: "send", to: o.s, msg: { type: "peer-join", peer } });
  }
  return { effects, store };
}

/** A relayed frame (offer / answer / candidate / relay) from an authed socket. */
export function onFrame<S>(
  self: Attach,
  msg: Record<string, unknown>,
  socks: Sock<S>[],
): Effect<S>[] {
  const out: Effect<S>[] = [];
  const send = (pred: (a: Attach) => boolean) => {
    for (const o of socks) if (o.a?.authed && pred(o.a)) out.push({ kind: "send", to: o.s, msg });
  };
  msg.from = self.peer; // tag so the recipient can reply/route back
  const to = typeof msg.to === "string" ? msg.to : "";
  if (self.mesh) {
    if (to) send((a) => a.peer === to);
  } else if (self.role === "client") {
    // A client reaches hosts only, never another viewer.
    if (to) send((a) => a.role === "host" && a.peer === to);
    else if (self.host) send((a) => a.role === "host" && a.peer === self.host);
    else send((a) => a.role === "host");
  } else if (to) {
    send((a) => a.role === "client" && a.peer === to);
  }
  return out;
}

/** A socket went away. `socks` no longer includes it. */
export function onClose<S>(self: Attach, socks: Sock<S>[]): Effect<S>[] {
  const out: Effect<S>[] = [];
  if (!self.authed) return out;
  if (self.mesh) {
    for (const o of socks)
      if (o.a?.authed)
        out.push({ kind: "send", to: o.s, msg: { type: "peer-leave", peer: self.peer } });
  } else if (self.role === "client") {
    for (const o of socks)
      if (isHost(o.a))
        out.push({ kind: "send", to: o.s, msg: { type: "peer-leave", peer: self.peer } });
  } else if (self.multi) {
    // A replaced socket's member is still here under the same peer id.
    if (socks.some((o) => isHost(o.a) && o.a.peer === self.peer)) return out;
    for (const o of socks)
      if (isClient(o.a) && o.a.multi)
        out.push({ kind: "send", to: o.s, msg: { type: "host-leave", peer: self.peer } });
  }
  return out;
}
