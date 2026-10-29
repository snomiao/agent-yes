// The owner ⇄ agent chat: the wire shared by the box (src/box.ts), its hub
// client (src/client.ts), the hub a site hosts (src/hub.ts) and the agent's
// CLI (src/cli.ts). Pure and import-free, so a Worker, a browser bundle
// and the CLI can all take it as is.
//
// Wire (JSON text frames). An agent knocks on <hub>/control?scope=chat|eval
// (&label=…, &for=<friend email>); a grant token resumes with x-liagent-token.
//   page → hub        {type:"chat", id, text}
//                     {type:"allow", pair, pages?: string[] | "all"} | {type:"deny"|"revoke", pair}
//                     {type:"page", label}            (client-side navigation)
//                     {type:"end-page", id}           (close one of the owner's pages)
//                     {type:"result", id, to, ok, value?, error?, stack?, ms?}
//   hub → page        {type:"state", pending, sessions, listeners, pages, self}
//                     {type:"history", messages} | {type:"chat", message}
//                     {type:"busy", label, at} | {type:"eval", id, code, to}
//   agent → hub       {type:"say", text, to?} | {type:"busy", to?} | {type:"eval", code, target?}
//   hub → agent       {type:"pending", code} | {type:"approved", until, scope, pages, token?}
//                     {type:"history"|"chat", …} | {type:"page-changed", label, thread, at}
//                     {type:"said", id} | {type:"sent", id, delivered} | {type:"result", …}
//                     {type:"error", error} | {type:"denied"|"revoked"|"expired"}

/** Largest `code` accepted, in characters. */
export const MAX_CODE = 16 * 1024;
/** Largest result summary a page sends back, in characters. */
export const MAX_RESULT = 4000;
/** Largest page or controller label, in characters. */
export const MAX_LABEL = 300;
/** How long the owner has to answer a pairing prompt. */
export const PENDING_MS = 2 * 60_000;
/** How long a friend's preview approval (eval on their pages, one socket) lasts. */
export const APPROVAL_MS = 60 * 60_000;
/**
 * How long the user's eval approval lasts — and its resumable grant token: the
 * agent reconnects with it (x-liagent-token) without a new prompt until then,
 * or until End revokes it.
 */
export const EVAL_GRANT_MS = 8 * 60 * 60_000;
/** How long "Allow chat" lasts — and its resumable grant token. */
export const CHAT_MS = 30 * 24 * 60 * 60_000;
/** Largest chat message (owner's or agent's), in characters. */
export const MAX_CHAT = 4000;
/** Chat messages the hub keeps (and sends a page on connect). */
export const CHAT_HISTORY = 200;
/** A page shows the spinner while the agent's last busy beat is younger than this. */
export const BUSY_MS = 12_000;
/** A beat this soon after a reply is the tail of the work just answered: ignored. */
export const BUSY_AFTER_REPLY_MS = 1_500;
/**
 * How long an eval grant outlives its pages: if every page it covers stays
 * closed this long, the agent is told to pair again (4409). Shorter gaps —
 * a phone app switch, a reload — keep the grant, since a tab keeps its page id.
 */
export const PAGES_GONE_MS = 5 * 60_000;
/** A page id: the tab's own, kept in sessionStorage and sent on reconnect (?page=). */
export const isPageId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v);
/** How long a page waits after client-side navigation before reporting it. */
export const PAGE_DEBOUNCE_MS = 300;

/**
 * What an approval lets an agent do: "eval" (8 hours, resumable) runs code on
 * the owner's pages and chats; "chat" (Allow chat for 30 days) only chats.
 */
export type Scope = "eval" | "chat";

/** One line of the chat, as the hub stores and sends it. */
export type ChatMessage = {
  id: string;
  from: "owner" | "agent" | "friend";
  label: string;
  text: string;
  at: number;
  thread?: string;
};

/**
 * A pairing: waiting for the owner's answer (no `until`), or approved.
 * `scope` is what the agent asked for (absent from an agent that did not
 * say: then the owner's answer decides). `pages`: the page ids it was
 * approved on, or "all" (every page of that audience, now and later).
 */
export type PairInfo = {
  pair: string;
  code: string;
  label: string;
  at: number;
  until?: number;
  scope?: Scope;
  pages?: string[] | "all";
};

/** One connected page of the viewer's own audience (the owner's pages, or a friend's own). */
export type PageInfo = { id: string; label: string; at: number };

export type HubState = {
  type: "state";
  pending: PairInfo | null;
  sessions: PairInfo[];
  /** Chat-capable agents connected now. */
  listeners: number;
  /** This audience's connected pages, and which of them the receiving page is. */
  pages: PageInfo[];
  self: string;
};

export type ControllerMessage =
  | { type: "eval"; code: string; target?: string }
  | { type: "say"; text: string; to?: string }
  | { type: "busy"; to?: string; on?: boolean };

export type PageMessage =
  | { type: "allow"; pair: string; pages?: string[] | "all"; scope?: "chat" }
  | { type: "deny" | "revoke"; pair: string }
  | { type: "page"; label: string }
  | { type: "end-page"; id: string }
  | { type: "chat"; id: string; text: string }
  | {
      type: "result";
      id: string;
      to: string;
      ok: boolean;
      value?: string;
      error?: string;
      stack?: string;
      ms?: number;
    };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > MAX_CODE + 2048) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A chat message's text: trimmed, non-empty, at most MAX_CHAT characters; else undefined. */
export function chatText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t && t.length <= MAX_CHAT ? t : undefined;
}

