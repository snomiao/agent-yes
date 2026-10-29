import { describe, expect, it } from "bun:test";
import {
  ChatHub,
  type Socket,
  type Storage,
  hashToken,
  FRIEND_MAX_PAGES,
  FRIEND_RELABEL_MS,
  PAIR_COOLDOWN_MS,
  PAIR_MAX,
  PAIR_WINDOW_MS,
  pageOriginAllowed,
  routeChat,
} from "../src/hub.ts";
import {
  APPROVAL_MS,
  CHAT_HISTORY,
  CHAT_MS,
  EVAL_GRANT_MS,
  PAGES_GONE_MS,
  PENDING_MS,
} from "../src/protocol.ts";

/** The hub's defaults for a friend's rate limit. */
const FRIEND_CHAT_MAX = 30;
const FRIEND_CHAT_WINDOW_MS = 10 * 60_000;

/** A socket as the hibernation API hands it to the hub, recording what it was sent. */
class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

/** Durable Object storage's key-value API, in memory (keys sorted as the real one does). */
function fakeStorage(
  store = new Map<string, unknown>(),
): Storage & { store: Map<string, unknown> } {
  return {
    store,
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

function setup() {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const storage = fakeStorage();
  const hub = new ChatHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    undefined,
    () => t,
    { eval: true },
  );
  const page = (label = "/words pwa iPhone", id?: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    void hub.connectPage(
      ws,
      new URL(
        `https://example.com/api/chat?label=${encodeURIComponent(label)}${id ? `&page=${encodeURIComponent(id)}` : ""}`,
      ),
    );
    return ws;
  };
  const controller = (label = "main lane", scope?: "chat" | "eval") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    void hub.connectController(
      ws,
      new URL(
        `https://example.com/api/chat/control?label=${encodeURIComponent(label)}${scope ? `&scope=${scope}` : ""}`,
      ),
    );
    return ws;
  };
  /** A controller reconnecting with a grant token (resolves once the hub has checked it). */
  const resume = async (token: string, label = "") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL(`https://example.com/api/chat/control?label=${encodeURIComponent(label)}`),
      token,
    );
    return ws;
  };
  /** A signed-in non-owner's page (resolves once the hub has looked them up). */
  const friend = async (userId = "f1", email = "f1@x.com", label = "/words Android") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(
      ws,
      new URL(`https://example.com/api/chat?label=${encodeURIComponent(label)}`),
      { userId, email, owner: false },
    );
    return ws;
  };
  /** A controller asking for a pairing on a friend's pages, with a grant token. */
  const forFriend = async (token: string | null, email: string, label = "agent") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectController(
      ws,
      new URL(
        `https://example.com/api/chat/control?label=${encodeURIComponent(label)}&for=${encodeURIComponent(email)}`,
      ),
      token,
    );
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const pairOf = (p: FakeSocket) =>
    (p.last("state") as { pending: { pair: string } | null }).pending?.pair ?? "";
  return {
    hub,
    page,
    controller,
    resume,
    friend,
    forFriend,
    msg,
    pairOf,
    storage,
    tick: (ms: number) => (t += ms),
  };
}

describe("ChatHub pairing", () => {
  it("a controller cannot run code before the owner allows it", () => {
    const { page, controller, msg } = setup();
    const p = page();
    const c = controller();
    expect(c.last("pending")?.code).toMatch(/^[0-9a-f]{4}$/);
    msg(c, { type: "eval", code: "document.title" });
    expect(c.last("error")?.error).toBe("not approved yet");
    expect(p.sent.some((m) => m.type === "eval")).toBe(false);
  });

  it("the page is prompted with the label and the same short code", () => {
    const { page, controller } = setup();
    const p = page();
    const c = controller("agent on a laptop");
    const state = p.last("state") as { pending: { code: string; label: string } };
    expect(state.pending.label).toBe("agent on a laptop");
    expect(state.pending.code).toBe(c.last("pending")?.code as string);
  });

  it("after Allow, code reaches the pages and results come back", async () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    await msg(p, { type: "allow", pair });
    expect(c.last("approved")).toBeTruthy();
    msg(c, { type: "eval", code: "1+1" });
    const ev = p.last("eval") as { id: string; code: string; to: string };
    expect(ev.code).toBe("1+1");
    expect(c.last("sent")).toMatchObject({ id: ev.id, delivered: 1 });
    msg(p, { type: "result", id: ev.id, to: ev.to, ok: true, value: "2" });
    expect(c.last("result")).toMatchObject({
      id: ev.id,
      ok: true,
      value: "2",
      page: "/words pwa iPhone",
    });
  });

  it("only pages whose label contains the target get the code", async () => {
    const { page, controller, msg, pairOf } = setup();
    const phone = page("/words pwa iPhone");
    const mac = page("/list Macintosh");
    const c = controller();
    await msg(phone, { type: "allow", pair: pairOf(phone), pages: "all" });
    msg(c, { type: "eval", code: "1", target: "iphone" });
    expect(phone.last("eval")).toBeTruthy();
    expect(mac.last("eval")).toBeUndefined();
  });

  it("Deny closes the controller", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    msg(p, { type: "deny", pair: pairOf(p) });
    expect(c.last("denied")).toBeTruthy();
    expect(c.closed).toBe(4403);
    expect((p.last("state") as { pending: unknown }).pending).toBeNull();
  });

  it("End revokes an approved session", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    msg(p, { type: "allow", pair });
    msg(p, { type: "revoke", pair });
    expect(c.closed).toBe(4401);
    expect((p.last("state") as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("one pairing waits at a time; a stale one is replaced", () => {
    const { page, controller, tick } = setup();
    page();
    const first = controller();
    const second = controller();
    expect(second.closed).toBe(4429);
    tick(PENDING_MS + 1);
    const third = controller();
    expect(first.closed).toBe(4408);
    expect(third.last("pending")).toBeTruthy();
  });

  it("an Allow after the prompt expired does nothing", () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    tick(PENDING_MS + 1);
    msg(p, { type: "allow", pair });
    expect(c.last("approved")).toBeUndefined();
  });

  it("an eval approval runs out after EVAL_GRANT_MS", async () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    await msg(p, { type: "allow", pair: pairOf(p) });
    tick(EVAL_GRANT_MS + 1);
    msg(c, { type: "eval", code: "1" });
    expect(c.closed).toBe(4408);
    expect(p.last("eval")).toBeUndefined();
  });

  it("with no owner page open, a controller is turned away", () => {
    const { controller } = setup();
    const c = controller();
    expect(c.closed).toBe(4404);
  });

  it("a controller cannot approve itself or another controller", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    msg(c, { type: "allow", pair: pairOf(p) });
    expect(c.last("approved")).toBeUndefined();
  });
});

