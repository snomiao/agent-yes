// In-page agent sensor: `import { AyWidget } from "agent-yes/widgets"`.
//
// The page-side counterpart of `ay widget`. It registers with a serving `ay serve`
// daemon, holds an SSE command channel, and answers read requests an agent issues
// (`ay widget read selection|dom … <viewer>`) — turning a page the author embedded
// it into a high-quality context source for the page's owning agent. Complements
// rechrome (rech drives any page; this reads a page the author OPTED IN, and works
// cross-origin / for WebRTC-remote viewers with no extension).
//
//   new AyWidget({ id: "report-A", sensors: ["selection", "dom"] }).start();
//
// SECURITY — dual consent: a read runs only if BOTH (a) the daemon authorized the
// caller (scoped-token 'read'/'screenshot' cap, or master token) AND (b) the page
// author enabled that kind here (`sensors`). Every read flashes a visible indicator
// so the viewer sees collection happen. Nothing is stored on the daemon — it only
// brokers the request/response. Screenshot is a later slice (needs the html2canvas
// bundle + the WebGL snapshot hook); this build ships selection + dom.
//
// DOM is accessed as `any` (the Node tsconfig has no DOM lib); it only runs in a browser.

export interface AyWidgetInfo {
  /** Stable author-assigned id for deterministic addressing (`ay widget read … report-A`). Optional. */
  id?: string;
  /** Daemon origin, e.g. "https://box.local:8787". Default "" = same-origin. */
  origin?: string;
  /** Token: default discovered from window.AY_TERM_TOKEN / #k= / localStorage. */
  token?: string;
  /** Kinds the author allows an agent to read: "selection" | "dom" | "screenshot". Default none. */
  sensors?: string[];
  /**
   * Author opt-in exact-capture hooks, keyed by CSS selector → a function returning
   * a data: URL. Lets `read screenshot` capture a WebGL/`<canvas>` (three.js) view that
   * html2canvas can't — the widget calls the hook when a screenshot targets that element.
   * (Consumed by the screenshot slice; declared here so the API is stable.)
   */
  snapshots?: Record<string, () => string>;
}

type Handler = (args: any) => Promise<unknown>;

export class AyWidget {
  readonly origin: string;
  private token: string;
  private wantId?: string;
  private viewerId = "";
  private sensors: Set<string>;
  private snapshots: Record<string, () => string>;
  private es?: any;
  private started = false;
  private handlers = new Map<string, Handler>();
  private indicator?: any;

  constructor(info: AyWidgetInfo = {}) {
    this.origin = (info.origin ?? "").replace(/\/+$/, "");
    this.token = info.token ?? discoverToken();
    this.wantId = info.id;
    this.sensors = new Set(info.sensors ?? []);
    this.snapshots = info.snapshots ?? {};
    // Built-in, always-allowed liveness probe (used by `ay widget ls`/addressing).
    this.handlers.set("ping", async () => ({ caps: [...this.sensors], id: this.viewerId }));
    this.handlers.set("selection", readSelection);
    this.handlers.set("dom", readDom);
  }

