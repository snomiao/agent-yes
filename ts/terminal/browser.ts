// Browser terminal client: `import AyTerminal from "agent-yes/terminal"`.
//
// A self-contained floating widget (Shadow DOM) that renders a LIVE, READ-ONLY
// mirror of an agent session's PTY on any page — the terminal sibling of
// AyChannel (channels/browser.ts). It streams the agent's raw PTY bytes from the
// serving `ay serve` daemon's SSE endpoint (`GET /api/tail/<pid>?raw=1`) into an
// xterm.js terminal, sizing the grid to the agent's NATIVE PTY (via /api/size)
// and visually CSS-scaling it to fit — it never pushes a resize back, so a viewer
// can never reflow the agent's real terminal. This is the read-only model the
// rgui embed (lab/ui/rgui/main.ts `initEmbed`) already proved.
//
//   const t = new AyTerminal({ pid: "12345" });   // token auto-discovered
//   t.mount(document.getElementById("term"));      // inline, or t.mount() to float
//
// PHASE 1 = SAME-ORIGIN, READ-ONLY. `/api/tail` + `/api/send` are token-gated and
// emit NO CORS headers, so this widget must load same-origin with the daemon (the
// report page is served by `ay serve --http`), or the daemon origin must be in the
// embedding page's connect-src AND the daemon must allow the origin (phase 2 uses
// the WebRTC `--share` transport to reach an arbitrary-origin page). Interactive
// input (keystrokes/send) is deliberately NOT wired here — that's a later phase,
// gated on an explicit opt-in, because typing into a terminal drives the agent's
// box.

// xterm is bundled in (both the npm dist build and the /w/terminal.js CDN bundle)
// so the widget is self-contained — no CDN <script> the embedding page's CSP must
// allow. Its stylesheet is injected into the Shadow root (below), since
// `:host { all: initial }` + Shadow DOM isolates the page's styles from it.
// Imported for the value (the constructor); typed as `any` at every use site
// because the Node tsconfig has no DOM lib (xterm's own types reference DOM types).
import { Terminal } from "@xterm/xterm";

export interface AyTerminalInfo {
  /** Agent pid or any keyword `ay` can resolve (passed to /api/tail/<keyword>). */
  pid: string | number;
  /** Daemon origin, e.g. "https://box.local:8787". Default "" = same-origin (relative URLs). */
  origin?: string;
  /** Serve token. Default: discovered from window.AY_TERM_TOKEN, the page #k= hash, or localStorage. */
  token?: string;
  /** Read-only mirror. Phase 1 is always read-only; the flag is reserved for a later interactive opt-in. */
  readOnly?: boolean;
  /** Header label; default `#<pid>`. */
  title?: string;
}

export class AyTerminal {
  readonly pid: string;
  readonly origin: string;
  readonly readOnly: boolean;
  title: string;
  private token: string;
  private term?: any; // xterm Terminal (typed any — no DOM lib in the Node tsconfig)
  private es?: any; // EventSource
  private widget?: any;
  private started = false;
  private writable = false; // flips false on the first /api/send 403 (token is read-only)

  constructor(info: string | number | AyTerminalInfo) {
    const o: AyTerminalInfo =
      typeof info === "string" || typeof info === "number" ? { pid: info } : info;
    if (o.pid === undefined || o.pid === null || o.pid === "")
      throw new Error("AyTerminal: need a pid/keyword");
    this.pid = String(o.pid);
    this.origin = (o.origin ?? "").replace(/\/+$/, ""); // "" ⇒ same-origin relative URLs
    this.readOnly = o.readOnly !== false; // default true; phase 1 never wires input
    this.token = o.token ?? discoverToken();
    this.title = o.title ?? `#${this.pid}`;
  }