type Chat = {
  message: { id: string; from: string; label: string; text: string; at: number; thread?: string };
};
const chats = (ws: FakeSocket) =>
  ws.sent.filter((m) => m.type === "chat").map((m) => (m as unknown as Chat).message);

describe("ChatHub chat", () => {
  it("an owner message reaches every page and every approved controller, not a pending one", async () => {
    const { page, controller, msg, pairOf } = setup();
    const phone = page();
    const mac = page("/list Macintosh");
    const approved = controller("agent");
    await msg(phone, { type: "allow", pair: pairOf(phone) });
    const waiting = controller("stranger");
    await msg(phone, { type: "chat", id: "m1", text: "  hello agent  " });
    for (const ws of [phone, mac, approved])
      expect(chats(ws)).toEqual([
        {
          id: "m1",
          from: "owner",
          label: "/words pwa iPhone",
          text: "hello agent",
          at: 1_000_000,
          thread: "owner",
        },
      ]);
    expect(chats(waiting)).toEqual([]);
  });

  it("a controller's say reaches the pages and is acknowledged", async () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller("main lane");
    await msg(p, { type: "allow", pair: pairOf(p) });
    await msg(c, { type: "say", text: "on it" });
    expect(chats(p).at(-1)).toMatchObject({ from: "agent", label: "main lane", text: "on it" });
    expect(c.last("said")?.id).toBe(chats(p).at(-1)?.id as string);
  });

  it("an unapproved controller cannot say", async () => {
    const { page, controller, msg } = setup();
    const p = page();
    const c = controller();
    await msg(c, { type: "say", text: "hi" });
    expect(c.last("error")?.error).toBe("not approved yet");
    expect(chats(p)).toEqual([]);
  });

  it("a reloaded page gets the history; only the last CHAT_HISTORY are kept", async () => {
    const { hub, page, msg, storage } = setup();
    const p = page();
    for (let i = 0; i < CHAT_HISTORY + 5; i++)
      await msg(p, { type: "chat", id: `m${i}`, text: `${i}` });
    const again = page();
    await hub.history();
    const h = again.last("history") as { messages: { id: string }[] };
    expect(h.messages).toHaveLength(CHAT_HISTORY);
    expect(h.messages[0]!.id).toBe("m5");
    expect(h.messages.at(-1)?.id).toBe(`m${CHAT_HISTORY + 4}`);
    expect([...storage.store.keys()].filter((k) => k.startsWith("msg:"))).toHaveLength(
      CHAT_HISTORY,
    );
  });

  it("malformed or oversized chat is dropped", async () => {
    const { page, msg } = setup();
    const p = page();
    await msg(p, { type: "chat", id: "x", text: "   " });
    await msg(p, { type: "chat", id: "y", text: "a".repeat(4001) });
    await msg(p, { type: "chat", text: "no id" });
    expect(chats(p)).toEqual([]);
  });
});

