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
import { randomBytes } from "crypto";
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
  /^\s*(?:·\s*)?(?:[←→] .*agents|\? for shortcuts|esc to interrupt|ctrl\+t to|GPT-[^·]*·|gpt-[^·]*·|⏵⏵|⏸)/iu;

/**
 * Classify the composer from rendered rows (oldest first, screen bottom last).
 * The composer is the LAST prompt row (text after the glyph) plus the wrapped
 * rows under it, up to the separator or the footer.
 */
export function classifyComposer(rows: ComposerRow[]): ComposerState {
  const prompt = rows.findLastIndex((r) => PROMPT_RE.test(r.text));
  if (prompt < 0) return { kind: "unknown", reason: "no prompt row on screen" };
  let real = 0;
  let ghost = false;
  for (let i = prompt; i < rows.length; i++) {
    const row = rows[i]!;
    // A blank row also ends the box: the bottom rule is not always on screen (a
    // partial redraw in the replayed tail), and the footer under it is chrome.
    // A draft whose FIRST line is blank is the one shape this can miss.
    if (i > prompt && (!row.text.trim() || SEPARATOR_RE.test(row.text) || FOOTER_RE.test(row.text)))
      break;
    let cells = row.cells;
    if (i === prompt) {
      // Skip the indentation and the prompt glyph itself.
      const glyph = cells.findIndex((c) => c.ch === "❯" || c.ch === "›");
      cells = glyph >= 0 ? cells.slice(glyph + 1) : cells;
    }
    for (const c of cells) {
      if (!c.ch.trim() || c.ch === " ") continue;
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
