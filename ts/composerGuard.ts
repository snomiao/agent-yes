/**
 * Composer guard for `ay send`: never type into, append to, or submit a draft
 * someone else left in the target's input box.
 *
 * Why: a terminal shared by a human and by other agents' `ay send` has ONE
 * composer. Observed 2026-10-08: a human had typed "btw how" and paused; a lane's
 * report was pasted after it and Enter submitted both as one turn, so the human's
 * half-written message went out early, fused with the report, and the rest of it
 * was lost. The stdin-activity backoff (isUserTyping) cannot see this: it only
 * knows when the last key was pressed, not whether text is still sitting there.
 *
 * So the send path reads the composer off the rendered screen first. When it
 * holds real input, the message is parked in a per-target file queue and a
 * single detached drainer delivers it once the composer is empty again.
 *
 * Telling a draft from ghost text: Claude Code renders its prompt suggestion
 * (and the "Press up to edit queued messages" hint) with SGR 2 (dim/faint) in the
 * default colour; typed or pasted input is drawn without SGR 2. Measured on the
 * raw PTY log of a live lane: the suggestion frame is `ESC[2mcollect my pills
 * ESC[22m` on the prompt row, while typed text on the same row is plain. Colour
 * is not used: typed input is drawn in the default colour, exactly like the
 * ghost, and the user's theme changes the palette but not the SGR 2 attribute.
 * Inverse cells are ignored too: a TUI that paints its own cursor as an inverse
 * block over the first ghost character must not turn a suggestion into a draft.
 */
import { createHash, randomBytes } from "crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/** One rendered terminal cell, reduced to what the guard needs. */
export interface ComposerCell {
  ch: string;
  dim: boolean;
  inverse: boolean;
}

/** A rendered row: its plain text plus per-cell attributes. */
export interface ComposerRow {
  text: string;
  cells: ComposerCell[];
}

export type ComposerState =
  /** Nothing typed: an empty prompt, possibly showing dim ghost text. */
  | { kind: "empty"; ghost: boolean }
  /** Real input is sitting in the composer. `chars` counts the real cells. */
  | { kind: "draft"; chars: number }
  /** No composer is visible (menu, trust dialog, unknown CLI screen). */
  | { kind: "unknown"; reason: string };

const PROMPT_RE = /^\s*[❯›]($|\s)/u;
// Same chrome inspectSubmission stops at: the separator rule under the box and
// the Claude/Codex footer rows.
const SEPARATOR_RE = /^\s*[─━]{3,}/u;
const FOOTER_RE =
  /^\s*(?:·\s*)?(?:[←→] .*agents|\? for shortcuts|esc to interrupt|ctrl\+t to|GPT-[^·]*·|gpt-[^·]*·|⏵⏵|⏸|⏎ send|\d+% context left)/iu;
// Claude Code's status footer often LEADS with other `·`-separated segments
// ("1 shell · esc to interrupt · ← 2 agents · ↓ to manage", "PR #12 · 2 shells ·
// ← for agents · …", "shell, 1 monitor · …"), and ink's partial redraws can leave
// it garbled ("1       · esc to …", "↓ t…"). Unmatched, the whole row was
// counted as a 20-40 char draft and every send to an idle lane was parked. So a
// row is also the footer when any later segment is one of its fixed hints.
const FOOTER_SEGMENT_RE = /·\s*(?:[←→] .*agents?|↓ |esc to interrupt)/u;

/**
 * The composer's prompt row among plain-text rows (oldest first), or -1.
 * Claude Code boxes its composer, so the prompt is the row directly under the
 * LAST rule that has a prompt row under it — a `›`/`❯` that merely starts a
 * line of a multi-line draft is inside the box, not a second prompt. Without
 * any box (Codex) it is the last prompt-looking row. Shared by the draft check
 * and by submission confirmation, so both agree on where history ends.
 */
export function composerPromptRow(texts: string[]): number {
  for (let i = texts.length - 2; i >= 0; i--) {
    if (SEPARATOR_RE.test(texts[i]!) && PROMPT_RE.test(texts[i + 1]!)) return i + 1;
  }
  return texts.findLastIndex((t) => PROMPT_RE.test(t));
}

/** Is this row composer chrome (a rule or a Claude/Codex footer) — the end of the input? */
export function isComposerChrome(text: string): boolean {
  return SEPARATOR_RE.test(text) || FOOTER_RE.test(text) || FOOTER_SEGMENT_RE.test(text);
}