describe("ChatHub chat-only grants", () => {
  /** Pair a controller and answer "Allow chat for 30 days"; returns the token it was handed. */
  const chatPair = async (s: ReturnType<typeof setup>, p: FakeSocket) => {
    const c = s.controller("listener");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };

  it("Allow chat grants chat but not eval, and hands out a token stored only hashed", async () => {
    const s = setup();
    const p = s.page();
    const { c, token } = await chatPair(s, p);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(c.last("approved")).toMatchObject({ scope: "chat", until: 1_000_000 + CHAT_MS });
    expect(c.last("history")).toEqual({ type: "history", messages: [] });
    expect(s.storage.store.get(`grant:${await hashToken(token)}`)).toEqual({
      label: "listener",
      until: 1_000_000 + CHAT_MS,
      pages: "all",
      scope: "chat",
      at: 1_000_000,
    });
    expect(JSON.stringify([...s.storage.store.entries()])).not.toContain(token);
    await s.msg(c, { type: "eval", code: "document.cookie" });
    expect(c.last("error")?.error).toContain("chat-only");
    expect(p.last("eval")).toBeUndefined();
    await s.msg(p, { type: "chat", id: "m1", text: "hi" });
    expect(chats(c).map((m) => m.text)).toEqual(["hi"]);
    const sessions = (p.last("state") as { sessions: { scope: string }[] }).sessions;
    expect(sessions.map((x) => x.scope)).toEqual(["chat"]);
  });

  it("Allow for eval grants eval and chat for EVAL_GRANT_MS, with a resumable token", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller();
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    const self = (p.last("state") as { self: string }).self;
    expect(c.last("approved")).toMatchObject({
      scope: "eval",
      until: 1_000_000 + EVAL_GRANT_MS,
      pages: [self],
    });
    const token = c.last("approved")?.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(c.last("history")).toBeTruthy();
    // Resuming restores eval and its pages, with no prompt.
    c.close(1006);
    s.hub.webSocketClose(c, 1006);
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({ scope: "eval", pages: [self], resumed: true });
    expect(again.last("pending")).toBeUndefined();
    await s.msg(again, { type: "eval", code: "1" });
    expect(p.last("eval")).toBeTruthy();
  });

  it("a friend's preview approval is one socket for an hour, with no token", async () => {
    const s = setup();
    s.page();
    const owner = s.controller("agent");
    const op = s.page("/owner");
    await s.msg(op, { type: "allow", pair: s.pairOf(op), scope: "chat" });
    const grant = owner.last("approved")?.token as string;
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, { type: "chat", id: "x", text: "hi" });
    const pv = await s.forFriend(grant, "f1@x.com");
    await s.msg(f, {
      type: "allow",
      pair: (f.last("state") as { pending: { pair: string } }).pending.pair,
    });
    expect(pv.last("approved")).toMatchObject({ scope: "eval", until: 1_000_000 + APPROVAL_MS });
    expect(pv.last("approved")?.token).toBeUndefined();
  });

  it("an eval grant no socket holds is listed as idle; End drops it, Allow adds a page", async () => {
    const s = setup();
    const p = s.page("/a");
    const q = s.page("/b");
    const c = s.controller();
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    const token = c.last("approved")?.token as string;
    c.close(1006);
    await s.hub.webSocketClose(c, 1006);
    const idle = (p.last("state") as { sessions: { pair: string; code: string }[] }).sessions;
    expect(idle).toHaveLength(1);
    expect(idle[0]!.code).toBe("idle");
    // Allow from the other page adds it to the sleeping grant.
    await s.msg(q, { type: "allow", pair: idle[0]!.pair });
    const hash = await hashToken(token);
    const qid = (q.last("state") as { self: string }).self;
    expect((s.storage.store.get(`grant:${hash}`) as { pages: string[] }).pages).toContain(qid);
    // End drops it: the token resumes nothing.
    await s.msg(p, { type: "revoke", pair: idle[0]!.pair });
    expect(s.storage.store.get(`grant:${hash}`)).toBeUndefined();
    expect((p.last("state") as { sessions: unknown[] }).sessions).toEqual([]);
    const again = await s.resume(token);
    expect(again.closed).toBe(4498);
  });

  it("a grant for all pages resumes with no prompt, even with no page open", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("listener");
    await s.msg(p, { type: "allow", pair: s.pairOf(p), scope: "chat", pages: "all" });
    const token = c.last("approved")?.token as string;
    await s.msg(p, { type: "chat", id: "m1", text: "while you were away" });
    c.close(1006);
    p.close(1001);
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({ scope: "chat", resumed: true });
    expect(again.last("pending")).toBeUndefined();
    expect(
      (again.last("history") as { messages: { id: string }[] }).messages.map((m) => m.id),
    ).toEqual(["m1"]);
    await s.msg(again, { type: "say", text: "back" });
    expect(again.last("said")).toBeTruthy();
    await s.msg(again, { type: "eval", code: "1" });
    expect(again.last("error")?.error).toContain("chat-only");
  });

  it("a wrong or expired token is refused with 4498", async () => {
    const s = setup();
    const p = s.page();
    const { token } = await chatPair(s, p);
    const wrong = await s.resume("0".repeat(64));
    expect(wrong.closed).toBe(4498);
    s.tick(CHAT_MS + 1);
    const late = await s.resume(token);
    expect(late.closed).toBe(4498);
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
  });

  it("End revokes the grant and closes every socket holding it", async () => {
    const s = setup();
    const p = s.page();
    const { c, token } = await chatPair(s, p);
    const other = await s.resume(token);
    const sessions = (p.last("state") as { sessions: { pair: string }[] }).sessions;
    expect(sessions).toHaveLength(2);
    await s.msg(p, { type: "revoke", pair: sessions[1]!.pair });
    expect(c.closed).toBe(4401);
    expect(other.closed).toBe(4401);
    expect(s.storage.store.has(`grant:${await hashToken(token)}`)).toBe(false);
    expect((await s.resume(token)).closed).toBe(4498);
  });
});

// The Workers runtime's socket pair, for the hubs' fetch(); bun has none.
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

describe("ChatHub.fetch", () => {
  it("upgrades pages and controllers, and drops a closed controller from the prompt", async () => {
    const sockets: FakeSocket[] = [];
    const hub = new ChatHub({
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    });
    expect((await hub.fetch(new Request("https://example.com/api/chat?label=p"))).status).toBe(403);
    expect(sockets).toHaveLength(0);
    const res = await hub.fetch(
      new Request("https://example.com/api/chat?label=p", {
        headers: { "x-liagent-user": "u1", "x-liagent-owner": "1" },
      }),
    );
    expect(res.status).toBe(101);
    const page = sockets[0]!;
    await hub.fetch(new Request("https://example.com/api/chat/control?label=c"));
    const ctl = sockets[1]!;
    expect(ctl.last("pending")).toBeTruthy();
    hub.webSocketClose(ctl, 1005);
    expect(ctl.closed).toBe(1000);
    expect((page.last("state") as { pending: unknown }).pending).toBeNull();
    expect(page.last("history")).toEqual({ type: "history", messages: [] });
  });

  it("passes the grant token header to the hub", async () => {
    const sockets: FakeSocket[] = [];
    const hub = new ChatHub({
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    });
    await hub.fetch(
      new Request("https://example.com/api/chat/control?label=c", {
        headers: { "x-liagent-token": "nope" },
      }),
    );
    expect(sockets[0]!.closed).toBe(4498);
  });
});

