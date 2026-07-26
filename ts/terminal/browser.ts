// Browser terminal client: `import AyTerminal from "agent-yes/terminal"`.
//
// A self-contained Shadow-DOM widget that renders a LIVE agent-session terminal
// on any page — the terminal sibling of AyChannel (channels/browser.ts). It
// streams the agent's raw PTY bytes from the serving `ay serve` daemon's SSE
// endpoint (`GET /api/tail/<pid>?raw=1`) into an xterm.js terminal.
//
//   const t = new AyTerminal({ pid: "12345" });   // token auto-discovered
//   t.mount(document.getElementById("term"));      // inline, or t.mount() to float
//
// The grid is ALWAYS sized to the agent's NATIVE PTY (via /api/size) and CSS-scaled
// to fit the panel — the widget NEVER resizes the agent's real terminal, so opening
// or resizing this (secondary) view can't reflow the agent's own/other viewers' TUI.
// READ-ONLY by default (a mirror). INTERACTIVE (an explicit opt-in gated on a
// send-capable token) additionally forwards keystrokes (→ /api/send), failing closed
// to a mirror on a 403. (Explicit viewer-driven PTY renegotiation is future work — it
// must go through the daemon's size negotiation, not a raw per-widget /api/resize.)
//
// The floating widget is a draggable, resizable window with OS-native min/max
// controls; `transparent:true` lets it float over page content. xterm + its CSS
// are bundled/inlined so the widget is self-contained — no CDN <script> the
// embedding page's CSP must allow. Its stylesheet is injected into the Shadow root
// (`:host { all: initial }` isolates the page's styles from it).
//
// DOM/xterm are accessed as `any` throughout because the Node tsconfig has no DOM
// lib (xterm's own types reference DOM types); the widget only ever runs in a browser.
import { Terminal } from "@xterm/xterm";

export interface AyTerminalInfo {
  /** Agent pid or any keyword `ay` can resolve (passed to /api/tail/<keyword>). */
  pid: string | number;
  /** Daemon origin, e.g. "https://box.local:8787". Default "" = same-origin (relative URLs). */
  origin?: string;
  /** Serve token. Default: discovered from window.AY_TERM_TOKEN, the page #k= hash, or localStorage. */
  token?: string;
  /** Interactive when false (type to the agent); read-only mirror when true (default). Never resizes the PTY. */
  readOnly?: boolean;
  /** Header label; default a rich title fetched from /api/ls, falling back to `#<pid>`. */
  title?: string;
  /** Semi-transparent panel + xterm allowTransparency, so the terminal floats over page content. */
  transparent?: boolean;
  /** Window-control button side: "left" (macOS traffic-light) | "right" (Win/Linux) | "auto" (OS-detect, default). */
  controls?: "left" | "right" | "auto";
}

export class AyTerminal {
  readonly pid: string;
  readonly origin: string;
  readonly readOnly: boolean;
  readonly transparent: boolean;
  title: string;
  private token: string;
  private controls: "left" | "right" | "auto";
  private term?: any; // xterm Terminal
  private es?: any; // EventSource
  private widget?: any;
  private badgeEl?: any; // the interactive/read-only header badge (flipped on a 403)
  private started = false;
  private writable = false; // flips false on the first /api/send 403 (token is read-only)
  private capViewerId = ""; // stable presence id for this widget's size cap (interactive)
  private capTimer: any = null; // debounce for cap reports on drag-resize
  private capHeartbeat: any = null; // keeps the cap renewed while the panel is open
  private lastCap: { cols: number; rows: number } | null = null;

