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
  /** Sender; `null` when an interactive human shell sent it (no agent context). */
  from: MailParty | null;
  /** Recipient agent. */
  to: MailParty;
  /** What kind of stdin write this was. Omitted for a normal `ay send` text
   * message; "key" for raw keystrokes (`ay key`), "select" for a menu pick
   * (`ay select`), "auto-retry" for the wrapper's own recoverable-error nudge
   * (from is null; `body` holds the paraphrased reason + backoff state). */
  kind?: "key" | "select" | "auto-retry";
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

/** Keep at most this many lines per mailbox; older entries are compacted away. */
const MAILBOX_MAX_LINES = 2000;

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
  const outCwd = record.from?.cwd ?? process.cwd();
  try {
    await appendCapped(mailboxPath(outCwd, "outbox"), record);
  } catch (err) {
    logger.debug(`[messageLog] outbox append failed: ${err}`);
  }
}

/** Record the RECIPIENT's view in its inbox (under `to.cwd`). Best-effort. */
export async function recordInbox(record: MessageRecord): Promise<void> {
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