  private url(path: string): string {
    const p = this.token
      ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`
      : path;
    return this.origin + p;
  }

  /** Register with the daemon and open the command channel. Idempotent. */
  async start(): Promise<string> {
    if (this.started) return this.viewerId;
    this.started = true;
    const g = globalThis as any;
    const doc = g.document;
    const res = await g.fetch(this.url("/api/widget/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: this.wantId,
        url: g.location?.href ?? "",
        title: doc?.title ?? "",
        caps: [...this.sensors],
      }),
    });
    if (!res.ok) throw new Error(`widget register failed: ${res.status}`);
    this.viewerId = ((await res.json()) as { viewerId: string }).viewerId;
    this.openPoll();
    return this.viewerId;
  }

  private openPoll(): void {
    const g = globalThis as any;
    const es = new g.EventSource(this.url(`/api/widget/poll/${encodeURIComponent(this.viewerId)}`));
    es.onmessage = (e: any) => {
      let cmd: { cmdId?: string; kind?: string; args?: unknown };
      try {
        cmd = JSON.parse(e.data);
      } catch {
        return; // keepalive
      }
      if (cmd.cmdId && cmd.kind) void this.dispatch(cmd.cmdId, cmd.kind, cmd.args ?? {});
    };
    // EventSource auto-reconnects; nothing else to wire.
    this.es = es;
  }

  private async dispatch(cmdId: string, kind: string, args: any): Promise<void> {
    this.flash();
    const handler = this.handlers.get(kind);
    // Author allowlist: only "ping" is implicit; sensor kinds must be opted in.
    if (!handler || (kind !== "ping" && !this.sensors.has(kind))) {
      return this.postResult(cmdId, { ok: false, error: `kind '${kind}' not enabled on this widget` });
    }
    try {
      const data = await handler(args);
      await this.postResult(cmdId, { ok: true, data });
    } catch (e: any) {
      await this.postResult(cmdId, { ok: false, error: String(e?.message ?? e) });
    }
  }

  private async postResult(cmdId: string, r: { ok: boolean; data?: unknown; error?: string }): Promise<void> {
    const g = globalThis as any;
    try {
      await g.fetch(this.url("/api/widget/result"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmdId, ...r }),
      });
    } catch {
      /* best-effort; the CLI read times out if this never lands */
    }
  }

  /** A brief visible pulse so the viewer always sees a collection happen. */
  private flash(): void {
    const g = globalThis as any;
    const doc = g.document;
    if (!doc) return;
    if (!this.indicator) {
      const el = doc.createElement("div");
      el.setAttribute("data-aywidget-indicator", this.viewerId || "1");
      el.style.cssText =
        "position:fixed;right:14px;bottom:14px;width:12px;height:12px;border-radius:50%;" +
        "background:#1f6feb;box-shadow:0 0 0 0 rgba(31,111,235,.6);z-index:2147483000;" +
        "opacity:0;transition:opacity .15s;pointer-events:none";
      (doc.body ?? doc.documentElement).appendChild(el);
      this.indicator = el;
    }
    const el = this.indicator;
    el.style.opacity = "1";
    el.animate?.(
      [
        { boxShadow: "0 0 0 0 rgba(31,111,235,.6)" },
        { boxShadow: "0 0 0 10px rgba(31,111,235,0)" },
      ],
      { duration: 600 },
    );
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.style.opacity = "0"), 500);
  }

  stop(): void {
    this.es?.close?.();
    this.es = undefined;
    this.indicator?.remove?.();
    this.indicator = undefined;
    this.started = false;
  }
}

async function readSelection(): Promise<{ text: string; html: string }> {
  const g = globalThis as any;
  const sel = g.getSelection?.();
  const text = sel ? String(sel) : "";
  let html = "";
  if (sel && sel.rangeCount) {
    const div = g.document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) div.appendChild(sel.getRangeAt(i).cloneContents());
    html = div.innerHTML;
  }
  return { text, html };
}

async function readDom(args: { selector?: string; all?: boolean }): Promise<{
  matches: number;
  outerHTML: string[];
}> {
  const g = globalThis as any;
  const selector = args?.selector;
  if (!selector) throw new Error("dom read needs a --selector");
  const nodes: any[] = args?.all
    ? [...g.document.querySelectorAll(selector)]
    : [g.document.querySelector(selector)].filter(Boolean);
  return { matches: nodes.length, outerHTML: nodes.map((n) => String(n.outerHTML ?? "")) };
}

/** window.AY_TERM_TOKEN → page `#k=` hash → localStorage["ay.localToken"]. */
function discoverToken(): string {
  const g = globalThis as any;
  if (g.AY_TERM_TOKEN) return String(g.AY_TERM_TOKEN);
  try {
    const parts: string[] = (g.location?.hash ?? "").slice(1).split("&");
    const k = parts.find((s) => s.startsWith("k="));
    if (k) return decodeURIComponent(k.slice(2));
    const stored = g.localStorage?.getItem("ay.localToken");
    if (stored) return stored;
  } catch {
    /* no DOM */
  }
  return "";
}

export default AyWidget;