describe("ChatHub friends", () => {
  /** The owner's agent: a listener with a 30-day chat grant (approved on an owner page). */
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };
  it("a friend chats without approval; the agent hears it with thread, email and page", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend("f1", "f1@x.com", "/words pwa Android");
    expect(f.last("friend-status")?.status).toBe("open");
    expect(f.last("history")).toEqual({ type: "history", messages: [] });
    await s.msg(f, { type: "chat", id: "a", text: "the button is too small" });
    expect(chats(c).at(-1)).toMatchObject({
      from: "friend",
      thread: "f1",
      email: "f1@x.com",
      label: "/words pwa Android",
      text: "the button is too small",
    });
    expect(chats(f).map((m) => m.text)).toEqual(["the button is too small"]);
    // The owner's pages do not get a friend's thread.
    expect(chats(owner)).toEqual([]);
  });

  it("a friend's first message tells the agent once", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    await s.msg(f, { type: "chat", id: "b", text: "again" });
    expect(c.sent.filter((m) => m.type === "friend-new")).toEqual([
      { type: "friend-new", userId: "f1", email: "f1@x.com", at: 1_000_000 },
    ]);
    expect(s.storage.store.get("friend:f1")).toMatchObject({
      email: "f1@x.com",
      firstSeen: 1_000_000,
      count: 2,
    });
  });

  it("a friend never sees the owner's thread or another friend's", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    await s.msg(owner, { type: "chat", id: "o1", text: "owner secret" });
    const a = await s.friend("fa", "a@x.com");
    const b = await s.friend("fb", "b@x.com");
    expect((a.last("history") as { messages: unknown[] }).messages).toEqual([]);
    await s.msg(a, { type: "chat", id: "a1", text: "from a" });
    await s.msg(owner, { type: "chat", id: "o2", text: "owner again" });
    await s.msg(c, { type: "say", text: "to owner" });
    await s.msg(c, { type: "say", text: "to a", to: "a@x.com" });
    expect(chats(a).map((m) => m.text)).toEqual(["from a", "to a"]);
    expect(chats(b)).toEqual([]);
    expect(chats(owner).map((m) => m.text)).toEqual(["owner secret", "owner again", "to owner"]);
    // A reload of b gets b's (empty) thread; a's history is a's alone.
    const b2 = await s.friend("fb", "b@x.com");
    expect((b2.last("history") as { messages: unknown[] }).messages).toEqual([]);
    const a2 = await s.friend("fa", "a@x.com");
    const texts = (a2.last("history") as { messages: { text: string }[] }).messages.map(
      (m) => m.text,
    );
    expect(texts).toEqual(["from a", "to a"]);
  });

  it("say reaches a friend by email or user id, and refuses an unknown one", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend("f1", "F1@X.com");
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    await s.msg(c, { type: "say", text: "by email", to: "f1@x.com" });
    await s.msg(c, { type: "say", text: "by id", to: "f1" });
    expect(chats(f).map((m) => m.text)).toEqual(["hi", "by email", "by id"]);
    expect(c.last("said")?.thread).toBe("f1");
    await s.msg(c, { type: "say", text: "?", to: "nobody@x.com" });
    expect(c.last("error")?.error).toContain("no chat thread");
  });

  it("a friend may send FRIEND_CHAT_MAX messages per window, then is told and dropped", async () => {
    const s = setup();
    const owner = s.page();
    const { c } = await agent(s, owner);
    const f = await s.friend();
    for (let i = 0; i < FRIEND_CHAT_MAX + 2; i++)
      await s.msg(f, { type: "chat", id: `m${i}`, text: `${i}` });
    expect(chats(c).filter((m) => m.from === "friend")).toHaveLength(FRIEND_CHAT_MAX);
    expect(f.last("rate-limited")).toMatchObject({ retryIn: FRIEND_CHAT_WINDOW_MS });
    s.tick(FRIEND_CHAT_WINDOW_MS);
    await s.msg(f, { type: "chat", id: "late", text: "later" });
    expect(chats(c).at(-1)?.text).toBe("later");
    // The owner has no such limit.
    for (let i = 0; i < FRIEND_CHAT_MAX + 2; i++)
      await s.msg(owner, { type: "chat", id: `o${i}`, text: `${i}` });
    expect(owner.last("rate-limited")).toBeUndefined();
  });

  it("each friend thread keeps the last CHAT_HISTORY, apart from the owner's", async () => {
    const s = setup();
    s.page();
    const f = await s.friend();
    for (let i = 0; i < CHAT_HISTORY + 3; i++) {
      if (i % FRIEND_CHAT_MAX === 0) s.tick(FRIEND_CHAT_WINDOW_MS);
      await s.msg(f, { type: "chat", id: `m${i}`, text: `${i}` });
    }
    const keys = [...s.storage.store.keys()];
    expect(keys.filter((k) => k.startsWith("t:f1:msg:"))).toHaveLength(CHAT_HISTORY);
    expect(keys.filter((k) => k.startsWith("msg:"))).toHaveLength(0);
    expect((await s.hub.history("f1"))[0]!.id).toBe("m3");
  });

  it("Block closes the friend's sockets and refuses them after; unblock lets them back", async () => {
    const s = setup();
    const owner = s.page();
    const { c, token } = await agent(s, owner);
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const p = await s.forFriend(token, "f1@x.com");
    const api = (body: unknown) =>
      s.hub.fetch(
        new Request("https://hub/internal/friends", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    expect((await api({ userId: "nobody", action: "block" })).status).toBe(404);
    expect((await api({ userId: "f1", action: "nope" })).status).toBe(400);
    expect((await api({ userId: "f1", action: "block" })).status).toBe(200);
    expect(f.closed).toBe(4403);
    expect(f.last("friend-status")?.status).toBe("blocked");
    expect(p.closed).toBe(4401);
    const again = await s.friend();
    expect(again.closed).toBe(4403);
    await s.msg(c, { type: "say", text: "x", to: "f1@x.com" });
    expect(c.last("error")?.error).toContain("blocked");
    const list = (await (
      await s.hub.fetch(new Request("https://hub/internal/friends"))
    ).json()) as { friends: { userId: string; blocked: boolean; count: number }[] };
    expect(list.friends).toMatchObject([{ userId: "f1", blocked: true, count: 1 }]);
    await api({ userId: "f1", action: "unblock" });
    const back = await s.friend();
    expect(back.closed).toBeUndefined();
    expect(back.last("friend-status")?.status).toBe("open");
  });

  it("the owner's read-only view gets one friend's thread over the internal API", async () => {
    const s = setup();
    const f = await s.friend();
    await s.msg(f, { type: "chat", id: "a", text: "hi" });
    const res = await s.hub.fetch(new Request("https://hub/internal/friends/thread?user=f1"));
    const { messages } = (await res.json()) as { messages: { text: string }[] };
    expect(messages.map((m) => m.text)).toEqual(["hi"]);
    expect(
      (await s.hub.fetch(new Request("https://hub/internal/friends/thread?user=a:b"))).status,
    ).toBe(400);
  });

  it("a page with a malformed identity is closed", async () => {
    const s = setup();
    const ws = await s.friend("bad:id");
    expect(ws.closed).toBe(4403);
  });
});

