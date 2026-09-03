/**
 * Durable inter-agent message log.
 *
 * Every `ay send` that carries a real body is recorded twice — from the two
 * ends' points of view — as append-only JSONL colocated with each agent's
 * project dir (the same `<cwd>/.agent-yes/` convention the session logs use):
 *
 *   - the SENDER's   `<from.cwd>/.agent-yes/outbox.jsonl`
 *   - the RECIPIENT's `<to.cwd>/.agent-yes/inbox.jsonl`
 *
 * A single cwd may host several agents, so records carry the stable `agent_id`
 * (falling back to `pid`) of each end; `ay msgs` filters a mailbox down to one
 * agent by that key. Reading needs no lock (last line wins isn't relevant — a
 * message log keeps every entry); writing is best-effort and never blocks or
 * fails a send.
 */

import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { logger } from "./logger.ts";
import { isUnpromptedTerminalReply } from "./terminalReply.ts";

/**
 * Where a write entered this host — its provenance, as known at the door.
 *
 * `from === null` used to be read as "a human typed this", because the one
 * producer that left it null was an interactive `ay send`. It is now four
 * producers, and only one of them is a person's shell. A console forwarding a
 * terminal's own bytes and a public callback visitor also arrive unattributed,
 * so inferring a human from an absent sender hands the operator's label to a
 * wire artefact — and an agent that weighs a human's instruction above another
 * agent's is exactly the reader that must not be told that.
 *
 *  - `shell`   — a local `ay send` / `key` / `select` with no agent context.
 *                The only origin a person is behind, and even then only
 *                probably: a script invoking the CLI looks the same.
 *  - `wire`    — an unattributed `POST /api/send`: the web console, a remote
 *                `ay send` from a host that sent no `from`, any HTTP client.
 *  - `visitor` — the public callback widget. A stranger on the internet.
 *  - `wrapper` — the agent's own supervisor (the auto-retry nudge).
 */
export type MessageOrigin = "shell" | "wire" | "visitor" | "wrapper";

/** One end of a message: enough to attribute and to route a reply. */
export interface MailParty {
  pid: number;
  cli: string;
  cwd: string;
  agent_id?: string | null;
}

/** A single delivered inter-agent message, stored verbatim in both mailboxes. */
export interface MessageRecord {
  /** Epoch ms the send was recorded. */
  at: number;
  /** The per-send nonce from the `[ay-msg …]` wrapper, when the body was wrapped. */
  nonce?: string;
  /** Sender; `null` when no agent context was attributed to the write. `null`
   * is NOT evidence of a human — see {@link MessageOrigin}. */
  from: MailParty | null;
  /** WHERE the write entered this host, recorded by the entry point rather than
   * inferred later from `from`. Absent on rows written before this field
   * existed, which is why a missing value renders as unattributed and never as
   * a human. See {@link MessageOrigin}. */
  origin?: MessageOrigin;
  /** Recipient agent. */
  to: MailParty;
  /** What kind of stdin write this was. Omitted for a normal `ay send` text
   * message; "key" for raw keystrokes (`ay key`), "select" for a menu pick
   * (`ay select`), "auto-retry" for the wrapper's own recoverable-error nudge
   * (from is null; `body` holds the paraphrased reason + backoff state);
   * "terminal" for a viewer forwarding its terminal's raw bytes — typing, mouse
   * reports, the terminal's own answers — which the producer declares and
   * {@link shouldRecord} never stores. */
  kind?: "key" | "select" | "auto-retry" | "terminal";
  /** The message body (without the `[ay-msg …]` wrapper), or — for a key/select
   * record — the keystroke names / chosen option. */
  body: string;
  /** Trailing control code name (e.g. "enter", "ctrl-c") when not a plain submit. */
  code?: string;
  /** Whether `ay send` confirmed the CLI acted on it. */
  confirmed?: boolean;
  /** Whether the body was wrapped in an `[ay-msg …]` attribution block. */
  wrapped: boolean;
  /** The remote url/alias when this message crossed the wire (`ay send <remote>:<kw>`);
   * absent for a same-host send. The two ends record their own mailbox on their
   * own machine, so this marks that the peer's cwd is on another host. */
  remote?: string;
}

/**
 * Whether a record belongs in a mailbox at all.
 *
 * A terminal answers protocol queries the TUI makes — where is the cursor, what
 * terminal are you, what is your background colour — and those answers reach the
 * agent's stdin the same way a message does. Without this they are stored as
 * messages, and the mailbox is capped, so they evict it.
 *
 * Why that is worse than untidy: this log is the documented recovery path for a
 * message that arrived truncated, and an evicted message is indistinguishable
 * from one that was never sent. Measured on one agent, 1,989 of its 2,000 slots
 * were `ESC[?59;3R` arriving at ~292/min, so the window held SEVEN MINUTES.
 * Raising MAILBOX_MAX_LINES cannot fix a rate; the rows have to stop being
 * recorded.
 *
 * THREE conditions. Condition 0 is the producer's own declaration; of the two
 * that inspect the record, only the first discriminates:
 *
 *  0. The write was declared raw terminal forwarding (`kind: "terminal"`) — a
 *     viewer pushing what its xterm emitted, which is never a message however
 *     the bytes happen to look. See below for why shape could not do this.
 *
 *  1. The body is nothing but replies nobody asked for
 *     (`isUnpromptedTerminalReply`). That predicate is deliberately narrower
 *     than serve's `isTerminalReply` — see its doc for the two families it
 *     refuses to claim, and why "only the final byte separates an input from a
 *     reply" turned out to be false.
 *  2. No agent sent it. Across 128,827 stored rows every reply-shaped body had
 *     `from === null` and none had a sender, so this never fires today. It is
 *     here so an agent that deliberately pushes such bytes still gets a durable
 *     record. Shape decides; the sender is a margin, and NOT a safety net for
 *     humans — an interactive human sender is also `from === null`, which is why
 *     every ambiguous shape has to be excluded by shape.
 *
 * NOT COVERED BY SHAPE, named rather than silently missed: SGR mouse reports
 * (36,616 rows) and plain CPR, both excluded because they collide with real
 * input; focus in/out (`ESC[I` / `ESC[O`, 215 rows), shape-identical to a
 * two-byte CSI key. What shape alone drops is 47,331 of 128,827 stored rows
 * (36.7%) — and 99.5% of the mailbox that was measured broken, whose noise was
 * pure DECXCPR.
 *
 * Those families are what condition 0 is for. They are undecidable from the
 * bytes BUT trivial at the source: a viewer forwarding its terminal's stdin
 * knows none of it is a message. So the producer says so (`raw: true` on
 * POST /api/send), serve tags the record `kind: "terminal"`, and this drops it
 * without inferring anything from a shape a keypress could also make. A client
 * that does not send the flag is unaffected — it falls through to conditions 1
 * and 2 exactly as before.
 */
