// <liagent-chat>: the owner ⇄ agent chat box, a framework-free custom element.
//
//   import { defineChatBox } from "agent-yes/liagent/box";
//   defineChatBox();                          // registers <liagent-chat>
//   const box = document.createElement("liagent-chat");
//   box.onSend = (text) => socketSend(text);  // true if it went out
//   document.body.append(box);
//   box.messages = history;                   // history: shown, never read aloud
//   box.push(message);                        // a live one: an agent's is read aloud
//
// Or let src/client.ts drive it from a hub: connectHub(box, url).
//
// What it does:
//   - No title bar. A grip (⠿) on the one-line input drags the box anywhere,
//     kept on screen and remembered; a double tap on it opens a menu with the
//     status, read-aloud, minimize, and each session with an End button.
//   - The log is game-style text over the page, one "name: text" line per
//     message, the time on hover; it is click-through, so the page under it
//     still takes taps. A vertical swipe on the input scrolls it.
//   - The input and grip are translucent (about 55% of the page colour); the
//     whole box is faint until touched or focused.
//   - A row of icons at the top: a spinner while the agent is working, one
//     icon per eval session, and a pairing request as one compact line
//     (code · 1h · chat · ✕).
//   - Sending: see src/input.ts (debounce, Enter, IME, Android, dictation).
//   - Agent replies that arrive live are read aloud with speechSynthesis, in
//     a language picked from their script; typing cancels it, the menu turns
//     it off for the device, and iOS is unlocked on the first gesture.
//   - Text only: nothing a message holds is ever parsed as HTML.
//
// Theming: set CSS custom properties on the element — --liagent-bg (the page
// colour, for the halo and the translucent input; default Canvas),
// --liagent-fg, --liagent-you, --liagent-agent, --liagent-z (z-index, 40),
// --liagent-width (min(20rem, 100vw - 1rem)).

import {
  BUSY_AFTER_REPLY_MS,
  BUSY_MS,
  type ChatMessage,
  MAX_CHAT,
  type PageInfo,
  type PairInfo,
  pickLang,
  pickVoice,
  trimHistory,
} from "./protocol.ts";
import { DEBOUNCE_MS, afterChange, enterSends, lineBreakSends } from "./input.ts";

export type AnswerType = "allow" | "deny";
/**
 * What the user chose in a pairing request: the pages to allow (their ids,
 * or "all", including pages that open later), and — for an older agent that
 * did not say which scope it wants — "chat" when they tapped the 30-day chat
 * button rather than the hour.
 */
export type Answer = { pages?: string[] | "all"; scope?: "chat" };

/** A page's label is "<path> <user agent>": the path and a short device hint. */
export function pageHint(label: string): string {
  const [path = "", ...rest] = label.split(" ");
  const ua = rest.join(" ");
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|X11/.test(ua)
              ? "Linux"
              : (ua.split(" ").find((w) => w !== "pwa") ?? "");
  const pwa = /(^| )pwa( |$)/.test(ua) ? " app" : "";
  return device ? `${path} · ${device}${pwa}` : path;
}

const Base: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