describe("ChatHub eval scoping between the owner and friends", () => {
  const agent = async (s: ReturnType<typeof setup>, owner: FakeSocket) => {
    const c = s.controller("agent");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner), scope: "chat" });
    return { c, token: c.last("approved")?.token as string };
  };
  type St = { pending: { pair: string; label: string } | null; sessions: unknown[] };
  const st = (ws: FakeSocket) => ws.last("state") as St;
  /** Owner page, agent grant, two friends who have chatted. */
  const world = async () => {
    const s = setup();
    const owner = s.page("/words Macintosh");
    const { c, token } = await agent(s, owner);
    const a = await s.friend("fa", "a@x.com", "/words Android");
    const b = await s.friend("fb", "b@x.com", "/list iPhone");
    await s.msg(a, { type: "chat", id: "a", text: "hi" });
    await s.msg(b, { type: "chat", id: "b", text: "hi" });
    return { s, owner, c, token, a, b };
  };

  it("an owner-approved eval reaches only the owner's pages", async () => {
    const { s, owner, a, b } = await world();
    const e = s.controller("eval lane");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    // Friends were never shown the owner's prompt.
    expect(st(a).pending).toBeNull();
    await s.msg(e, { type: "eval", code: "document.title" });
    expect(owner.last("eval")).toBeTruthy();
    expect(a.last("eval")).toBeUndefined();
    expect(b.last("eval")).toBeUndefined();
  });

  it("only the owner's grant may ask a friend for a pairing", async () => {
    const { s } = await world();
    expect((await s.forFriend(null, "a@x.com")).closed).toBe(4498);
    expect((await s.forFriend("0".repeat(64), "a@x.com")).closed).toBe(4498);
  });

  it("a friend pairing prompts only that friend, and only they can answer it", async () => {
    const { s, owner, token, a, b } = await world();
    const p = await s.forFriend(token, "a@x.com", "agent on mac");
    expect(p.last("pending")?.code).toMatch(/^[0-9a-f]{4}$/);
    expect(st(a).pending?.label).toBe("agent on mac");
    expect(st(b).pending).toBeNull();
    expect(st(owner).pending).toBeNull();
    const pair = st(a).pending?.pair ?? "";
    // Neither the owner nor another friend can approve it.
    await s.msg(owner, { type: "allow", pair });
    await s.msg(b, { type: "allow", pair });
    expect(p.last("approved")).toBeUndefined();
    // Asking for chat scope from a friend's page still gives eval only, and no token.
    await s.msg(a, { type: "allow", pair, scope: "chat" });
    expect(p.last("approved")).toMatchObject({ scope: "eval", for: "a@x.com" });
    expect(p.last("approved")?.token).toBeUndefined();
    expect(p.last("history")).toBeUndefined();
  });

  it("a friend-approved eval reaches only that friend's pages, and cannot chat", async () => {
    const { s, owner, c, token, a, b } = await world();
    const a2 = await s.friend("fa", "a@x.com", "/words pwa Android");
    const p = await s.forFriend(token, "a@x.com");
    await s.msg(a, { type: "allow", pair: st(a).pending?.pair ?? "", pages: "all" });
    await s.msg(p, { type: "eval", code: "1", target: "pwa" });
    expect(p.last("sent")).toMatchObject({ delivered: 1, labels: ["/words pwa Android"] });
    await s.msg(p, { type: "eval", code: "2" });
    expect(p.last("sent")?.delivered).toBe(2);
    expect(owner.last("eval")).toBeUndefined();
    expect(b.last("eval")).toBeUndefined();
    const ev = a.last("eval") as { id: string; to: string };
    // A result from the owner's page (or another friend's) cannot reach it.
    await s.msg(owner, { type: "result", id: ev.id, to: ev.to, ok: true, value: "x" });
    await s.msg(b, { type: "result", id: ev.id, to: ev.to, ok: true, value: "x" });
    expect(p.last("result")).toBeUndefined();
    await s.msg(a, { type: "result", id: ev.id, to: ev.to, ok: true, value: "2" });
    expect(p.last("result")).toMatchObject({ value: "2", page: "/words Android" });
    // It is no listener: it hears no chat and may not say.
    await s.msg(a2, { type: "chat", id: "z", text: "zz" });
    expect(chats(p)).toEqual([]);
    expect(chats(c).at(-1)?.text).toBe("zz");
    await s.msg(p, { type: "say", text: "hi", to: "a@x.com" });
    expect(p.last("error")?.error).toContain("cannot chat");
    // Its session shows on the friend's pages, not the owner's.
    expect(st(a).sessions).toHaveLength(1);
    expect(st(owner).sessions).toHaveLength(1); // the owner's own chat grant only
  });

  it("the friend's End closes it, and the owner's End cannot reach it", async () => {
    const { s, owner, token, a } = await world();
    const p = await s.forFriend(token, "a@x.com");
    const pair = st(a).pending?.pair ?? "";
    await s.msg(a, { type: "allow", pair });
    await s.msg(owner, { type: "revoke", pair });
    expect(p.closed).toBeUndefined();
    await s.msg(a, { type: "revoke", pair });
    expect(p.closed).toBe(4401);
  });

  it("an expired friend pairing is closed", async () => {
    const { s, token, a } = await world();
    const p = await s.forFriend(token, "a@x.com");
    await s.msg(a, { type: "allow", pair: st(a).pending?.pair ?? "" });
    s.tick(APPROVAL_MS + 1);
    await s.msg(p, { type: "eval", code: "1" });
    expect(p.last("expired")).toBeTruthy();
    expect(p.closed).toBe(4408);
    expect(a.sent.filter((m) => m.type === "eval")).toHaveLength(0);
  });

  it("a waiting friend pairing does not block the owner's, nor another friend's", async () => {
    const { s, owner, token, b } = await world();
    await s.forFriend(token, "a@x.com");
    const own = s.controller("eval lane");
    expect(own.closed).toBeUndefined();
    expect(st(owner).pending?.label).toBe("eval lane");
    expect((await s.forFriend(token, "b@x.com")).closed).toBeUndefined();
    expect(st(b).pending).toBeTruthy();
    expect((await s.forFriend(token, "a@x.com")).closed).toBe(4429);
  });

  it("a pairing for an unknown friend, or one with no page open, is refused", async () => {
    const { s, token, b } = await world();
    expect((await s.forFriend(token, "nobody@x.com")).closed).toBe(4404);
    b.close(1001);
    expect((await s.forFriend(token, "b@x.com")).closed).toBe(4404);
  });
});

