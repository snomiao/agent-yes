// Browser channel client: `import AyChannel from "agent-yes/channels"`.
//
// The frontend counterpart to the CLI. It joins the SAME WebRTC mesh as any
// `ay ch sync` peer using the isomorphic ChannelPeer (peer.ts) wired to the
// browser's native RTCPeerConnection + WebSocket, persists to LocalStorage
// (store.browser.ts), and renders a self-contained floating chat window (Shadow
// DOM) so an agent and a human can talk on the same page — with no server ever
// storing a message.
//
//   const ch = new AyChannel("ay://ch/s.agent-yes.com/<room>#e1.<S>");
//   await ch.start();
//   ch.on("message", render);
//   ch.mount();                 // floating widget, or ch.mount(el) to embed
//   await ch.send("hello");

import { deriveChannelId, parseChannelLink } from "./link.ts";
import { hlcSend } from "./hlc.ts";
import { makeOp, type Role } from "./op.ts";
import { maxHlc, renderThread, type Message } from "./store.ts";
import { randomHex } from "../../lab/ui/e2e.js";
import { ChannelPeer } from "./peer.ts";
import { LocalStorageStore } from "./store.browser.ts";

export interface AyChannelInfo {
  /** A channel invite link (ay://ch/… or https://…/w/#ch=…). If given, room/sighost/s are parsed from it. */
  link?: string;
  room?: string;
  sighost?: string;
  /** Secret S (64-hex). */
  s?: string;
  name?: string;
  role?: Role;
  /** Stable author id; auto-generated + persisted per channel if omitted. */
  author?: string;
}

type Events = "message" | "peers" | "ready";

export class AyChannel {
  readonly room: string;
  readonly sighost: string;
  readonly s: string;
  channelId = "";
  name: string;
  role: Role;
  author = "";
  private store?: LocalStorageStore;
  private peer?: ChannelPeer;
  private listeners = new Map<Events, Set<(arg: any) => void>>();
  private started = false;
  private peers = 0;

  constructor(info: string | AyChannelInfo) {
    const o = typeof info === "string" ? { link: info } : info;
    const link = o.link ? parseChannelLink(o.link) : null;
    this.room = o.room ?? link?.room ?? "";
    this.sighost = o.sighost ?? link?.sighost ?? "s.agent-yes.com";
    this.s = o.s ?? link?.s ?? "";
    if (!this.room || !this.s) throw new Error("AyChannel: need a link or {room, s}");
    this.name = o.name ?? "guest";
    this.role = o.role ?? "human";
    if (o.author) this.author = o.author;
  }