/**
 * How to name the sender of a record in a listing.
 *
 * Never claims a human on the strength of an absent sender: an unattributed
 * write whose origin was not recorded is `unattributed`, because that is all
 * that is known about it. Only `origin: "shell"` — a local CLI invocation with
 * a terminal behind it — is called human, and a caller that must not be fooled
 * should read `origin` itself rather than this label.
 */
export function senderLabel(record: MessageRecord): string {
  if (record.from) return `${record.from.cli} #${record.from.pid}`;
  switch (record.origin) {
    case "shell":
      return "human";
    case "wire":
      return "wire";
    case "visitor":
      return "visitor";
    case "wrapper":
      return "agent-yes";
  }
  // No origin recorded. Written before the field existed, or by a producer that
  // did not declare one — either way the sender is unknown, and "human" is a
  // claim nothing here supports. The auto-retry nudge predates `origin` and is
  // still identifiable by its kind.
  return record.kind === "auto-retry" ? "agent-yes" : "unattributed";
}

export function shouldRecord(record: MessageRecord): boolean {
  if (record.kind === "terminal") return false;
  if (record.from) return true;
  return !isUnpromptedTerminalReply(record.body ?? "");
}

/** Keep at most this many lines per mailbox; older entries are compacted away. */
export const MAILBOX_MAX_LINES = 2000;

export type Mailbox = "inbox" | "outbox";

/** Path to a cwd's mailbox file (`<cwd>/.agent-yes/{inbox,outbox}.jsonl`). */
export function mailboxPath(cwd: string, box: Mailbox): string {
  return path.join(cwd, ".agent-yes", `${box}.jsonl`);
}

/** Whether a mail party is the agent identified by (agentId, pid). Prefers the
 * stable agent_id (survives restart); falls back to pid for legacy records. */
export function partyMatches(
  party: MailParty | null,
  agentId: string | null | undefined,
  pid: number | null | undefined,
): boolean {
  if (!party) return false;
  if (agentId && party.agent_id && party.agent_id === agentId) return true;
  if (typeof pid === "number" && party.pid === pid) return true;
  return false;
}

async function appendCapped(filePath: string, record: MessageRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n");
  // Opportunistic compaction: keep the file bounded despite append-only writes.
  const raw = await readFile(filePath, "utf-8").catch(() => "");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length > MAILBOX_MAX_LINES) {
    const kept = lines.slice(lines.length - MAILBOX_MAX_LINES).join("\n");
    await writeFile(filePath, kept + "\n");
  }
}

/**
 * Record the SENDER's view in its outbox. Best-effort — a filesystem error is
 * logged and swallowed so persistence never breaks a send. The outbox lives
 * under `from.cwd`; a human sender (from === null) writes under `process.cwd()`.
 */
export async function recordOutbox(record: MessageRecord): Promise<void> {
  if (!shouldRecord(record)) return;
  const outCwd = record.from?.cwd ?? process.cwd();
  try {
    await appendCapped(mailboxPath(outCwd, "outbox"), record);
  } catch (err) {
    logger.debug(`[messageLog] outbox append failed: ${err}`);
  }
}

/** Record the RECIPIENT's view in its inbox (under `to.cwd`). Best-effort. */
export async function recordInbox(record: MessageRecord): Promise<void> {
  if (!shouldRecord(record)) return;
  try {
    await appendCapped(mailboxPath(record.to.cwd, "inbox"), record);
  } catch (err) {
    logger.debug(`[messageLog] inbox append failed: ${err}`);
  }
}

/**
 * Record a same-host message in both mailboxes — the sender's outbox and the
 * recipient's inbox both live on this machine. For a message that crossed the
 * wire, each end calls `recordOutbox`/`recordInbox` on its own host instead.
 */
export async function recordMessage(record: MessageRecord): Promise<void> {
  await recordOutbox(record);
  await recordInbox(record);
}

/** Read and parse a cwd's mailbox, oldest first. Missing/corrupt lines skipped. */
export async function readMailbox(cwd: string, box: Mailbox): Promise<MessageRecord[]> {
  let raw: string;
  try {
    raw = await readFile(mailboxPath(cwd, box), "utf-8");
  } catch {
    return [];
  }
  const out: MessageRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as MessageRecord;
      if (rec && typeof rec.at === "number" && rec.to) out.push(rec);
    } catch {
      /* skip corrupt/partial line */
    }
  }
  return out;
}