/** Validate an agent's message; anything else is an error sent back to it. */
export function parseControllerMessage(
  raw: unknown,
): { ok: true; value: ControllerMessage } | { ok: false; error: string } {
  const m = parse(raw);
  if (m?.type === "say") {
    const text = chatText(m.text);
    if (!text) return { ok: false, error: `say needs text of 1–${MAX_CHAT} chars` };
    const to = str(m.to, 320);
    return {
      ok: true,
      value: to ? { type: "say", text, to } : { type: "say", text },
    };
  }
  if (m?.type === "busy") {
    const to = str(m.to, 320);
    const value: ControllerMessage = { type: "busy" };
    if (to) value.to = to;
    if (m.on === false) value.on = false;
    return { ok: true, value };
  }
  if (!m || m.type !== "eval")
    return {
      ok: false,
      error: 'expected {"type":"say","text":"…"} or {"type":"eval","code":"…"}',
    };
  if (typeof m.code !== "string" || !m.code.trim()) return { ok: false, error: "empty code" };
  if (m.code.length > MAX_CODE) return { ok: false, error: `code over ${MAX_CODE} chars` };
  const target = str(m.target, MAX_LABEL);
  return {
    ok: true,
    value: target ? { type: "eval", code: m.code, target } : { type: "eval", code: m.code },
  };
}

/** Validate a page's message; anything else is dropped. */
export function parsePageMessage(raw: unknown): PageMessage | null {
  const m = parse(raw);
  if (!m) return null;
  if (m.type === "allow") {
    const pair = str(m.pair, 64);
    if (!pair) return null;
    const out: PageMessage = { type: "allow", pair };
    if (m.pages === "all") out.pages = "all";
    else if (Array.isArray(m.pages))
      out.pages = m.pages
        .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64)
        .slice(0, 64);
    if (m.scope === "chat") out.scope = "chat";
    return out;
  }
  if (m.type === "page") {
    const label = typeof m.label === "string" ? m.label.slice(0, MAX_LABEL) : undefined;
    return label ? { type: "page", label } : null;
  }
  if (m.type === "end-page") {
    const id = str(m.id, 64);
    return id ? { type: "end-page", id } : null;
  }
  if (m.type === "deny" || m.type === "revoke") {
    const pair = str(m.pair, 64);
    return pair ? { type: m.type, pair } : null;
  }
  if (m.type === "chat") {
    const id = str(m.id, 64);
    const text = chatText(m.text);
    return id && text ? { type: "chat", id, text } : null;
  }
  if (m.type === "result") {
    const id = str(m.id, 64);
    const to = str(m.to, 64);
    if (!id || !to) return null;
    return {
      type: "result",
      id,
      to,
      ok: m.ok === true,
      value: str(m.value, MAX_RESULT + 64),
      error: str(m.error, 1000),
      stack: str(m.stack, 2000),
      ms: typeof m.ms === "number" ? m.ms : undefined,
    };
  }
  return null;
}

/** The newest `max` messages, oldest first. */
export function trimHistory(list: ChatMessage[], max = CHAT_HISTORY): ChatMessage[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * The language to read a reply in, from its script alone: any kana is
 * Japanese, Hangul Korean, other Han Chinese (zh-CN), and everything else
 * English.
 */
export function pickLang(text: string): "ja-JP" | "ko-KR" | "zh-CN" | "en-US" {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  return "en-US";
}

/** An installed voice for `lang`: the exact locale first, then the same language. */
export function pickVoice<V extends { lang: string; default?: boolean }>(
  voices: readonly V[],
  lang: string,
): V | undefined {
  const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0];
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  const pool = exact.length ? exact : same;
  return pool.find((v) => v.default) ?? pool[0];
}

/** A label shown to the user: one line, printable, bounded. */
export function cleanLabel(raw: string | null | undefined, max = MAX_LABEL): string {
  return (
    (raw ?? "")
      // Control characters are exactly what this strips.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/** The short code the CLI prints and the prompt shows, so the owner can match them. */
export function shortCode(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A page's label matches when there is no target, or it contains the target (any case). */
export function matchesTarget(label: string, target: string | undefined): boolean {
  if (!target) return true;
  return label.toLowerCase().includes(target.toLowerCase());
}

/**
 * A JSON-serialisable summary of whatever the code returned, at most `max`
 * characters: cycles, functions, DOM nodes, errors, Maps, Sets and BigInts
 * become readable strings instead of throwing.
 */
export function summarize(value: unknown, max = MAX_RESULT): string {
  const seen = new WeakSet<object>();
  let out: string | undefined;
  try {
    out = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "symbol") return v.toString();
      if (v === undefined) return "[undefined]";
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "object" && v !== null) {
        const node = v as {
          nodeType?: unknown;
          outerHTML?: unknown;
          nodeName?: unknown;
        };
        if (typeof node.nodeType === "number")
          return typeof node.outerHTML === "string"
            ? node.outerHTML.slice(0, 500)
            : `[node ${String(node.nodeName)}]`;
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        if (v instanceof Map) return { "[Map]": [...v.entries()] };
        if (v instanceof Set) return { "[Set]": [...v.values()] };
      }
      return v;
    });
  } catch (e) {
    out = `[unserialisable: ${e instanceof Error ? e.message : String(e)}]`;
  }
  out ??= "[undefined]";
  return out.length > max ? `${out.slice(0, max)}…[${out.length - max} more]` : out;
}

/**
 * Compile `code` as an async function. An expression (`document.title`) is
 * returned as is; anything else is a function body, so `return x` works and
 * `await` is allowed in both.
 */
export function compile(code: string): () => Promise<unknown> {
  try {
    return new Function(`return (async () => (\n${code}\n))();`) as () => Promise<unknown>;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return new Function(`return (async () => {\n${code}\n})();`) as () => Promise<unknown>;
  }
}