describe("ChatHub without eval (the default)", () => {
  const plain = () => {
    const sockets: FakeSocket[] = [];
    const hub = new ChatHub({
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    });
    const add = () => {
      const ws = new FakeSocket();
      sockets.push(ws);
      return ws;
    };
    return { hub, add };
  };

  it("Allow for 1 hour is an hour of chat, and code is refused", async () => {
    const { hub, add } = plain();
    const p = add();
    await hub.connectPage(p, new URL("https://example.com/api/chat?label=p"));
    const c = add();
    await hub.connectController(c, new URL("https://example.com/api/chat/control?label=c"));
    const pair = (p.last("state") as { pending: { pair: string } }).pending.pair;
    await hub.webSocketMessage(p, JSON.stringify({ type: "allow", pair }));
    expect(c.last("approved")).toMatchObject({ scope: "chat" });
    expect(c.last("approved")?.token).toBeUndefined();
    await hub.webSocketMessage(c, JSON.stringify({ type: "eval", code: "1" }));
    expect(c.last("error")?.error).toContain("chat-only");
    expect(p.last("eval")).toBeUndefined();
  });

  it("a pairing for a friend is refused", async () => {
    const { hub, add } = plain();
    const c = add();
    await hub.connectController(
      c,
      new URL("https://example.com/api/chat/control?for=a@x.com"),
      "token",
    );
    expect(c.closed).toBe(4403);
  });
});

describe("routeChat", () => {
  const calls: Request[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (r: Request) => {
        calls.push(r);
        return new Response("hub");
      },
    }),
  };
  const ws = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://example.com${path}`, { headers: { upgrade: "websocket", ...headers } });
  const owner = { identify: () => ({ userId: "u1", email: "o@x.com", owner: true }) };

  it("leaves other paths to the site", async () => {
    expect(await routeChat(ws("/api/other"), ns, owner)).toBeNull();
  });

  it("wants a WebSocket", async () => {
    const res = await routeChat(new Request("https://example.com/api/chat"), ns, owner);
    expect(res?.status).toBe(426);
  });

  it("refuses a page the site does not know, or whose check throws", async () => {
    expect((await routeChat(ws("/api/chat"), ns, { identify: () => null }))?.status).toBe(403);
    const boom = {
      identify: () => {
        throw new Error("down");
      },
    };
    expect((await routeChat(ws("/api/chat"), ns, boom))?.status).toBe(403);
    expect(
      (
        await routeChat(ws("/api/chat"), ns, {
          identify: () => ({ userId: "a:b", email: "", owner: false }),
        })
      )?.status,
    ).toBe(403);
  });

  it("passes the site's identity on, never the client's", async () => {
    calls.length = 0;
    await routeChat(
      ws("/api/chat?label=x", { "x-liagent-owner": "1", "x-liagent-user": "owner" }),
      ns,
      { identify: () => ({ userId: "f1", email: "f1@x.com", owner: false }) },
    );
    const h = calls[0]!.headers;
    expect([h.get("x-liagent-user"), h.get("x-liagent-email"), h.get("x-liagent-owner")]).toEqual([
      "f1",
      "f1@x.com",
      "0",
    ]);
    expect(new URL(calls[0]!.url).searchParams.get("label")).toBe("x");
    await routeChat(ws("/api/chat"), ns, owner);
    expect(calls[1]!.headers.get("x-liagent-owner")).toBe("1");
    expect(calls[1]!.headers.get("x-liagent-user")).toBe("owner");
  });

  it("refuses an agent socket from a web page (Origin), and strips identity from agents", async () => {
    calls.length = 0;
    const res = await routeChat(
      ws("/api/chat/control", { origin: "https://evil.example" }),
      ns,
      owner,
    );
    expect(res?.status).toBe(403);
    await routeChat(
      ws("/api/chat/control", { "x-liagent-owner": "1", "x-liagent-token": "t" }),
      ns,
      owner,
    );
    expect(new URL(calls[0]!.url).pathname).toBe("/control");
    expect(calls[0]!.headers.get("x-liagent-owner")).toBeNull();
    expect(calls[0]!.headers.get("x-liagent-token")).toBe("t");
  });

  it("refuses a page socket from a foreign Origin before asking who it is (CSWSH)", async () => {
    calls.length = 0;
    let asked = 0;
    const identify = () => {
      asked++;
      return { userId: "u1", email: "o@x.com", owner: true };
    };
    const evil = await routeChat(
      ws("/api/chat", { origin: "https://evil.example", cookie: "session=victim" }),
      ns,
      { identify },
    );
    expect(evil?.status).toBe(403);
    expect(asked).toBe(0);
    expect(calls).toHaveLength(0);
    // Its own origin, and one the site allows, go through.
    await routeChat(ws("/api/chat", { origin: "https://example.com" }), ns, { identify });
    await routeChat(ws("/api/chat", { origin: "https://app.example.net" }), ns, {
      identify,
      allowedOrigins: ["https://app.example.net"],
    });
    expect(calls).toHaveLength(2);
    // A sibling subdomain is a different origin unless listed.
    const sibling = await routeChat(ws("/api/chat", { origin: "https://sub.example.com" }), ns, {
      identify,
    });
    expect(sibling?.status).toBe(403);
  });

  it("pageOriginAllowed: own origin, listed origins, and no Origin (not a browser page)", () => {
    const r = (origin?: string) =>
      new Request("https://example.com/api/chat", origin ? { headers: { origin } } : {});
    expect(pageOriginAllowed(r("https://example.com"))).toBe(true);
    expect(pageOriginAllowed(r("http://example.com"))).toBe(false);
    expect(pageOriginAllowed(r("https://example.com:8443"))).toBe(false);
    expect(pageOriginAllowed(r("https://a.test"), ["https://a.test"])).toBe(true);
    expect(pageOriginAllowed(r("null"))).toBe(false);
    expect(pageOriginAllowed(r())).toBe(true);
  });

  it("custom paths", async () => {
    calls.length = 0;
    const opts = { ...owner, pagePath: "/chat/ws" };
    expect(await routeChat(ws("/api/chat"), ns, opts)).toBeNull();
    await routeChat(ws("/chat/ws/control"), ns, opts);
    expect(new URL(calls[0]!.url).pathname).toBe("/control");
  });
});

