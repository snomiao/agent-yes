// Drive a <liagent-chat> box from a hub's page socket (src/hub.ts, or any
// hub speaking src/protocol.ts). Framework-free; the box can be used without
// it, with any transport, through box.onSend / box.push.
//
//   import { defineChatBox } from "@agent-yes/liagent/box";
//   import { connectHub } from "@agent-yes/liagent/client";
//   defineChatBox();
//   const box = document.body.appendChild(document.createElement("liagent-chat"));
//   const hub = connectHub(box, { url: "wss://example.com/api/chat" });
//   // … hub.close() to drop it.
//
// The socket is held only while the page is visible (and `wanted()` says
// so): hidden for IDLE_MS, it is dropped; visible again, it reopens. It
// reconnects when the network drops it, never after a close the hub meant
// (4xxx) or one that never opened (refused). No timer touches the network.
//
// Eval: a hub may send {type:"eval", id, code, to} from an agent the owner
// approved on this device. It runs only with `evalCode: true`; the result
// goes back to that agent. Off by default — running code is the site's call.

import type { ChatBox } from "./box.ts";
import {
  type ChatMessage,
  PAGE_DEBOUNCE_MS,
  type HubState,
  type PairInfo,
  compile,
  summarize,
  trimHistory,
} from "./protocol.ts";

/** Hidden this long before the socket is dropped. */
export const IDLE_MS = 30_000;
/** How long the eval icon pulses after code ran. */
const RAN_MS = 4_000;

export type HubOptions = {
  /** The hub's page-socket URL (ws:// or wss://, or a path on this origin). */
  url: string;
  /**
   * This page's label, shown to agents; default: path + (pwa) + user agent.
   * A function is asked again after each client-side navigation.
   */
  label?: string | (() => string);
  /** Report client-side navigation to the hub ({type:"page"}). Default true. */
  trackPages?: boolean;
  /** Run code approved agents send (eval scope). Default false. */
  evalCode?: boolean;
  /** Whether the socket should be up at all (beyond visibility). Default always. */
  wanted?: () => boolean;
  /** Each eval result, for the site's own logging. */
  onEval?: (r: { id: string; ok: boolean } & Record<string, unknown>) => void;
};

export type HubConnection = {
  /** Re-check visibility and wanted() now (call it when wanted() may have changed). */
  update(): void;
  close(): void;
};

/** This tab's page id, kept for the tab's life so a reconnect keeps its grants. */
const PAGE_KEY = "liagent:page";
const readPageId = () => {
  try {
    return sessionStorage.getItem(PAGE_KEY) ?? "";
  } catch {
    return "";
  }
};
const savePageId = (id: string) => {
  try {
    if (id) sessionStorage.setItem(PAGE_KEY, id);
  } catch {}
};

function socketUrl(url: string, label: string) {
  const u = new URL(url, location.href);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  u.searchParams.set("label", label);
  const page = readPageId();
  if (page) u.searchParams.set("page", page);
  return u.toString();
}