  /** Derive identity, open the LocalStorage replica, and join the mesh. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.channelId = await deriveChannelId(this.s);
    this.store = new LocalStorageStore(this.channelId);
    this.loadIdentity();
    this.peer = new ChannelPeer({
      room: this.room,
      sighost: this.sighost,
      s: this.s,
      rtc: (globalThis as any).RTCPeerConnection,
      WebSocketImpl: (globalThis as any).WebSocket,
      store: this.store,
      onOp: () => this.emit("message", undefined),
      onPeers: (n) => {
        this.peers = n;
        this.emit("peers", n);
      },
    });
    await this.peer.start();
    this.emit("ready", undefined);
  }

  /** Identity is stable per channel across reloads (a returning tab keeps its author id). */
  private loadIdentity(): void {
    const key = `ay29ch-id:${this.channelId}`;
    let saved: { author: string; name: string; role: Role } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      /* ignore */
    }
    // Author is stable across reloads; name/role fall back to the saved ones only
    // when the caller left them at their defaults.
    this.author ||= saved?.author || randomHex(8);
    if (saved?.name && this.name === "guest") this.name = saved.name;
    if (saved?.role && this.role === "human") this.role = saved.role;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ author: this.author, name: this.name, role: this.role }),
      );
    } catch {
      /* ignore */
    }
  }

  /** The rendered thread (folded messages, ordered). */
  async messages(): Promise<Message[]> {
    return renderThread(await (this.store?.all() ?? Promise.resolve([])));
  }

  /** The current confirmed-peer count (presence). */
  peerCount(): number {
    return this.peers;
  }

  /** Post a message: persist locally + broadcast to the mesh. */
  async send(text: string): Promise<void> {
    if (!this.store || !this.peer) throw new Error("AyChannel: call start() first");
    const t = text.trim();
    if (!t) return;
    const ops = await this.store.all();
    const hlc = hlcSend(maxHlc(ops), Date.now(), this.author);
    const op = makeOp({
      author: this.author,
      name: this.name,
      role: this.role,
      hlc,
      kind: "msg",
      body: t,
    });
    await this.peer.publish(op); // append + broadcast
    this.emit("message", undefined);
  }

  on(evt: Events, cb: (arg: any) => void): this {
    (this.listeners.get(evt) ?? this.listeners.set(evt, new Set()).get(evt)!).add(cb);
    return this;
  }
  off(evt: Events, cb: (arg: any) => void): this {
    this.listeners.get(evt)?.delete(cb);
    return this;
  }
  private emit(evt: Events, arg: any): void {
    for (const cb of this.listeners.get(evt) ?? []) {
      try {
        cb(arg);
      } catch {
        /* a listener throwing must not break delivery */
      }
    }
  }

  close(): void {
    this.peer?.close();
    this.widget?.remove();
  }

  // --- floating chat widget -------------------------------------------------
  // DOM globals (document/HTMLElement) aren't in the Node/Bun type lib this
  // package compiles against, so DOM access here is intentionally loosely typed;
  // this method only ever runs in a browser.

  private widget?: any;

  /**
   * Render the floating chat window. With no target it mounts a fixed-position
   * bubble in the corner; pass an element to embed it there. Auto-calls start().
   */
  mount(target?: any, opts?: { open?: boolean }): any {
    if (this.widget) return this.widget;
    const doc: any = (globalThis as any).document;
    const host = doc.createElement("div");
    host.setAttribute("data-aychannel", this.channelId || this.room);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = WIDGET_HTML;
    this.widget = host;
    (target ?? doc.body).appendChild(host);

    const list = root.getElementById("list")!;
    const input = root.getElementById("input") as any;
    const form = root.getElementById("form") as any;
    const badge = root.getElementById("peers")!;
    const panel = root.getElementById("panel")!;
    const toggle = root.getElementById("toggle")!;

    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const render = async () => {
      const msgs = await this.messages();
      list.innerHTML = msgs
        .map((m) => {
          const mine = m.author === this.author;
          const time = new Date(m.ms).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const body = m.deleted ? "<i>message deleted</i>" : esc(m.text);
          return `<div class="msg ${mine ? "mine" : ""} ${m.role}"><div class="meta">${esc(m.name)} · ${time}</div><div class="body">${body}</div></div>`;
        })
        .join("");
      list.scrollTop = list.scrollHeight;
    };

    form.addEventListener("submit", (e: any) => {
      e.preventDefault();
      const text = input.value;
      input.value = "";
      void this.send(text);
    });
    toggle.addEventListener("click", () => panel.classList.toggle("open"));
    if (opts?.open) panel.classList.add("open");
    this.on("message", () => void render());
    this.on("peers", () => (badge.textContent = String(this.peers)));

    void (async () => {
      if (!this.started) await this.start();
      await render();
      badge.textContent = String(this.peers);
    })();

    return host;
  }
}

// Self-contained styles + markup for the Shadow DOM widget (no external assets).
const WIDGET_HTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  #toggle {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
    background: #4f46e5; color: #fff; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
  }
  #panel {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483000;
    width: min(360px, 92vw); height: min(520px, 70vh); display: none;
    flex-direction: column; background: #1b1d24; color: #e6e6ea; border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; border: 1px solid #2c2f3a;
  }
  #panel.open { display: flex; }
  header { padding: 12px 14px; background: #23262f; display: flex; align-items: center; gap: 8px; }
  header .title { font-weight: 600; font-size: 14px; }
  header .peers { margin-left: auto; font-size: 12px; opacity: .8; background: #4f46e5; border-radius: 10px; padding: 1px 8px; }
  #list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 82%; }
  .msg .meta { font-size: 11px; opacity: .6; margin-bottom: 2px; }
  .msg .body { background: #2c2f3a; padding: 7px 10px; border-radius: 10px; font-size: 13px; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
  .msg.agent .body { border-left: 3px solid #10b981; }
  .msg.mine { align-self: flex-end; text-align: right; }
  .msg.mine .body { background: #4f46e5; color: #fff; }
  #form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #2c2f3a; }
  #input { flex: 1; background: #23262f; border: 1px solid #363a46; color: #e6e6ea; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
  #form button { background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 0 14px; cursor: pointer; font-size: 13px; }
</style>
<button id="toggle" title="Chat">💬</button>
<section id="panel">
  <header><span class="title">Channel</span><span class="peers" id="peers">0</span></header>
  <div id="list"></div>
  <form id="form"><input id="input" placeholder="Message…" autocomplete="off" /><button type="submit">Send</button></form>
</section>
`;

export default AyChannel;
export * from "./index.ts";