  constructor(info: string | number | AyTerminalInfo) {
    const o: AyTerminalInfo =
      typeof info === "string" || typeof info === "number" ? { pid: info } : info;
    if (o.pid === undefined || o.pid === null || o.pid === "")
      throw new Error("AyTerminal: need a pid/keyword");
    this.pid = String(o.pid);
    this.origin = (o.origin ?? "").replace(/\/+$/, ""); // "" ⇒ same-origin relative URLs
    this.readOnly = o.readOnly !== false; // default true
    this.transparent = o.transparent === true;
    this.controls = o.controls ?? "auto";
    this.token = o.token ?? discoverToken();
    this.title = o.title ?? `#${this.pid}`;
    this.capViewerId = `wterm-${this.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Report this panel's readable capacity as a size cap (interactive only), so the
   * daemon's negotiation (3a/3b) can shrink the shared PTY to what the panel shows —
   * the "drag the widget to resize the agent" behavior, but through the same
   * smallest-client-wins negotiation as every other viewer (bounded by the operator's
   * local terminal + the 40×10 floor), NOT a raw /api/resize that scrambled everyone.
   * Debounced so a drag doesn't spam. Read-only widgets never report (pure observers).
   */
  private sendCap(cols: number, rows: number): void {
    const g = globalThis as any;
    void g
      .fetch(this.url("/api/presence"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewer: this.capViewerId, agent: this.pid, cap: { cols, rows } }),
      })
      .catch(() => {});
  }

  private reportCap(cols: number, rows: number): void {
    if (this.readOnly || !this.capViewerId) return;
    // Dead-band: ignore ±1-cell jitter so the resize→PTY→redraw feedback loop can't
    // churn the shared size (grocy: avoid second-level flicker).
    if (
      this.lastCap &&
      Math.abs(this.lastCap.cols - cols) <= 1 &&
      Math.abs(this.lastCap.rows - rows) <= 1
    ) {
      this.ensureCapHeartbeat();
      return;
    }
    this.lastCap = { cols, rows };
    clearTimeout(this.capTimer);
    this.capTimer = setTimeout(() => this.sendCap(cols, rows), 250);
    this.ensureCapHeartbeat();
  }

  /**
   * Renew the cap every ~5s while the panel is open — the daemon TTLs a viewer cap
   * (~12s) to drop tabs that vanish, so a static open panel MUST keep refreshing or
   * its cap silently expires and the negotiated size springs back (grocy's bug).
   */
  private ensureCapHeartbeat(): void {
    if (this.capHeartbeat || this.readOnly) return;
    const g = globalThis as any;
    this.capHeartbeat = (g.setInterval ?? setInterval)(() => {
      if (this.lastCap) this.sendCap(this.lastCap.cols, this.lastCap.rows);
    }, 5000);
  }

  /** Withdraw this widget's size cap (closed/minimized) → the daemon re-negotiates without it. */
  private withdrawCap(): void {
    if (this.capHeartbeat) {
      clearInterval(this.capHeartbeat);
      this.capHeartbeat = null;
    }
    this.lastCap = null;
    clearTimeout(this.capTimer);
    if (this.readOnly || !this.capViewerId) return;
    const g = globalThis as any;
    void g
      .fetch(this.url("/api/presence"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewer: this.capViewerId, agent: null }),
      })
      .catch(() => {});
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
      theme: this.transparent ? { ...TERM_THEME, background: "rgba(13,17,23,0)" } : TERM_THEME,
      allowTransparency: this.transparent, // construction-time — can't be toggled later
      disableStdin: this.readOnly,
      cursorBlink: !this.readOnly,
      scrollback: 2000,
      convertEol: false,
    });
    this.term.open(el);

    // Size the grid to the agent's own PTY so absolute-cursor raw bytes land in
    // the right cells; we only READ /api/size and never POST a resize here.
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
    // bytes (code:"none" — the terminal itself sends \r). Fails closed to a mirror
    // on a 403 (a read-only token), like the rgui embed's attachStdin/onDenied.
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
            if (r.status === 403 || r.status === 401) this.revokeWrite();
          })
          .catch(() => {
            /* transient network error — keep trying on the next keystroke */
          });
      });
    }
  }

  /**
   * A write path (send/resize) was refused (403/401) — the token is read-only.
   * Fail closed: stop sending, disable stdin, and flip the header badge so the
   * viewer SEES it reverted to a mirror (grocy: the badge must reflect the state).
   */
  private revokeWrite(): void {
    if (!this.writable) return; // already reverted — flip once
    this.writable = false;
    if (this.term) {
      this.term.options.disableStdin = true;
      this.term.options.cursorBlink = false;
    }
    if (this.badgeEl) {
      this.badgeEl.className = "ro";
      this.badgeEl.textContent = "read-only";
      this.badgeEl.title = "reverted to read-only — this token can't write to the agent";
    }
  }

  /** Tear down the stream, the terminal, and the mounted widget. */
  close(): void {
    this.withdrawCap(); // stop counting this panel's size in the shared negotiation
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
   * element (the report-page case); with no target it mounts a floating,
   * draggable, resizable window with a corner bubble. Auto-calls start().
   */
  mount(target?: any, opts?: { open?: boolean }): any {
    if (this.widget) return this.widget;
    const g = globalThis as any;
    const doc: any = g.document;
    const host = doc.createElement("div");
    host.setAttribute("data-ayterminal", this.pid);
    const root = host.attachShadow({ mode: "open" });
    const inline = !!target;
    const side = controlsSide(this.controls);
    root.innerHTML = widgetHtml({ inline, title: this.title, readOnly: this.readOnly, side });
    this.widget = host;
    if (opts?.open) host.setAttribute("data-open", "1");
    (target ?? doc.body).appendChild(host);

    const panel = root.getElementById("panel")!;
    const inner = root.getElementById("inner")!;
    const wrap = root.getElementById("wrap")!;
    const titleEl = root.getElementById("title")!;
    this.badgeEl = root.getElementById("badge");
    if (this.transparent) panel.classList.add("transparent");

    // Reflow: read-only CSS-scales the native grid to fit; interactive fits the
    // grid to the container and pushes the new PTY size to the agent.
    // Both read-only AND interactive render the terminal at the agent's NATIVE PTY
    // grid and CSS-scale it to fit the panel — NEVER resizing the shared PTY. A
    // widget panel is a SECONDARY view; auto-resizing the agent's real terminal to
    // a small floating panel (or, worse, a mis-measured viewport) scrambled the
    // agent's own/other viewers' TUI (taku's "xterm looks weird"). Interactive only
    // adds keystroke input (start(), /api/send), not a resize.
    const reflow = () => {
      const xt = inner.querySelector(".xterm") as any;
      if (!xt || !xt.offsetWidth || !xt.offsetHeight) return;
      const s = Math.min(1, wrap.clientWidth / xt.offsetWidth, wrap.clientHeight / xt.offsetHeight);
      inner.style.transform = `scale(${s})`;
      // 3c: an interactive panel reports how many cols/rows it can show as a size
      // cap (derived from the wrap vs the native grid's pixel size), so dragging the
      // widget renegotiates the shared PTY — through the daemon's min, bounded by the
      // operator's local cap + floor, never a raw resize.
      if (!this.readOnly && this.term?.cols) {
        const capCols = Math.max(1, Math.floor((wrap.clientWidth * this.term.cols) / xt.offsetWidth));
        const capRows = Math.max(1, Math.floor((wrap.clientHeight * this.term.rows) / xt.offsetHeight));
        this.reportCap(capCols, capRows);
      }
    };

    if (inline) {
      try {
        const cs = g.getComputedStyle?.(target);
        if (cs && cs.position === "static") target.style.position = "relative";
      } catch {
        /* no getComputedStyle */
      }
    } else {
      this.wireWindow(root, panel, doc, reflow);
    }

    // Reflow on container size changes (drag-resize, maximize, viewport resize).
    try {
      new g.ResizeObserver(() => reflow()).observe(wrap);
    } catch {
      /* no ResizeObserver — fall back to the window listener below */
    }
    g.addEventListener?.("resize", reflow);

    void (async () => {
      await this.start(inner);
      void this.applyRichTitle(titleEl);
      (g.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 16)))(() => {
        reflow();
        setTimeout(reflow, 150);
      });
    })();

    return host;
  }

  /**
   * Window chrome for the floating panel: restore saved geometry, drag-move by the
   * titlebar, minimize (→ corner bubble) / maximize (→ full viewport) controls.
   */
  private wireWindow(root: any, panel: any, doc: any, reflow: () => void): void {
    const toggle = root.getElementById("toggle")!;
    const titlebar = root.getElementById("titlebar")!;
    const showPanel = (on: boolean) => {
      panel.classList.toggle("open", on);
      toggle.style.display = on ? "none" : "";
      // Minimizing hides the panel → withdraw its size cap so it stops constraining
      // the shared PTY; opening re-reports via reflow.
      if (on) reflow();
      else this.withdrawCap();
    };
    toggle.addEventListener("click", () => showPanel(true));
    root.getElementById("min")?.addEventListener("click", () => showPanel(false));
    root.getElementById("max")?.addEventListener("click", () => {
      panel.classList.toggle("max");
      this.saveGeom(panel);
      reflow();
    });

    // Restore saved geometry (position + size), else the CSS default corner.
    const geom = this.loadGeom();
    if (geom) {
      panel.style.left = geom.left + "px";
      panel.style.top = geom.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.width = geom.width + "px";
      panel.style.height = geom.height + "px";
    }

    // Drag-move by the titlebar (but not when a control button is the target).
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    titlebar.addEventListener("mousedown", (e: any) => {
      if (e.target?.closest?.("[data-ctl]") || panel.classList.contains("max")) return;
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      e.preventDefault();
    });
    doc.addEventListener("mousemove", (e: any) => {
      if (!dragging) return;
      panel.style.left = ox + (e.clientX - sx) + "px";
      panel.style.top = oy + (e.clientY - sy) + "px";
    });
    doc.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      this.saveGeom(panel);
    });
    // CSS `resize:both` drag ends without a mouseup we can catch on the handle, so
    // persist geometry after any resize settles (the ResizeObserver drives reflow).
    try {
      let t: any = null;
      new (globalThis as any).ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => this.saveGeom(panel), 300);
      }).observe(panel);
    } catch {
      /* no ResizeObserver */
    }

    if (opts_open(root)) showPanel(true);
  }

  private geomKey(): string {
    return `ay29term:${this.pid}:geom`;
  }
  private loadGeom(): { left: number; top: number; width: number; height: number } | null {
    try {
      const raw = (globalThis as any).localStorage?.getItem(this.geomKey());
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (["left", "top", "width", "height"].every((k) => typeof o[k] === "number")) return o;
    } catch {
      /* ignore */
    }
    return null;
  }
  private saveGeom(panel: any): void {
    try {
      if (panel.classList.contains("max")) return; // don't persist the maximized rect
      const r = panel.getBoundingClientRect();
      (globalThis as any).localStorage?.setItem(
        this.geomKey(),
        JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height }),
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * Replace the bare `#pid` title with a rich one (repo/branch · cli) from the
   * /api/size metadata — that route is already allowed + CORS'd for a scoped token
   * (and bound to this pid), so no need to expose /api/ls to a page embed.
   */
  private async applyRichTitle(titleEl: any): Promise<void> {
    const g = globalThis as any;
    try {
      const res = await g.fetch(this.url(`/api/size/${encodeURIComponent(this.pid)}`), {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const rec = (await res.json()) as { cwd?: string; cli?: string };
      const rich = richTitle(rec);
      if (rich && titleEl) {
        titleEl.textContent = rich;
        titleEl.title = `#${this.pid}${rec.cwd ? " · " + rec.cwd : ""}`; // pid + full cwd tooltip
        this.title = rich;
      }
    } catch {
      /* keep the fallback title */
    }
  }
}

function opts_open(root: any): boolean {
  return root.host?.getAttribute?.("data-open") === "1";
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

/** OS-adaptive control side: macOS → left (traffic-light), Win/Linux → right. */
function controlsSide(pref: "left" | "right" | "auto"): "left" | "right" {
  if (pref === "left" || pref === "right") return pref;
  try {
    const nav = (globalThis as any).navigator;
    const plat = String(nav?.userAgentData?.platform ?? nav?.platform ?? "").toLowerCase();
    return plat.includes("mac") ? "left" : "right";
  } catch {
    return "right";
  }
}

/** A console-style rich title from an /api/ls record: "repo/branch · <summary>". */
function richTitle(rec: any): string {
  const parts: string[] = [];
  const rb = repoBranch(String(rec?.cwd ?? ""));
  if (rb) parts.push(rb);
  const summary = rec?.title ?? rec?.summary ?? rec?.name ?? rec?.last_prompt ?? rec?.prompt;
  if (typeof summary === "string" && summary.trim()) parts.push(clip(summary.trim(), 48));
  else if (rec?.cli) parts.push(String(rec.cli));
  return parts.join(" · ");
}

/** ".../snomiao/grocy/tree/main" → "grocy/main"; degrades to the last path segment. */
function repoBranch(cwd: string): string {
  if (!cwd) return "";
  const segs = cwd.split(/[/\\]/).filter(Boolean);
  const ti = segs.lastIndexOf("tree");
  if (ti > 0 && segs[ti + 1]) return `${segs[ti - 1]}/${segs[ti + 1]}`;
  return segs.slice(-1)[0] ?? "";
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const TERM_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  selectionBackground: "#264f78",
};

/**
 * Shadow-DOM markup + styles. Self-contained (xterm's own stylesheet is inlined
 * so it applies inside the isolated shadow root). Inline mode fills the target;
 * floating mode is a corner bubble + a draggable, resizable window.
 */
function widgetHtml(o: {
  inline: boolean;
  title: string;
  readOnly: boolean;
  side: "left" | "right";
}): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const badge = o.readOnly
    ? `<span id="badge" class="ro" title="read-only mirror">read-only</span>`
    : `<span id="badge" class="rw" title="interactive — type &amp; drag-resize the agent">interactive</span>`;
  // macOS: traffic-light dots on the left; Win/Linux: _ □ buttons on the right.
  // Inline embeds have no window semantics (no bubble/move/maximize) → no controls.
  const controls = o.inline
    ? ""
    : o.side === "left"
      ? `<span class="ctl mac" data-ctl>
           <button id="min" class="dot yellow" data-ctl title="Minimize"></button>
           <button id="max" class="dot green" data-ctl title="Maximize"></button>
         </span>`
      : `<span class="ctl win" data-ctl>
           <button id="min" data-ctl title="Minimize">_</button>
           <button id="max" data-ctl title="Maximize">□</button>
         </span>`;
  const titleSpan = `<span class="title" id="title">${esc(o.title)}</span>`;
  const header =
    !o.inline && o.side === "left"
      ? `${controls}${titleSpan}${badge}`
      : `${titleSpan}${badge}${controls}`;
  const chrome = o.inline
    ? `#panel { position: absolute; inset: 0; display: flex; } #titlebar { cursor: default; }`
    : `
  #toggle {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    width: 52px; height: 52px; border-radius: 50%; cursor: pointer;
    background: #0d1117; color: #c9d1d9; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.4);
    border: 1px solid #30363d;
  }
  #panel {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483000;
    width: min(720px, 94vw); height: min(460px, 72vh); display: none;
    resize: both; min-width: 260px; min-height: 160px;
  }
  #panel.open { display: flex; }
  #panel.max { inset: 0 !important; left: 0 !important; top: 0 !important;
    right: 0 !important; bottom: 0 !important; width: auto !important; height: auto !important;
    border-radius: 0; resize: none; }
  #titlebar { cursor: move; }
`;
  return `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  ${chrome}
  #panel { flex-direction: column; background: #0d1117; border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; border: 1px solid #30363d; }
  #panel.transparent { background: rgba(13,17,23,.62); backdrop-filter: blur(3px); }
  #panel.transparent #wrap { background: transparent; }
  #titlebar { padding: 6px 10px; background: #161b22; display: flex; align-items: center; gap: 8px;
    font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d1d9; user-select: none; }
  #panel.transparent #titlebar { background: rgba(22,27,34,.7); }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ro { font-size: 10px; opacity: .7; background: #30363d; border-radius: 9px; padding: 1px 7px; }
  .rw { font-size: 10px; background: #1f6feb; color: #fff; border-radius: 9px; padding: 1px 7px; }
  .ctl { display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .ctl.win button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px;
    width: 20px; height: 18px; font: 12px monospace; cursor: pointer; line-height: 1; padding: 0; }
  .ctl.win button:hover { background: #30363d; }
  .ctl.mac .dot { width: 12px; height: 12px; border-radius: 50%; border: none; cursor: pointer; padding: 0; }
  .ctl.mac .dot.yellow { background: #febc2e; }
  .ctl.mac .dot.green { background: #28c840; }
  #wrap { flex: 1; position: relative; overflow: hidden; background: #0d1117; }
  #inner { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  ${XTERM_CSS}
</style>
${o.inline ? "" : `<button id="toggle" title="Terminal">🖥️</button>`}
<section id="panel">
  <header id="titlebar">${header}</header>
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
.xterm .xterm-viewport { background-color: transparent; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
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