export function connectHub(box: ChatBox, opts: HubOptions): HubConnection {
  let ws: WebSocket | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let ran: ReturnType<typeof setTimeout> | undefined;
  let nav: ReturnType<typeof setTimeout> | undefined;
  const pageLabel = () => {
    if (typeof opts.label === "function") return opts.label();
    if (opts.label) return opts.label;
    const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
    return `${location.pathname} ${standalone}${navigator.userAgent}`;
  };
  let sentLabel = "";
  let closed = false;
  const opened = new WeakSet<WebSocket>();
  const wanted = () =>
    !closed && document.visibilityState === "visible" && (opts.wanted?.() ?? true);

  const send = (sock: WebSocket | null, msg: unknown) => {
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      sock.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  const run = async (sock: WebSocket, id: string, to: string, code: string) => {
    clearTimeout(ran);
    box.evalRan = true;
    ran = setTimeout(() => (box.evalRan = false), RAN_MS);
    const t0 = performance.now();
    let result: { ok: boolean } & Record<string, unknown>;
    try {
      const value = await compile(code)();
      result = {
        ok: true,
        ms: Math.round(performance.now() - t0),
        value: summarize(value),
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result = {
        ok: false,
        error: `${err.name}: ${err.message}`.slice(0, 1000),
        stack: (err.stack ?? "").slice(0, 2000),
      };
    }
    opts.onEval?.({ id, ...result });
    send(sock, { type: "result", id, to, ...result });
  };

  const reset = () => {
    box.live = false;
    box.pending = null;
    box.sessions = [];
    box.pages = [];
    box.busy = false;
  };

  const connect = () => {
    if (ws) return;
    const label = (sentLabel = pageLabel());
    const sock = new WebSocket(socketUrl(opts.url, label));
    ws = sock;
    sock.onopen = () => {
      opened.add(sock);
      box.live = true;
    };
    sock.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "friend-status":
          box.friend = true;
          box.notice = msg.status === "blocked" ? "Chat is not available for this account." : "";
          return;
        case "rate-limited": {
          const min = Math.max(1, Math.ceil(Number(msg.retryIn) / 60_000) || 1);
          box.warning = `Too many messages: that one was not sent. Try again in ${min} min.`;
          return;
        }
        case "state": {
          const s = msg as HubState;
          box.pending = (s.pending as PairInfo | null) ?? null;
          box.sessions = Array.isArray(s.sessions) ? s.sessions : [];
          box.listeners = s.listeners ?? box.sessions.length;
          box.pages = Array.isArray(s.pages) ? s.pages : [];
          const self = typeof s.self === "string" ? s.self : "";
          box.self = self;
          // The hub's id for this tab (ours, or a fresh one if ours was taken).
          savePageId(self);
          return;
        }
        case "busy":
          // One beat; the box times the spinner out and ends it on a reply.
          box.beat();
          return;
        case "history":
          if (Array.isArray(msg.messages))
            box.messages = trimHistory(msg.messages as ChatMessage[]);
          return;
        case "chat": {
          const m = msg.message as ChatMessage | undefined;
          if (!m || typeof m !== "object") return;
          // Live only: history is never read aloud (push reads an agent's).
          box.push(m);
          if (m.from !== "agent") box.warning = "";
          return;
        }
        case "eval":
          if (!opts.evalCode) return;
          if (typeof msg.id !== "string" || typeof msg.to !== "string") return;
          if (typeof msg.code !== "string") return;
          void run(sock, msg.id, msg.to, msg.code);
          return;
      }
    };
    // Dropped by the network: reopen if still wanted. One that never opened
    // was refused, and one the hub closed on purpose (4xxx) stays closed,
    // until the next visibility change or update().
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      reset();
      if (opened.has(sock) && e.code < 4000 && wanted()) connect();
    };
  };

  const disconnect = () => {
    clearTimeout(idle);
    const sock = ws;
    ws = null;
    reset();
    sock?.close();
  };

  const update = () => {
    clearTimeout(idle);
    if (wanted()) connect();
    else if (closed || !(opts.wanted?.() ?? true)) disconnect();
    else if (ws) idle = setTimeout(disconnect, IDLE_MS);
  };

  box.onSend = (text) => send(ws, { type: "chat", id: crypto.randomUUID().slice(0, 12), text });
  box.onAnswer = (type, p, answer) =>
    void send(
      ws,
      type === "deny"
        ? { type, pair: p.pair }
        : {
            type,
            pair: p.pair,
            ...(answer.pages ? { pages: answer.pages } : {}),
            ...(answer.scope ? { scope: answer.scope } : {}),
          },
    );
  box.onEnd = (p) => void send(ws, { type: "revoke", pair: p.pair });
  box.onEndPage = (id) => void send(ws, { type: "end-page", id });

  // Client-side navigation: tell the hub this page's new label (debounced),
  // so agents hear page-changed. History API calls and back/forward both.
  const navigated = () => {
    clearTimeout(nav);
    nav = setTimeout(() => {
      const label = pageLabel();
      if (label === sentLabel) return;
      if (send(ws, { type: "page", label })) sentLabel = label;
    }, PAGE_DEBOUNCE_MS);
  };
  const unhook: (() => void)[] = [];
  if (opts.trackPages !== false) {
    for (const k of ["pushState", "replaceState"] as const) {
      const orig = history[k];
      history[k] = function (this: History, ...a: Parameters<History["pushState"]>) {
        const r = orig.apply(this, a);
        navigated();
        return r;
      };
      unhook.push(() => (history[k] = orig));
    }
    addEventListener("popstate", navigated);
    unhook.push(() => removeEventListener("popstate", navigated));
  }

  document.addEventListener("visibilitychange", update);
  update();
  return {
    update,
    close() {
      closed = true;
      document.removeEventListener("visibilitychange", update);
      clearTimeout(ran);
      clearTimeout(nav);
      for (const u of unhook) u();
      disconnect();
    },
  };
}