const synth = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);
let unlocked = false;
/** iOS speaks only after a user gesture: an empty utterance on the first one unlocks it. */
function unlockSpeech() {
  const s = synth();
  if (unlocked || !s) return;
  unlocked = true;
  s.speak(new SpeechSynthesisUtterance(""));
}
/** Drop whatever is being read and queued — the owner has started typing. */
function cancelSpeech() {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
export function when(at: number, now = new Date()) {
  const d = new Date(at);
  const day = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day(d) === day(now) ? `${hm}:${pad(d.getSeconds())}` : `${day(d)} ${hm}`;
}

const ICONS = {
  play: `<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>`,
  lock: `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h1v7H4V7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z"/></svg>`,
  speaker: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" stroke="currentColor" fill="none" stroke-width="1.3"/></svg>`,
};

const CSS = `
:host {
  all: initial;
  position: fixed;
  right: 0.5rem;
  bottom: calc(0.5rem + env(safe-area-inset-bottom));
  z-index: var(--liagent-z, 40);
  /* Click-through: only the pill, grip, input, menu and pairing line take pointer events. */
  pointer-events: none;
  font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--liagent-fg, CanvasText);
  --bg: var(--liagent-bg, Canvas);
  --input-bg: color-mix(in oklch, var(--bg) 55%, transparent);
  --line: color-mix(in oklch, currentColor 25%, transparent);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.halo { text-shadow: 0 0 3px var(--bg), 0 0 6px var(--bg); }
.pill {
  pointer-events: auto;
  display: flex; align-items: center; gap: 6px; padding: 4px 12px;
  opacity: .6; transition: opacity .15s; touch-action: none; cursor: grab;
}
.pill:active { opacity: 1; }
.badge { border-radius: 999px; background: #2563eb; color: #fff; padding: 0 6px; font-size: 10px; text-shadow: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.box {
  width: var(--liagent-width, min(20rem, calc(100vw - 1rem)));
  display: flex; flex-direction: column; pointer-events: none;
  opacity: .6; transition: opacity .15s;
}
.box:focus-within, .box:active { opacity: 1; }
.icons { display: flex; align-items: center; gap: 4px; padding: 4px 8px 0; }
.icons:empty { display: none; }
.ico {
  display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center;
  border-radius: 50%; color: #fff; background: oklch(0.55 0.15 30); opacity: .7; pointer-events: auto;
}
.ico.ran { animation: pulse 1s ease-in-out infinite; opacity: 1; }
@keyframes pulse { 50% { opacity: .4; } }
.spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--liagent-agent, oklch(0.55 0.14 150));
  animation: rot .8s linear infinite;
}
@keyframes rot { to { transform: rotate(360deg); } }
.ask {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 4px;
  border-radius: 999px; padding: 2px 2px 2px 6px; font-size: 10px; color: #fff;
  background: oklch(0.45 0.12 30); text-shadow: none;
}
.ask b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
.ask button { border-radius: 999px; padding: 0 6px; }
.ask .y { background: oklch(0.55 0.15 145); }
.ask .c { background: oklch(0.5 0.1 230); }
.ask .n { background: oklch(0.4 0.02 260); }
.ask .tag { opacity: .85; }
.askwrap { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; pointer-events: auto; }
.pagelist {
  display: flex; flex-direction: column; gap: 1px; padding: 3px 8px; border-radius: 8px; font-size: 11px;
  border: 1px solid var(--line); background: var(--input-bg); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.pagelist label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.pagelist input { margin: 0; }
.menu .pg { opacity: .75; }
.menu .pg span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu .pg button { text-decoration: underline; padding: 0; }
.menu .head { opacity: .5; font-size: 10px; padding-bottom: 0; }
.log {
  list-style: none; margin: 0; padding: 6px 8px; max-height: 30vh; min-height: 3rem;
  overflow-y: auto; display: flex; flex-direction: column; gap: 2px; scrollbar-width: none;
}
.log::-webkit-scrollbar { display: none; }
.log li { white-space: pre-wrap; overflow-wrap: anywhere; }
.log .who { font-weight: 500; margin-inline-end: 4px; }
.log .you { color: var(--liagent-you, oklch(0.55 0.13 250)); }
.log .agent { color: var(--liagent-agent, oklch(0.55 0.14 150)); }
.log .hint { opacity: .6; }
.warn { padding: 4px 8px 0; font-size: 10px; color: oklch(0.6 0.17 45); }
.notice { pointer-events: auto; margin: 0; padding: 8px; opacity: .8; }
.row { position: relative; display: flex; align-items: stretch; gap: 4px; }
.grip {
  pointer-events: auto; position: relative; flex: none; padding: 0 6px; font-size: 16px; line-height: 1;
  border-radius: 8px; border: 1px solid var(--line); background: var(--input-bg);
  opacity: .8; touch-action: none; cursor: grab;
}
.grip .dot { position: absolute; top: 2px; right: 2px; width: 6px; height: 6px; }
textarea {
  pointer-events: auto; display: block; flex: 1; min-width: 0; resize: none; margin: 0;
  font: 14px/1.35 inherit; font-family: inherit; color: inherit;
  padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--input-bg); outline: none;
}
textarea::placeholder { color: color-mix(in oklch, currentColor 45%, transparent); }
.drain {
  position: absolute; inset: 0 0 auto 0; height: 2px; background: rgb(37 99 235 / .6);
  transform-origin: left; animation: drain var(--drain-ms) linear both; pointer-events: none;
}
@keyframes drain { to { transform: scaleX(0); } }
.menu {
  pointer-events: auto; position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; min-width: 12rem;
  display: flex; flex-direction: column; padding: 4px 0; border-radius: 8px;
  border: 1px solid var(--line); background: var(--input-bg); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.menu > * { padding: 5px 12px; text-align: start; display: flex; align-items: center; gap: 8px; }
.menu .status { opacity: .65; }
.menu .sess { opacity: .75; }
.menu .sess span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu .sess button { text-decoration: underline; padding: 0; }
.menu [aria-checked="false"] svg { opacity: .45; }
[hidden] { display: none !important; }
`;

/** The chat box element. Plain properties in, callbacks out; see the file header. */
export class ChatBox extends Base {
  /** Called with each draft that goes out; return false if it could not be sent (the draft is kept). */
  onSend?: (text: string) => boolean;
  /** The user answered a pairing request in the icon row. */
  onAnswer?: (type: AnswerType, p: PairInfo, answer: Answer) => void;
  /** End was pressed on a session in the menu. */
  onEnd?: (s: PairInfo) => void;
  /** End was pressed (and, for this page, confirmed) on one of the user's pages in the menu. */
  onEndPage?: (id: string) => void;

  private _messages: ChatMessage[] = [];
  private _live = false;
  private _listeners = 0;
  private _sessions: PairInfo[] = [];
  private _pending: PairInfo | null = null;
  private _evalRan = false;
  private _busy = false;
  private busyTimer?: ReturnType<typeof setTimeout>;
  private lastReplyAt = 0;
  private _pages: PageInfo[] = [];
  private _self = "";
  /** The pages ticked in the pairing request, per pair id. */
  private picked = new Map<string, Set<string> | "all">();
  /** The page whose End was tapped once (this page needs a second tap). */
  private confirmEnd = "";
  private _friend = false;
  private _notice = "";
  private _warning = "";
  private _defaultOpen = true;
  private _placeholder = "Message the agent…";

  private root?: ShadowRoot;
  private open = true;
  private menuOpen = false;
  private offline = false;
  private seen = 0;
  private pos = { x: 0, y: 0 };
  private draft = "";
  private settledLen = 0;
  private composing = false;
  private shiftEnter = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastGripTap = 0;
  private dragged = false;
  private els: Record<string, HTMLElement> = {};

  // ---- inputs ---------------------------------------------------------------

  get messages() {
    return this._messages;
  }
  /** Replace the log (history on connect): never read aloud. */
  set messages(v: ChatMessage[]) {
    this._messages = trimHistory(Array.isArray(v) ? v : []);
    this.renderLog();
  }
  /** One message that arrived live: kept once per id; an agent's is read aloud. */
  push(m: ChatMessage) {
    if (!m || typeof m.text !== "string" || typeof m.id !== "string") return;
    if (this._messages.some((x) => x.id === m.id)) return;
    this._messages = trimHistory([...this._messages, m]);
    this.renderLog();
    if (m.from !== "agent") return;
    // A reply ends the spinner for the work it answers.
    this.lastReplyAt = Date.now();
    this.busy = false;
    this.speak(m.text);
  }
  /**
   * One busy beat from the agent: the spinner shows for BUSY_MS unless the
   * next beat renews it or a reply ends it. A beat right after a reply
   * (BUSY_AFTER_REPLY_MS) is that work's tail, and ignored.
   */
  beat(at = Date.now()) {
    if (at - this.lastReplyAt < BUSY_AFTER_REPLY_MS) return;
    this.busy = true;
    this.busyTimer = setTimeout(() => (this.busy = false), BUSY_MS);
  }
  set live(v: boolean) {
    this._live = !!v;
    this.renderStatus();
  }
  get live() {
    return this._live;
  }
  /** Agents listening now (shown in the status). */
  set listeners(v: number) {
    this._listeners = Number(v) || 0;
    this.renderStatus();
  }
  /** Approved sessions: an icon each for eval, and a line with End in the menu. */
  set sessions(v: PairInfo[]) {
    this._sessions = Array.isArray(v) ? v : [];
    this.renderIcons();
    this.renderMenu();
  }
  /** A pairing waiting for the owner's answer. */
  set pending(v: PairInfo | null) {
    this._pending = v ?? null;
    this.renderIcons();
  }
  /** Code just ran on this page: the eval icons pulse. */
  set evalRan(v: boolean) {
    this._evalRan = !!v;
    this.renderIcons();
  }
  /** The agent is working: a spinner in the icon row. */
  set busy(v: boolean) {
    clearTimeout(this.busyTimer);
    this._busy = !!v;
    this.renderIcons();
  }
  get busy() {
    return this._busy;
  }
  /** The user's connected pages (the hub's state.pages): offered when allowing, ended from the menu. */
  set pages(v: PageInfo[]) {
    this._pages = Array.isArray(v) ? v : [];
    this.renderIcons();
    this.renderMenu();
  }
  /** Which of `pages` this page is (the hub's state.self). */
  set self(v: string) {
    this._self = v ?? "";
    this.renderIcons();
    this.renderMenu();
  }
  /** A friend's page (not the user's): pairings are previews, with no chat scope to grant. */
  set friend(v: boolean) {
    this._friend = !!v;
    this.renderIcons();
  }
  /** Shown instead of the input when this viewer cannot chat. */
  set notice(v: string | undefined) {
    this._notice = v ?? "";
    this.renderInput();
  }
  /** A one-line note above the input (say, a message dropped by a rate limit). */
  set warning(v: string | undefined) {
    this._warning = v ?? "";
    this.renderInput();
  }
  /** Open or collapsed on first visit (later visits remember). Attribute: collapsed. */
  set defaultOpen(v: boolean) {
    this._defaultOpen = !!v;
  }
  set placeholder(v: string) {
    this._placeholder = v;
    const ta = this.els.input as HTMLTextAreaElement | undefined;
    if (ta) ta.placeholder = v;
  }

  // ---- storage --------------------------------------------------------------

  /** Per-device settings live under this prefix (attribute storage-key; default "liagent"). */
  private key(name: string) {
    return `${this.getAttribute("storage-key") || "liagent"}:${name}`;
  }
  private read(name: string) {
    try {
      return localStorage.getItem(this.key(name));
    } catch {
      return null;
    }
  }
  private write(name: string, v: string) {
    try {
      localStorage.setItem(this.key(name), v);
    } catch {}
  }
  /** Whether agent replies are read aloud on this device (on unless turned off). */
  get speaking() {
    return this.read("speak") !== "0";
  }

  /**
   * Read a reply aloud, after any still being read: the language comes from
   * its script, with a matching installed voice if there is one.
   */
  speak(text: string) {
    const s = synth();
    if (!s || !this.speaking) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = pickLang(text);
    const voice = pickVoice(s.getVoices(), u.lang);
    if (voice) u.voice = voice;
    s.speak(u);
  }

  // ---- lifecycle ------------------------------------------------------------

  connectedCallback() {
    // Added again on every attach (the same function, so never twice).
    document.addEventListener("pointerdown", this.outside, true);
    if (this.root) return;
    if (this.hasAttribute("collapsed")) this._defaultOpen = false;
    const ph = this.getAttribute("placeholder");
    if (ph) this._placeholder = ph;
    const o = this.read("open");
    this.open = o === null ? this._defaultOpen : o === "1";
    try {
      const v = JSON.parse(this.read("pos") ?? "null") as {
        x: number;
        y: number;
      } | null;
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) this.pos = v;
    } catch {}
    synth()?.getVoices(); // starts loading them, so the first reply finds one
    this.root = this.attachShadow({ mode: "open" });
    this.build();
    this.renderAll();
  }

  disconnectedCallback() {
    clearTimeout(this.timer);
    document.removeEventListener("pointerdown", this.outside, true);
  }

  /** A tap anywhere outside the menu and its grip closes the menu. */
  private outside = (e: Event) => {
    if (!this.menuOpen) return;
    const path = e.composedPath();
    if (path.includes(this.els.menu!) || path.includes(this.els.grip!)) return;
    this.setMenu(false);
  };

  // ---- DOM ------------------------------------------------------------------

  private build() {
    const r = this.root!;
    // A constructed sheet is not subject to the page's CSP style-src; a
    // <style> is the fallback where adoptedStyleSheets is missing.
    let style = "";
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      r.adoptedStyleSheets = [sheet];
    } catch {
      style = `<style>${CSS}</style>`;
    }
    r.innerHTML = `${style}
<button type="button" class="pill halo" id="pill"><span class="dot" id="pilldot"></span>chat<span class="badge" id="unread" hidden></span></button>
<section class="box halo" id="box" aria-label="Chat with the agent">
  <div class="icons" id="icons" aria-label="Agent connections"></div>
  <ol class="log" id="log"></ol>
  <div class="warn" id="warn" role="alert" hidden></div>
  <p class="notice" id="notice" role="status" hidden></p>
  <div class="row" id="row">
    <button type="button" class="grip" id="grip" aria-label="Drag the chat box; double tap for its menu" aria-expanded="false">⠿<span class="dot" id="dot"></span></button>
    <div class="menu" id="menu" role="menu" hidden></div>
    <textarea id="input" rows="1" maxlength="${MAX_CHAT}" aria-label="Message the agent"></textarea>
  </div>
</section>`;
    for (const id of [
      "pill",
      "pilldot",
      "unread",
      "box",
      "icons",
      "log",
      "warn",
      "notice",
      "row",
      "grip",
      "dot",
      "menu",
      "input",
    ])
      this.els[id] = r.getElementById(id) as HTMLElement;
    const { pill, box, grip } = this.els as Record<"pill" | "box" | "grip", HTMLElement>;
    const ta = this.els.input as HTMLTextAreaElement;
    ta.placeholder = this._placeholder;

    this.dragHandle(pill);
    this.dragHandle(grip);
    pill.addEventListener("pointerdown", unlockSpeech);
    pill.addEventListener("click", () => !this.wasDrag() && this.setOpen(true));
    box.addEventListener("pointerdown", unlockSpeech);
    box.addEventListener("keydown", (e) => {
      unlockSpeech();
      if (e.key === "Escape" && this.menuOpen) this.setMenu(false);
    });
    grip.addEventListener("click", (e) => {
      if (this.wasDrag()) return;
      const second = e.timeStamp - this.lastGripTap < 350;
      this.lastGripTap = second ? 0 : e.timeStamp;
      if (second) this.setMenu(!this.menuOpen);
    });

    ta.addEventListener("input", () => {
      this.draft = ta.value;
      this.offline = false;
      cancelSpeech();
      this.arm();
      this.renderStatus();
    });
    ta.addEventListener("compositionstart", () => {
      this.composing = true;
      this.disarm();
    });
    ta.addEventListener("compositionend", () => {
      this.composing = false;
      this.arm();
    });
    ta.addEventListener("beforeinput", (e) => {
      const ie = e as InputEvent;
      if (
        lineBreakSends(ie.inputType, {
          composing: this.composing,
          isComposing: ie.isComposing,
          shiftEnter: this.shiftEnter,
        })
      ) {
        e.preventDefault();
        this.submit();
      }
    });
    ta.addEventListener("keydown", (e) => {
      this.shiftEnter = e.key === "Enter" && e.shiftKey;
      if (!enterSends(e, this.composing)) return;
      e.preventDefault();
      this.submit();
    });
    this.swipeScrollsLog(ta);
  }

  /** The log is click-through, so it can't be swiped: a vertical swipe on the input scrolls it. */
  private swipeScrollsLog(el: HTMLTextAreaElement) {
    let y = 0;
    let swiping = false;
    el.addEventListener(
      "touchstart",
      (e) => {
        y = e.touches[0]!.clientY;
        swiping = false;
      },
      { passive: true },
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        const list = this.els.log!;
        // A draft long enough to scroll keeps the swipe for itself.
        if (el.scrollHeight > el.clientHeight + 1) return;
        const ny = e.touches[0]!.clientY;
        if (!swiping && Math.abs(ny - y) < 6) return;
        swiping = true;
        list.scrollTop -= ny - y;
        y = ny;
        if (e.cancelable) e.preventDefault();
      },
      { passive: false },
    );
  }

  /**
   * Drag the box by `el` anywhere on screen: an offset from its bottom-right
   * home, kept on screen and remembered. A press that moves under 5 px is
   * still a click.
   */
  private dragHandle(el: HTMLElement) {
    let d: {
      px: number;
      py: number;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;
    el.addEventListener("pointerdown", (e) => {
      d = {
        px: e.clientX,
        py: e.clientY,
        x: this.pos.x,
        y: this.pos.y,
        moved: false,
      };
      this.dragged = false;
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      // Keep the whole box on screen: its rect now, minus the drag so far.
      const box = this.getBoundingClientRect();
      const left = box.left - (this.pos.x - d.x);
      const top = box.top - (this.pos.y - d.y);
      this.pos = {
        x: d.x + Math.max(-left, Math.min(innerWidth - box.width - left, dx)),
        y: d.y + Math.max(-top, Math.min(innerHeight - box.height - top, dy)),
      };
      this.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
    });
    const end = () => {
      const moved = d?.moved;
      d = null;
      if (!moved) return;
      this.dragged = true;
      this.write("pos", JSON.stringify(this.pos));
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", () => (d = null));
  }
  /** The click that ends a drag is not a click. */
  private wasDrag() {
    const d = this.dragged;
    this.dragged = false;
    return d;
  }

  // ---- sending --------------------------------------------------------------

  private disarm() {
    clearTimeout(this.timer);
    this.els.row?.querySelector(".drain")?.remove();
  }
  private arm() {
    this.disarm();
    const next = afterChange(this.draft, this.settledLen, this.composing);
    if (!this.composing) this.settledLen = this.draft.length;
    if (next === "send") return this.submit();
    if (next === "idle") return;
    // A fresh bar on each keystroke drains for the debounce.
    const bar = document.createElement("div");
    bar.className = "drain";
    bar.style.setProperty("--drain-ms", `${DEBOUNCE_MS}ms`);
    this.els.row!.prepend(bar);
    this.timer = setTimeout(() => this.submit(), DEBOUNCE_MS);
  }
  /** Send the draft now. Kept (and the status says so) if it could not go out. */
  submit() {
    this.disarm();
    const text = this.draft.trim();
    if (!text) return;
    if (!this.onSend?.(text)) {
      this.offline = true;
      return this.renderStatus();
    }
    this.offline = false;
    this.draft = "";
    this.settledLen = 0;
    (this.els.input as HTMLTextAreaElement).value = "";
    this.renderStatus();
  }

  // ---- render ---------------------------------------------------------------

  private setOpen(v: boolean) {
    this.open = v;
    this.write("open", v ? "1" : "0");
    if (!v) this.setMenu(false);
    this.renderAll();
  }
  private setMenu(v: boolean) {
    this.menuOpen = v;
    this.els.grip?.setAttribute("aria-expanded", String(v));
    this.renderMenu();
  }

  private status() {
    if (this._notice) return "chat unavailable";
    if (this.offline) return "not connected — your draft is kept";
    if (!this._live) return "reconnecting…";
    return this._listeners
      ? `agent listening (${this._listeners})`
      : "connected · no agent listening";
  }

  private renderAll() {
    if (!this.root) return;
    this.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
    this.els.pill!.hidden = this.open;
    this.els.box!.hidden = !this.open;
    this.renderIcons();
    this.renderLog();
    this.renderInput();
    this.renderStatus();
    this.renderMenu();
  }

  private renderStatus() {
    if (!this.root) return;
    const dot = this._live ? "oklch(0.68 0.16 150)" : "oklch(0.62 0.02 70)";
    this.els.dot!.style.background = dot;
    this.els.pilldot!.style.background = dot;
    this.els.grip!.title = this.status();
    const unread = this.unread();
    const badge = this.els.unread!;
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
    this.els.pill!.setAttribute(
      "aria-label",
      `Open chat with the agent${unread ? `, ${unread} new` : ""}`,
    );
    if (this.menuOpen) this.renderMenu();
  }

  private unread() {
    if (this.open) this.seen = this._messages.length;
    return this._messages.slice(this.seen).filter((m) => m.from === "agent").length;
  }

  private renderIcons() {
    if (!this.root) return;
    const row = this.els.icons!;
    row.replaceChildren();
    if (this._busy) {
      const s = document.createElement("span");
      s.className = "spin";
      s.title = "the agent is working";
      s.setAttribute("role", "status");
      s.setAttribute("aria-label", "the agent is working");
      row.append(s);
    }
    for (const x of this._sessions.filter((x) => x.scope !== "chat")) {
      const s = document.createElement("span");
      s.className = `ico${this._evalRan ? " ran" : ""}`;
      s.title = `${this._friend ? "preview" : "eval"}: ${x.label} · ${x.code}`;
      s.innerHTML = ICONS.play;
      row.append(s);
    }
    const p = this._pending;
    if (p) row.append(this.renderAsk(p));
  }

  /**
   * A pairing request, compact: its code, what it asks for, Allow and ✕ —
   * and, for code on a user with more than one page open, a checkbox per
   * page (this one ticked) plus "all pages". Chat is always every page. An agent that did not say what
   * it wants (an older client) gets the two old answers, 1h and chat.
   */
  private renderAsk(p: PairInfo) {
    const ask = document.createElement("span");
    ask.className = "ask";
    ask.setAttribute("role", "alertdialog");
    const what =
      this._friend || p.scope === "eval"
        ? "to run code on the chosen pages and chat, for 1 hour"
        : p.scope === "chat"
          ? "to chat with you, for 30 days"
          : "to run code on your pages, or to chat";
    const sentence = `${p.label} asks ${what}. Allow only if the agent shows the same code: ${p.code}.`;
    ask.setAttribute("aria-label", sentence);
    ask.title = sentence;
    ask.innerHTML = ICONS.lock;
    const code = document.createElement("b");
    code.textContent = p.code;
    ask.append(code);
    if (p.scope) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = this._friend || p.scope === "eval" ? "code · 1h" : "chat · 30d";
      ask.append(tag);
    }
    if (!this.picked.has(p.pair)) this.picked.set(p.pair, new Set(this._self ? [this._self] : []));
    const picked = this.picked.get(p.pair)!;
    const pages = (): Answer["pages"] => {
      const cur = this.picked.get(p.pair);
      if (cur === "all") return "all";
      return cur && cur.size ? [...cur] : undefined;
    };
    const btn = (cls: string, text: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = text;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", fn);
      ask.append(b);
    };
    if (p.scope || this._friend)
      btn("y", "Allow", "Allow on the ticked pages", () =>
        this.onAnswer?.("allow", p, { pages: pages() }),
      );
    else {
      btn("y", "1h", "Allow code and chat for 1 hour", () =>
        this.onAnswer?.("allow", p, { pages: pages() }),
      );
      btn("c", "chat", "Chat only, for 30 days", () =>
        this.onAnswer?.("allow", p, { pages: pages(), scope: "chat" }),
      );
    }
    btn("n", "✕", "Deny", () => this.onAnswer?.("deny", p, {}));
    // Chat always covers every page: only code (eval, or an older agent's
    // hour) asks which pages.
    if (this._pages.length < 2 || (p.scope === "chat" && !this._friend)) return ask;
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    const list = document.createElement("div");
    list.className = "pagelist";
    const box = (label: string, checked: boolean, on: (v: boolean) => void) => {
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = checked;
      c.addEventListener("change", () => on(c.checked));
      l.append(c, document.createTextNode(label));
      list.append(l);
    };
    const all = picked === "all";
    for (const pg of this._pages)
      box(
        `${pageHint(pg.label)}${pg.id === this._self ? " (this page)" : ""}`,
        all || (picked as Set<string>).has(pg.id),
        (v) => {
          const cur = this.picked.get(p.pair);
          const set = cur === "all" ? new Set(this._pages.map((x) => x.id)) : new Set(cur);
          if (v) set.add(pg.id);
          else set.delete(pg.id);
          this.picked.set(p.pair, set);
          this.renderIcons();
        },
      );
    box("all pages, and pages opened later", all, (v) => {
      this.picked.set(p.pair, v ? "all" : new Set(this._self ? [this._self] : []));
      this.renderIcons();
    });
    wrap.append(ask, list);
    return wrap;
  }

  private renderLog() {
    if (!this.root) return;
    const log = this.els.log!;
    log.replaceChildren();
    if (this._messages.length === 0) {
      const li = document.createElement("li");
      li.className = "hint";
      li.textContent = `Type here; it is sent ${DEBOUNCE_MS / 1000} s after you stop.`;
      log.append(li);
    }
    // A game-style log: one line per message, "name: text", no bubbles; the
    // time only on hover (long press on a phone).
    for (const m of this._messages) {
      const li = document.createElement("li");
      li.title = when(m.at);
      const who = document.createElement("span");
      const agent = m.from === "agent";
      who.className = `who ${agent ? "agent" : "you"}`;
      who.textContent = `${agent ? m.label || "agent" : "you"}:`;
      li.append(who, document.createTextNode(m.text));
      log.append(li);
    }
    if (this.open) log.scrollTop = log.scrollHeight;
    this.renderStatus();
  }

  private renderInput() {
    if (!this.root) return;
    const warn = this.els.warn!;
    warn.hidden = !this._warning;
    warn.textContent = this._warning;
    const notice = this.els.notice!;
    notice.hidden = !this._notice;
    notice.textContent = this._notice;
    this.els.row!.hidden = !!this._notice;
    this.renderStatus();
  }

  private renderMenu() {
    if (!this.root) return;
    const menu = this.els.menu!;
    menu.hidden = !this.menuOpen;
    if (!this.menuOpen) return;
    menu.replaceChildren();
    const status = document.createElement("span");
    status.className = "status";
    status.setAttribute("aria-live", "polite");
    status.textContent = this.status();
    const speak = document.createElement("button");
    speak.type = "button";
    speak.setAttribute("role", "menuitemcheckbox");
    speak.setAttribute("aria-checked", String(this.speaking));
    speak.innerHTML = ICONS.speaker;
    speak.append(this.speaking ? "Replies read aloud" : "Replies silent");
    speak.addEventListener("click", () => {
      const v = !this.speaking;
      this.write("speak", v ? "1" : "0");
      if (!v) synth()?.cancel();
      this.renderMenu();
    });
    const min = document.createElement("button");
    min.type = "button";
    min.setAttribute("role", "menuitem");
    min.textContent = "–  Minimize";
    min.addEventListener("click", () => this.setOpen(false));
    menu.append(status, speak, min);
    for (const x of this._sessions) {
      const row = document.createElement("div");
      row.className = "sess";
      const label = document.createElement("span");
      const where =
        x.pages === undefined || x.pages === "all"
          ? "all pages"
          : `${x.pages.length} page${x.pages.length === 1 ? "" : "s"}`;
      label.textContent = `${x.scope === "chat" ? "chat" : this._friend ? "preview" : "eval"}: ${x.label} · ${x.code} · ${where}`;
      const end = document.createElement("button");
      end.type = "button";
      end.textContent = "End";
      end.addEventListener("click", () => {
        this.setMenu(false);
        this.onEnd?.(x);
      });
      row.append(label, end);
      menu.append(row);
    }
    if (this._pages.length < 2) return;
    const head = document.createElement("span");
    head.className = "head";
    head.textContent = "Your open pages";
    menu.append(head);
    for (const pg of this._pages) {
      const row = document.createElement("div");
      row.className = "pg";
      const label = document.createElement("span");
      const mine = pg.id === this._self;
      label.textContent = `${pageHint(pg.label)}${mine ? " (this page)" : ""}`;
      label.title = pg.label;
      const end = document.createElement("button");
      end.type = "button";
      // Ending this very page takes a second tap.
      end.textContent = mine && this.confirmEnd === pg.id ? "End this page?" : "End";
      end.addEventListener("click", () => {
        if (mine && this.confirmEnd !== pg.id) {
          this.confirmEnd = pg.id;
          return this.renderMenu();
        }
        this.confirmEnd = "";
        this.onEndPage?.(pg.id);
      });
      row.append(label, end);
      menu.append(row);
    }
  }
}

/** Register the element (once) under `tag`. Returns the class. */
export function defineChatBox(tag = "liagent-chat"): typeof ChatBox {
  if (typeof customElements !== "undefined" && !customElements.get(tag))
    customElements.define(tag, ChatBox);
  return ChatBox;
}