describe("ChatHub pages", () => {
  type St = { pages: { id: string; label: string }[]; self: string; sessions: { pair: string }[] };
  const st = (ws: FakeSocket) => ws.last("state") as St;
  const two = () => {
    const s = setup();
    const p1 = s.page("/words phone");
    const p2 = s.page("/list laptop");
    return { s, p1, p2, id1: st(p1).self, id2: st(p2).self };
  };
  const pairOn = async (
    s: ReturnType<typeof setup>,
    p: FakeSocket,
    scope: "chat" | "eval",
    pages?: string[] | "all",
  ) => {
    const c = s.controller("a", scope);
    await s.msg(
      p,
      pages ? { type: "allow", pair: s.pairOf(p), pages } : { type: "allow", pair: s.pairOf(p) },
    );
    return c;
  };

  it("state lists the audience's pages and names the receiver", () => {
    const { p1, p2, id1, id2 } = two();
    expect(st(p1).pages.map((p) => p.id)).toEqual([id1, id2]);
    expect(st(p2).self).toBe(id2);
    expect(id1).not.toBe(id2);
  });

  it("a friend's state lists only their own pages", async () => {
    const { s, id1 } = two();
    const f = await s.friend();
    expect(st(f).pages.map((p) => p.id)).not.toContain(id1);
    expect(st(f).pages).toHaveLength(1);
  });

  it("the agent's requested scope decides; the answer only picks pages", async () => {
    const { s, p1, id1 } = two();
    const c = await pairOn(s, p1, "chat", [id1]);
    // Chat is always every page, whatever was ticked.
    expect(c.last("approved")).toMatchObject({ scope: "chat", pages: "all" });
    expect(typeof c.last("approved")?.token).toBe("string");
    const e = await pairOn(s, p1, "eval");
    expect(e.last("approved")).toMatchObject({ scope: "eval", pages: [id1] });
  });

  it("a pending request shows the scope it asks for", () => {
    const { s, p1 } = two();
    s.controller("a", "eval");
    expect((p1.last("state") as { pending: { scope: string } }).pending.scope).toBe("eval");
  });

  it("eval and live replies reach only the grant's pages; history stays shared", async () => {
    const { s, p1, p2 } = two();
    const c = await pairOn(s, p1, "eval");
    await s.msg(c, { type: "eval", code: "1" });
    expect(p1.last("eval")).toBeTruthy();
    expect(p2.last("eval")).toBeUndefined();
    await s.msg(c, { type: "say", text: "hi" });
    expect(p1.last("chat")).toBeTruthy();
    expect(p2.last("chat")).toBeUndefined();
    expect((await s.hub.history()).map((m) => m.text)).toEqual(["hi"]);
  });

  it("Allow from another page adds it to the grant", async () => {
    const { s, p1, p2, id1, id2 } = two();
    const c = await pairOn(s, p1, "eval");
    await s.msg(p2, { type: "allow", pair: st(p1).sessions[0]!.pair });
    expect(c.last("approved")).toMatchObject({ pages: [id1, id2], added: true });
    await s.msg(c, { type: "eval", code: "1" });
    expect(p2.last("eval")).toBeTruthy();
  });

  it("unknown page ids are ignored, and 'all' covers pages that connect later", async () => {
    const { s, p1, id1 } = two();
    const c = await pairOn(s, p1, "eval", ["nope", id1]);
    expect(c.last("approved")?.pages).toEqual([id1]);
    const all = await pairOn(s, p1, "eval", "all");
    const later = s.page("/later");
    await s.msg(all, { type: "eval", code: "1" });
    expect(later.last("eval")).toBeTruthy();
  });

  it("a chat grant survives its pages closing", async () => {
    const { s, p1, p2 } = two();
    const c = await pairOn(s, p1, "chat");
    for (const p of [p1, p2]) {
      p.close(1001);
      await s.hub.webSocketClose(p, 1001);
    }
    s.tick(60 * 60_000);
    s.page("/back");
    expect(c.closed).toBeUndefined();
  });

  it("an eval grant outlives a short absence: the tab comes back with its page id", async () => {
    const { s, p1, id1 } = two();
    const c = await pairOn(s, p1, "eval");
    p1.close(1001);
    await s.hub.webSocketClose(p1, 1001);
    s.tick(PAGES_GONE_MS - 1);
    const back = s.page("/words phone", id1);
    expect((back.last("state") as { self: string }).self).toBe(id1);
    s.tick(PAGES_GONE_MS);
    await s.msg(c, { type: "eval", code: "1" });
    expect(c.closed).toBeUndefined();
    expect(back.last("eval")).toBeTruthy();
  });

  it("when every page of an eval grant stays gone PAGES_GONE_MS, the socket closes (4409) but the grant stays", async () => {
    const { s, p1 } = two();
    const c = await pairOn(s, p1, "eval");
    p1.close(1001);
    await s.hub.webSocketClose(p1, 1001);
    expect(c.closed).toBeUndefined();
    const token = c.last("approved")?.token as string;
    s.tick(PAGES_GONE_MS);
    s.page("/unrelated");
    expect(c.last("error")?.error).toContain("the grant stays");
    expect(c.closed).toBe(4409);
    const again = await s.resume(token);
    expect(again.last("approved")).toMatchObject({ scope: "eval", resumed: true });
  });

  it("a page id already live (a duplicated tab) is not reused", () => {
    const { s, id1 } = two();
    const dup = s.page("/words phone", id1);
    expect((dup.last("state") as { self: string }).self).not.toBe(id1);
    const bad = s.page("/x", "a b");
    expect((bad.last("state") as { self: string }).self).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a page reports navigation: the list is relabelled and agents hear page-changed", async () => {
    const { s, p1, p2, id1 } = two();
    const c = await pairOn(s, p1, "chat", "all");
    await s.msg(p1, { type: "page", label: "/settings phone" });
    expect(c.last("page-changed")).toMatchObject({ label: "/settings phone", thread: "owner" });
    expect(st(p2).pages.find((p) => p.id === id1)?.label).toBe("/settings phone");
    expect(p2.last("page-changed")).toBeUndefined();
    expect(await s.hub.history()).toEqual([]);
  });

  it("the user can end one of their pages", async () => {
    const { s, p1, p2, id2 } = two();
    await s.msg(p1, { type: "end-page", id: id2 });
    expect(p2.closed).toBe(4410);
    expect(st(p1).pages.map((p) => p.id)).not.toContain(id2);
  });

  it("a friend cannot end the user's pages", async () => {
    const { s, p1, id1 } = two();
    const f = await s.friend();
    await s.msg(f, { type: "end-page", id: id1 });
    expect(p1.closed).toBeUndefined();
  });

  it("an eval request on a hub without eval is refused at the knock", async () => {
    const sockets: FakeSocket[] = [];
    const hub = new ChatHub({
      acceptWebSocket: () => {},
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    });
    const p = new FakeSocket();
    sockets.push(p);
    await hub.connectPage(p, new URL("https://example.com/api/chat"));
    const c = new FakeSocket();
    sockets.push(c);
    await hub.connectController(c, new URL("https://example.com/api/chat/control?scope=eval"));
    expect(c.closed).toBe(4403);
  });
});