  /** URL to a daemon API path with the token appended as a query param (EventSource can't set headers). */
  private url(path: string): string {
    const p = this.token
      ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`
      : path;
    return this.origin + p;
  }

  /**
   * Create the xterm, size its grid to the agent's native PTY, and subscribe to
   * the raw SSE stream. `el` is the element the terminal renders into.
   */
  async start(el: any): Promise<void> {
    if (this.started) return;
    this.started = true;
    const g = globalThis as any;
    this.writable = !this.readOnly;
    this.term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: TERM_THEME,
      disableStdin: this.readOnly, // read-only mirror unless an interactive token was supplied
      cursorBlink: !this.readOnly,
      scrollback: 2000,
      convertEol: false,
    });
    this.term.open(el);

    // Size the grid to the agent's own PTY so absolute-cursor raw bytes land in
    // the right cells; we only READ /api/size and never POST a resize back.
    try {
      const res = await g.fetch(this.url(`/api/size/${encodeURIComponent(this.pid)}`), {
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const sz = (await res.json()) as { cols?: number; rows?: number };
        if (sz?.cols && sz?.rows) this.term.resize(sz.cols, sz.rows);
      }
    } catch {
      /* keep the default grid — the stream still redraws on the next full repaint */
    }

    // SSE: each `data:` frame is a JSON-encoded raw chunk (`: ping` keepalives are
    // non-JSON and ignored). Replays the last ~64KB on connect so the view converges.
    const es = new g.EventSource(this.url(`/api/tail/${encodeURIComponent(this.pid)}?raw=1`));
    es.onmessage = (e: any) => {
      try {
        this.term!.write(JSON.parse(e.data) as string);
      } catch {
        /* keepalive / non-JSON frame */
      }
    };
    this.es = es;

    // Interactive input (opt-in): forward keystrokes to the agent's stdin as raw
    // bytes (code:"none" = no trailing Enter — the terminal itself sends \r). Only
    // when a WRITABLE token was supplied; a read-only token that reaches here 403s,
    // and we fail closed — disable stdin so the widget silently reverts to a mirror.
    // This is the same discipline as the rgui embed's attachStdin/onDenied.
    if (!this.readOnly) {
      this.term.onData((data: string) => {
        if (!this.writable) return;
        void g
          .fetch(this.url("/api/send"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ keyword: this.pid, msg: data, code: "none" }),
          })
          .then((r: any) => {
            if (r.status === 403 || r.status === 401) {
              this.writable = false;
              this.term.options.disableStdin = true;
              this.term.options.cursorBlink = false;
            }
          })
          .catch(() => {
            /* transient network error — keep trying on the next keystroke */
          });
      });
    }
  }

  /** Tear down the stream, the terminal, and the mounted widget. */
  close(): void {
    this.es?.close();
    this.es = undefined;
    this.term?.dispose();
    this.term = undefined;
    if (this.widget) {
      this.widget.remove();
      this.widget = undefined;
    }
    this.started = false;
  }

  /**
   * Render the widget. With a `target` element it embeds inline, filling that
   * element (the report-page case); with no target it mounts a floating panel
   * with a toggle bubble in the corner (like AyChannel). Auto-calls start().
   */
  mount(target?: any, opts?: { open?: boolean }): any {
    if (this.widget) return this.widget;
    const doc: any = (globalThis as any).document;
    const host = doc.createElement("div");
    host.setAttribute("data-ayterminal", this.pid);
    const root = host.attachShadow({ mode: "open" });
    const inline = !!target;
    root.innerHTML = widgetHtml(inline, this.title, this.readOnly);
    this.widget = host;
    (target ?? doc.body).appendChild(host);

    const panel = root.getElementById("panel")!;
    const inner = root.getElementById("inner")!;
    const wrap = root.getElementById("wrap")!;

    // Scale the native-grid terminal to FIT the wrap box (never upscale past 1:1),
    // exactly like the rgui embed — the grid stays the agent's size, only pixels scale.
    const fit = () => {
      const xt = inner.querySelector(".xterm") as any;
      if (!xt || !xt.offsetWidth || !xt.offsetHeight) return;
      const s = Math.min(1, wrap.clientWidth / xt.offsetWidth, wrap.clientHeight / xt.offsetHeight);
      inner.style.transform = `scale(${s})`;
    };

    if (inline) {
      // fill the target; make it a positioning context if it is statically positioned
      try {
        const cs = (globalThis as any).getComputedStyle?.(target);
        if (cs && cs.position === "static") target.style.position = "relative";
      } catch {
        /* no getComputedStyle */
      }
    } else {
      const toggle = root.getElementById("toggle")!;
      toggle.addEventListener("click", () => panel.classList.toggle("open"));
      if (opts?.open) panel.classList.add("open");
    }

    const g = globalThis as any;
    g.addEventListener?.("resize", fit);
    void (async () => {
      await this.start(inner);
      // let xterm lay out its rows before measuring, then fit a couple of times
      (g.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 16)))(() => {
        fit();
        setTimeout(fit, 150);
      });
    })();

    return host;
  }
}

/** window.AY_TERM_TOKEN → page `#k=` hash → localStorage["ay.localToken"] (the rgui/console cache). */
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

const TERM_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  selectionBackground: "#264f78",
};

/**
 * Shadow-DOM markup + styles. Self-contained (xterm's own stylesheet is inlined
 * below so it applies inside the isolated shadow root). Inline mode fills the
 * target; floating mode is a corner bubble + panel like AyChannel.
 */
function widgetHtml(inline: boolean, title: string, readOnly: boolean): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const badge = readOnly
    ? `<span class="ro" title="read-only mirror">read-only</span>`
    : `<span class="rw" title="interactive — type to the agent">interactive</span>`;
  const chrome = inline
    ? `
  #panel { position: absolute; inset: 0; display: flex; }
  #wrap { border-radius: 0; }
`
    : `
  #toggle {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
    background: #0d1117; color: #c9d1d9; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.4);
    border: 1px solid #30363d;
  }
  #panel {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483000;
    width: min(720px, 94vw); height: min(460px, 72vh); display: none;
  }
  #panel.open { display: flex; }
`;
  return `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  ${chrome}
  #panel { flex-direction: column; background: #0d1117; border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; border: 1px solid #30363d; }
  header { padding: 7px 11px; background: #161b22; display: flex; align-items: center; gap: 8px;
    font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d1d9; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; flex: none; }
  header .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .ro { font-size: 10px; opacity: .7; background: #30363d; border-radius: 9px; padding: 1px 7px; }
  header .rw { font-size: 10px; background: #1f6feb; color: #fff; border-radius: 9px; padding: 1px 7px; }
  #wrap { flex: 1; position: relative; overflow: hidden; background: #0d1117; }
  #inner { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  ${XTERM_CSS}
</style>
${inline ? "" : `<button id="toggle" title="Terminal">🖥️</button>`}
<section id="panel">
  <header><span class="dot"></span><span class="title">${esc(title)}</span>${badge}</header>
  <div id="wrap"><div id="inner"></div></div>
</section>
`;
}