/**
 * Classify the composer from rendered rows (oldest first, screen bottom last).
 *
 * Claude Code draws the composer as a box: a rule, the prompt row, any further
 * draft rows, a rule. The box is found by its TOP rule (the last rule directly
 * followed by a prompt row) and runs to the next rule, so a draft line that
 * itself starts with `›`/`❯`, or a blank line inside a multi-line draft, stays
 * inside it. When the bottom rule is not on screen (a partial redraw in the
 * replayed tail) the box ends at the footer instead.
 *
 * Without a top rule (Codex) the composer is the last prompt row plus every row
 * under it up to a rule or the footer (Codex's `⏎ send` hints / `% context
 * left` row) — blank rows included, so a multi-line draft with a blank line in
 * it is not cut short and read as empty (codex review). Any other non-dim text
 * down there counts as a draft: parking a message is recoverable, typing into a
 * draft is not. A draft whose own line starts with a prompt glyph can still be
 * misread there.
 */
export function classifyComposer(rows: ComposerRow[]): ComposerState {
  const prompt = composerPromptRow(rows.map((r) => r.text));
  if (prompt < 0) return { kind: "unknown", reason: "no prompt row on screen" };
  let real = 0;
  let ghost = false;
  for (let i = prompt; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > prompt) {
      if (isComposerChrome(row.text)) break;
      if (!row.text.trim()) continue;
    }
    let cells = row.cells;
    if (i === prompt) {
      // Skip the indentation and the prompt glyph itself.
      const glyph = cells.findIndex((c) => c.ch === "❯" || c.ch === "›");
      cells = glyph >= 0 ? cells.slice(glyph + 1) : cells;
    }
    for (const c of cells) {
      if (!c.ch.trim() || c.ch === "\u00a0") continue;
      if (c.inverse) continue;
      if (c.dim) ghost = true;
      else real++;
    }
  }
  return real > 0 ? { kind: "draft", chars: real } : { kind: "empty", ghost };
}

type XtermLike = {
  buffer: {
    active: {
      length: number;
      getLine(i: number):
        | {
            length: number;
            translateToString(trim: boolean): string;
            getCell(
              x: number,
            ):
              | { getChars(): string; isDim(): number; isInverse(): number; getWidth(): number }
              | undefined;
          }
        | undefined;
    };
  };
};

/** Read the bottom `n` rows of an xterm buffer as ComposerRows. */
export function rowsFromXterm(term: XtermLike, n: number): ComposerRow[] {
  const active = term.buffer.active;
  const rows: ComposerRow[] = [];
  for (let i = Math.max(0, active.length - n); i < active.length; i++) {
    const line = active.getLine(i);
    if (!line) {
      rows.push({ text: "", cells: [] });
      continue;
    }
    const cells: ComposerCell[] = [];
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c || c.getWidth() === 0) continue; // trailing half of a wide char
      cells.push({ ch: c.getChars() || " ", dim: c.isDim() !== 0, inverse: c.isInverse() !== 0 });
    }
    rows.push({ text: line.translateToString(true), cells });
  }
  while (rows.length && rows[rows.length - 1]!.text.trim() === "") rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------
// Pending queue: one JSON file per parked message, under
// <AGENT_YES_HOME>/pending/<pid>/, delivered oldest first by one drainer.
// ---------------------------------------------------------------------------

/** Everything the drainer needs to deliver and to record a parked message. */
export interface PendingSend {
  id: string;
  queuedAt: number;
  pid: number;
  fifoPath: string;
  /** Exactly what cmdSend would have written (envelope + paste framing). */
  fullBody: string;
  trailing: string;
  /** Submit-confirm identity (`<ay-msg nonce` or the raw body). */
  identity: string;
  /** The mailbox record to append once the outcome is known. */
  record: Record<string, unknown>;
}