describe("ChatHub busy relay", () => {
  const ready = async () => {
    const s = setup();
    const p1 = s.page("/a");
    const p2 = s.page("/b");
    const c = s.controller("ag", "eval");
    await s.msg(p1, { type: "allow", pair: s.pairOf(p1) });
    return { s, p1, p2, c };
  };

  it("a beat is relayed to the grant's pages only, with the agent's label", async () => {
    const { s, p1, p2, c } = await ready();
    await s.msg(c, { type: "busy" });
    expect(p1.last("busy")).toMatchObject({ type: "busy", label: "ag" });
    expect(p2.last("busy")).toBeUndefined();
  });

  it("a beat to a friend reaches that friend's pages", async () => {
    const { s, c } = await ready();
    const f = await s.friend("f1", "f1@x.com");
    await s.msg(f, { type: "chat", id: "x", text: "hi" });
    await s.msg(c, { type: "busy", to: "f1@x.com" });
    expect(f.last("busy")).toBeTruthy();
  });

  it("an unapproved agent cannot beat, and on:false relays nothing", async () => {
    const { s, p1, c } = await ready();
    const other = s.controller("other");
    await s.msg(other, { type: "busy" });
    expect(other.last("error")).toEqual({ type: "error", error: "not approved yet" });
    await s.msg(c, { type: "busy", on: false });
    expect(p1.last("busy")).toBeUndefined();
  });
});

describe("ChatHub pairing rate limit", () => {
  it("after a deny, that audience takes no new request for PAIR_COOLDOWN_MS", async () => {
    const s = setup();
    const p = s.page();
    s.controller("a");
    await s.msg(p, { type: "deny", pair: s.pairOf(p) });
    const again = s.controller("a");
    expect(again.closed).toBe(4429);
    expect(again.last("error")?.error).toContain("denied");
    expect((p.last("state") as { pending: unknown }).pending).toBeNull();
    s.tick(PAIR_COOLDOWN_MS);
    const later = s.controller("a");
    expect(later.closed).toBeUndefined();
    expect(later.last("pending")).toBeTruthy();
  });

  it("at most PAIR_MAX requests per window, then 4429 until it passes", () => {
    const s = setup();
    s.page();
    for (let i = 0; i < PAIR_MAX; i++) {
      const c = s.controller(`a${i}`);
      expect(c.last("pending")).toBeTruthy();
      s.tick(PENDING_MS); // each lapses, making room for the next
    }
    const over = s.controller("one too many");
    expect(over.closed).toBe(4429);
    s.tick(PAIR_WINDOW_MS);
    expect(s.controller("next window").last("pending")).toBeTruthy();
  });

  it("a resume with a grant token is not a pairing request", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("a", "chat");
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    const token = c.last("approved")?.token as string;
    for (let i = 0; i < PAIR_MAX + 2; i++)
      expect((await s.resume(token)).last("approved")).toBeTruthy();
  });
});

describe("ChatHub friend page limits", () => {
  it("a friend's page relabels at most once per FRIEND_RELABEL_MS; the user's are not limited", async () => {
    const s = setup();
    const owner = s.page("/o");
    const c = s.controller("a", "chat");
    await s.msg(owner, { type: "allow", pair: s.pairOf(owner) });
    const f = await s.friend("f1", "f1@x.com", "/one");
    const heard = () => c.sent.filter((m) => m.type === "page-changed").length;
    for (let i = 0; i < 5; i++) await s.msg(f, { type: "page", label: `/f${i}` });
    expect(heard()).toBe(1);
    s.tick(FRIEND_RELABEL_MS);
    await s.msg(f, { type: "page", label: "/later" });
    expect(heard()).toBe(2);
    for (let i = 0; i < 5; i++) await s.msg(owner, { type: "page", label: `/o${i}` });
    expect(heard()).toBe(7);
  });

  it("a friend holds at most FRIEND_MAX_PAGES page sockets", async () => {
    const s = setup();
    const pages: FakeSocket[] = [];
    for (let i = 0; i < FRIEND_MAX_PAGES; i++)
      pages.push(await s.friend("f1", "f1@x.com", `/p${i}`));
    expect(pages.every((p) => p.closed === undefined)).toBe(true);
    const over = await s.friend("f1", "f1@x.com", "/over");
    expect(over.closed).toBe(4429);
    // Another friend, and the user, are unaffected.
    expect((await s.friend("f2", "f2@x.com")).closed).toBeUndefined();
  });
});

describe("ChatHub eval guard", () => {
  it("an eval socket on a hub whose eval was turned off cannot run code", async () => {
    const s = setup();
    const p = s.page();
    const c = s.controller("a", "eval");
    await s.msg(p, { type: "allow", pair: s.pairOf(p) });
    expect(c.last("approved")).toMatchObject({ scope: "eval" });
    // A redeploy with eval off (the same Durable Object, new options).
    (s.hub as unknown as { opts: { eval: boolean } }).opts.eval = false;
    await s.msg(c, { type: "eval", code: "1" });
    expect(c.last("error")?.error).toContain("not enabled");
    expect(p.last("eval")).toBeUndefined();
  });
});