// xterm.js default stylesheet (v6), inlined so it applies inside the Shadow root.
// Upstream: node_modules/@xterm/xterm/css/xterm.css (MIT, xterm.js authors).
const XTERM_CSS = `
.xterm { cursor: text; position: relative; user-select: none; -ms-user-select: none; -webkit-user-select: none; }
.xterm.focus, .xterm:focus { outline: none; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.xterm .xterm-helper-textarea { padding: 0; border: 0; margin: 0; position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
.xterm .composition-view { background: #000; color: #FFF; display: none; position: absolute; white-space: nowrap; z-index: 1; }
.xterm .composition-view.active { display: block; }
.xterm .xterm-viewport { background-color: #000; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
.xterm.enable-mouse-events { cursor: default; }
.xterm.xterm-cursor-pointer, .xterm .xterm-cursor-pointer { cursor: pointer; }
.xterm.column-select.focus { cursor: crosshair; }
.xterm .xterm-accessibility:not(.debug), .xterm .xterm-message { position: absolute; left: 0; top: 0; bottom: 0; right: 0; z-index: 10; color: transparent; pointer-events: none; }
.xterm .xterm-accessibility-tree:not(.debug) *::selection { color: transparent; }
.xterm .xterm-accessibility-tree { font-family: monospace; user-select: text; white-space: pre; }
.xterm .xterm-accessibility-tree > div { transform-origin: left; width: fit-content; }
.xterm .live-region { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.xterm-dim { opacity: 1 !important; }
.xterm-underline-1 { text-decoration: underline; }
.xterm-underline-2 { text-decoration: double underline; }
.xterm-underline-3 { text-decoration: wavy underline; }
.xterm-underline-4 { text-decoration: dotted underline; }
.xterm-underline-5 { text-decoration: dashed underline; }
.xterm-overline { text-decoration: overline; }
.xterm-strikethrough { text-decoration: line-through; }
.xterm-screen .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer { z-index: 7; }
.xterm-decoration-overview-ruler { z-index: 8; position: absolute; top: 0; right: 0; pointer-events: none; }
.xterm-decoration-top { z-index: 2; position: relative; }
`;

export default AyTerminal;