/** How long a parked message waits for the composer before it is given up. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function pendingDir(pid: number): string {
  return path.join(agentYesHome(), "pending", String(pid));
}

export async function listPending(pid: number): Promise<string[]> {
  const names = await readdir(pendingDir(pid)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".json")).sort();
}

export async function enqueuePending(p: Omit<PendingSend, "id">): Promise<PendingSend> {
  const dir = pendingDir(p.pid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Sortable name keeps delivery in send order: zero-padded ms, then random.
  const id = `${String(p.queuedAt).padStart(15, "0")}-${randomBytes(4).toString("hex")}`;
  const full: PendingSend = { ...p, id };
  const tmp = path.join(dir, `.${id}.tmp`);
  await writeFile(tmp, JSON.stringify(full), { mode: 0o600 });
  await rename(tmp, path.join(dir, `${id}.json`));
  return full;
}

export async function readPending(pid: number, name: string): Promise<PendingSend | null> {
  const raw = await readFile(path.join(pendingDir(pid), name), "utf-8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PendingSend;
  } catch {
    return null;
  }
}

/**
 * Take a parked message off the queue BEFORE writing it. Delivery is therefore
 * at most once: a drainer that dies mid-write loses the message (it is still in
 * the sender's outbox as queued) rather than pasting it a second time into
 * whatever the composer holds next. Returns false when another process took it.
 */
export async function claimPending(pid: number, name: string): Promise<boolean> {
  try {
    await rm(path.join(pendingDir(pid), name));
    return true;
  } catch {
    return false;
  }
}

/** Move a message the drainer gave up on out of the queue, keeping it on disk. */
export async function retirePending(pid: number, name: string, why: string): Promise<void> {
  const dir = path.join(pendingDir(pid), "undelivered");
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
  await rename(path.join(pendingDir(pid), name), path.join(dir, name)).catch(() => {});
  await writeFile(path.join(dir, `${name}.why`), `${why}\n`, { mode: 0o600 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Duplicate suppression at the sink. With the guard, rc=4 QUEUED is common, and
// a lane that reads it as "failed" resends the same report (observed
// 2026-10-08: [mitm-compat] → CTO twice, 6 s apart). The target keeps a tiny
// ledger of what agents recently sent it — sender, body HASH, time, outcome;
// never the body — read and written under the same input lock as the paste,
// so a resend racing the original still sees it.
// ---------------------------------------------------------------------------

/** An identical body from the same sender within this window is a resend. */
export const DUPLICATE_WINDOW_MS = 60_000;

export interface RecentSend {
  at: number;
  sender: string;
  hash: string;
  outcome: "sent" | "queued";
}

export function recentSendsPath(pid: number): string {
  return path.join(agentYesHome(), "pending", `${pid}.recent.jsonl`);
}

/** Who sent it, for dedupe purposes: an agent's stable id (or pid). A person at
 *  a shell (no agent) is never deduped — typing "continue" twice is deliberate. */
export function senderKey(
  from: { agent_id?: string | null; pid?: number | null } | null | undefined,
): string | null {
  if (!from) return null;
  if (from.agent_id) return `a:${from.agent_id}`;
  return typeof from.pid === "number" ? `p:${from.pid}` : null;
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

async function readRecent(pid: number): Promise<RecentSend[]> {
  const raw = await readFile(recentSendsPath(pid), "utf-8").catch(() => "");
  const out: RecentSend[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RecentSend);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** The earlier identical send this one repeats, or null. Call under the input lock. */
export async function findRecentDuplicate(
  pid: number,
  sender: string,
  body: string,
  now = Date.now(),
): Promise<RecentSend | null> {
  const hash = bodyHash(body);
  const hits = (await readRecent(pid)).filter(
    (r) =>
      r.sender === sender &&
      r.hash === hash &&
      now - r.at >= 0 &&
      now - r.at <= DUPLICATE_WINDOW_MS,
  );
  return hits.at(-1) ?? null;
}

/** Note a send (before it is typed or parked) and drop entries past the window. */
export async function noteRecentSend(
  pid: number,
  sender: string,
  body: string,
  outcome: RecentSend["outcome"],
  now = Date.now(),
): Promise<void> {
  const kept = (await readRecent(pid)).filter((r) => now - r.at <= DUPLICATE_WINDOW_MS);
  kept.push({ at: now, sender, hash: bodyHash(body), outcome });
  const file = recentSendsPath(pid);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/** What `ay send` prints when a send exits 4, so no caller reads it as a failure. */
export function queuedReceipt(kind: "parked" | "cli-queued" | "duplicate", detail: string): string {
  switch (kind) {
    case "parked":
      return `ay send: nothing was typed — ${detail}. The message is parked and will be delivered once the input box is empty and nobody is typing. Queued, do not resend.`;
    case "cli-queued":
      return `ay send: the target accepted it into its own queue (${detail}); it runs after the current turn. Queued, do not resend.`;
    case "duplicate":
      return `ay send: not resent — ${detail}. Do not resend.`;
  }
}
