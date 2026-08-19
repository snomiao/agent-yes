/**
 * `ay hist` — read the tail of *coding-agent conversation transcripts* that
 * already exist on this machine (Claude Code, Codex), newest-last.
 *
 * This is deliberately NOT `ay tail`. `ay tail` follows the live PTY log of an
 * agent process agent-yes spawned; `ay hist` reads the durable JSONL transcript
 * the CLI itself writes, including sessions from before agent-yes was involved
 * and sessions whose process already exited.
 *
 * Design notes (the two that actually matter):
 *
 * 1. **Read backwards.** Transcript lines are whole JSON records and routinely
 *    reach 1.3MB (tool outputs, base64 images). Reading a file forward — or
 *    `readFile().split("\n")` — costs megabytes to show six records. We seek to
 *    EOF and walk back in chunks, stopping as soon as the caller has enough, so
 *    cost is proportional to what's displayed, not to session length.
 *
 * 2. **No index.** These files are append-only, so a sidecar index storing
 *    `indexed_up_to_bytes` would let a future `ay hist search` re-scan only the
 *    tail delta. Tailing needs none of that, and the 90% case is tailing — so
 *    v1 ships with zero index, zero daemon, zero cache invalidation.
 */

import { readdir, open, stat } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { homedir } from "os";
import path from "path";

const NEWLINE = 0x0a;

/** Which coding agent produced a transcript. */
export type HistSource = "claude" | "codex";

export interface TranscriptFile {
  path: string;
  source: HistSource;
  /** Session identifier — the file's basename for both supported sources. */
  sessionId: string;
  mtimeMs: number;
  size: number;
  /**
   * Working directory the session ran in, when known without reading the file.
   * Claude encodes it in the parent directory name; Codex only stores it inside
   * the file's `session_meta` record, so it stays undefined until resolved.
   */
  cwd?: string;
}

export interface HistRecord {
  /** ISO timestamp, or null for records that carry none. */
  ts: string | null;
  role: "user" | "assistant";
  text: string;
  source: HistSource;
  sessionId: string;
  file: string;
  /** Byte offset of the record's first byte, usable as a stable cursor. */
  offset: number;
}

/**
 * Claude Code names each project directory after its cwd with every
 * non-alphanumeric byte replaced by `-`:
 * `/code/snomiao/cv.snomiao.com` → `-code-snomiao-cv-snomiao-com`.
 *
 * Encoding the cwd and comparing is exact and costs no file reads — decoding
 * the slug back to a path is not possible, since `-` is ambiguous.
 */
export function encodeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsDir(home = homedir()): string {
  return path.join(home, ".claude", "projects");
}

export function codexSessionsDir(home = homedir()): string {
  return path.join(home, ".codex", "sessions");
}

async function listJsonlDeep(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  // Codex nests transcripts under YYYY/MM/DD; Claude is flat under the project
  // slug. A depth cap keeps a stray symlink from turning discovery into a walk
  // of the whole home directory.
  if (depth > 4) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // absent source (e.g. Codex never installed) is not an error
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonlDeep(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

export interface DiscoverOpts {
  home?: string;
  /** Restrict to sessions whose cwd matches. Omit for every project. */
  cwd?: string;
  sources?: readonly HistSource[];
}

/**
 * Locate transcripts, newest first. Only stats files — never opens them — so
 * this stays cheap even with thousands of sessions on disk.
 */
export async function discoverTranscripts(opts: DiscoverOpts = {}): Promise<TranscriptFile[]> {
  const home = opts.home ?? homedir();
  const sources = opts.sources ?? (["claude", "codex"] as const);
  const found: TranscriptFile[] = [];

  if (sources.includes("claude")) {
    const root = claudeProjectsDir(home);
    const wanted = opts.cwd ? encodeProjectSlug(opts.cwd) : null;
    let projects: string[] = [];
    try {
      projects = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      projects = [];
    }
    for (const slug of projects) {
      if (wanted && slug !== wanted) continue;
      for (const file of await listJsonlDeep(path.join(root, slug))) {
        const st = await stat(file).catch(() => null);
        if (!st?.isFile() || st.size === 0) continue;
        found.push({
          path: file,
          source: "claude",
          sessionId: path.basename(file, ".jsonl"),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  }

  if (sources.includes("codex")) {
    for (const file of await listJsonlDeep(codexSessionsDir(home))) {
      if (!path.basename(file).startsWith("rollout-")) continue; // skip history.jsonl
      const st = await stat(file).catch(() => null);
      if (!st?.isFile() || st.size === 0) continue;
      found.push({
        path: file,
        source: "codex",
        sessionId: path.basename(file, ".jsonl"),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (opts.cwd && sources.includes("codex")) {
    // Codex hides cwd inside the file, so it can only be filtered by peeking at
    // the head record. Done after sorting and only for Codex files, so the
    // common `--cwd` case reads at most a few KB per candidate session.
    const kept: TranscriptFile[] = [];
    for (const f of found) {
      if (f.source !== "codex") {
        kept.push(f);
        continue;
      }
      const cwd = await readCodexCwd(f.path);
      if (cwd === opts.cwd) kept.push({ ...f, cwd });
    }
    return kept;
  }

  return found;
}

/** Read the leading `session_meta` record of a Codex rollout to learn its cwd. */
export async function readCodexCwd(file: string): Promise<string | undefined> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const nl = buf.indexOf(NEWLINE);
    const end = nl === -1 ? bytesRead : nl;
    const rec = JSON.parse(buf.subarray(0, end).toString("utf8")) as {
      payload?: { cwd?: string };
    };
    return rec.payload?.cwd;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

export interface BackwardOpts {
  chunkSize?: number;
  maxRecordBytes?: number;
}

/**
 * Yield whole lines from EOF toward the start, newest first, as
 * `{ offset, text }`. Lazy: the generator only reads another chunk when the
 * consumer asks for another line, so `take(6)` reads ~one chunk regardless of
 * whether the file is 4KB or 400MB.
 *
 * A trailing partial line (a session being appended to right now) is dropped —
 * we stop at the last complete newline rather than hand back half a record.
 */
export async function* readLinesBackward(
  file: string,
  opts: BackwardOpts = {},
): AsyncGenerator<{ offset: number; text: string }> {
  const chunkSize = opts.chunkSize ?? 64 * 1024;
  const maxRecordBytes = opts.maxRecordBytes ?? 16 * 1024 * 1024;

  const fh = await open(file, "r");
  try {
    const st = await fh.stat();
    let pos = st.size;
    if (pos === 0) return;

    // `pending` holds bytes to the LEFT of everything already yielded, whose
    // owning line has not been closed by a newline yet. `base` is its offset.
    let pending = Buffer.alloc(0);
    let base = pos;
    let first = true;

    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);

      const combined = pending.length ? Buffer.concat([buf, pending]) : buf;
      base = pos;

      let end = combined.length;
      if (first) {
        first = false;
        // Drop anything after the final newline: either the empty string from a
        // well-formed trailing "\n", or a half-written record.
        const last = combined.lastIndexOf(NEWLINE);
        end = last === -1 ? 0 : last;
      }

      while (end > 0) {
        const nl = combined.lastIndexOf(NEWLINE, end - 1);
        if (nl === -1) break; // line starts before this chunk — carry it over
        const text = combined.subarray(nl + 1, end).toString("utf8");
        if (text.trim()) yield { offset: base + nl + 1, text };
        end = nl;
      }

      pending = combined.subarray(0, end);
      if (pending.length > maxRecordBytes) {
        // A single record larger than the cap means a corrupt or pathological
        // transcript (the largest legitimate record seen in practice is ~1.3MB).
        // Drop the partial buffer and resync at this chunk edge rather than
        // buffering without bound — losing one unreadable record is preferable
        // to holding the whole file in memory.
        pending = Buffer.alloc(0);
      }
    }

    // Whatever remains starts at byte 0 — the file's first line, unterminated
    // on its left by definition.
    const head = pending.toString("utf8");
    if (head.trim()) yield { offset: 0, text: head };
  } finally {
    await fh.close();
  }
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  name?: string;
  thinking?: string;
}

function claudeText(content: unknown, includeTools: boolean): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content as ClaudeBlock[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "text" && typeof raw.text === "string") parts.push(raw.text);
    else if (includeTools && raw.type === "thinking" && typeof raw.thinking === "string")
      parts.push(`(thinking) ${raw.thinking}`);
    else if (includeTools && raw.type === "tool_use") parts.push(`[tool: ${raw.name ?? "?"}]`);
    else if (includeTools && raw.type === "tool_result") parts.push(`[tool result]`);
  }
  return parts.join("\n").trim();
}

export interface ProjectOpts {
  /** Render tool calls/results/thinking as markers instead of dropping them. */
  includeTools?: boolean;
  /** Include Claude sub-agent (sidechain) turns. Off by default: high volume. */
  includeSidechains?: boolean;
}

/**
 * Reduce one raw transcript line to a displayable turn, or null when the record
 * is not conversational (metadata, token counts, tool plumbing, …).
 *
 * Returning null for the great majority of records is the point: it is what
 * makes six records of *conversation* cost six records of output rather than
 * six records of JSON noise.
 */
export function projectRecord(
  line: string,
  source: HistSource,
  opts: ProjectOpts = {},
): Pick<HistRecord, "ts" | "role" | "text"> | null {
  let rec: Record<string, any>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object") return null;

  if (source === "claude") {
    if (rec.type !== "user" && rec.type !== "assistant") return null;
    if (rec.isSidechain && !opts.includeSidechains) return null;
    const role = rec.message?.role === "assistant" ? "assistant" : "user";
    const text = claudeText(rec.message?.content, opts.includeTools ?? false);
    if (!text) return null;
    return { ts: typeof rec.timestamp === "string" ? rec.timestamp : null, role, text };
  }

  // Codex writes each turn twice: as a raw `response_item` and as a rendered
  // `event_msg`. The event stream is the clean one, so we read only that and
  // avoid emitting every turn twice.
  if (rec.type !== "event_msg") return null;
  const kind = rec.payload?.type;
  if (kind !== "user_message" && kind !== "agent_message") return null;
  const text = typeof rec.payload?.message === "string" ? rec.payload.message.trim() : "";
  if (!text) return null;
  return {
    ts: typeof rec.timestamp === "string" ? rec.timestamp : null,
    role: kind === "user_message" ? "user" : "assistant",
    text,
  };
}

/**
 * Position of a single record in the global ordering.
 *
 * Paging on a bare timestamp loses data: transcripts routinely contain several
 * records sharing one millisecond, so `ts < cursor` drops every record that
 * ties with the page boundary. `(ts, sessionId, offset)` is a total order —
 * `(sessionId, offset)` is unique by construction — so paging on it can neither
 * skip nor repeat a record.
 */
export interface Cursor {
  ts: string;
  sessionId: string;
  offset: number;
}

export function encodeCursor(r: HistRecord): string {
  return `${r.ts ?? ""}|${r.sessionId}|${r.offset}`;
}

/** Parse an encoded cursor; returns null for a bare timestamp or garbage. */
export function decodeCursor(raw: string): Cursor | null {
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const offset = Number(parts[2]);
  if (!Number.isFinite(offset)) return null;
  return { ts: parts[0]!, sessionId: parts[1]!, offset };
}

/** Total order over records: timestamp, then session, then byte offset. */
export function compareRecords(
  a: Pick<HistRecord, "ts" | "sessionId" | "offset">,
  b: Pick<HistRecord, "ts" | "sessionId" | "offset">,
): number {
  return (
    (a.ts ?? "").localeCompare(b.ts ?? "") ||
    a.sessionId.localeCompare(b.sessionId) ||
    a.offset - b.offset
  );
}

export interface TailOpts extends ProjectOpts, BackwardOpts {
  /** Max records to return. */
  limit: number;
  /** Only records strictly older than this ISO timestamp. */
  before?: string;
  /** Only records strictly before this position. Takes precedence over `before`. */
  cursor?: Cursor;
  role?: "user" | "assistant";
}

/**
 * Newest `limit` conversational records of one transcript, oldest-first.
 *
 * Stops reading as soon as `limit` records are collected — the whole reason the
 * backward reader is a generator.
 */
export async function tailTranscript(
  file: TranscriptFile,
  opts: TailOpts,
): Promise<HistRecord[]> {
  const out: HistRecord[] = [];
  for await (const { offset, text } of readLinesBackward(file.path, opts)) {
    const projected = projectRecord(text, file.source, opts);
    if (!projected) continue;
    if (opts.role && projected.role !== opts.role) continue;
    const record: HistRecord = {
      ...projected,
      source: file.source,
      sessionId: file.sessionId,
      file: file.path,
      offset,
    };
    if (opts.cursor) {
      if (compareRecords(record, opts.cursor) >= 0) continue;
    } else if (opts.before && projected.ts && projected.ts >= opts.before) {
      continue;
    }
    out.push(record);
    if (out.length >= opts.limit) break;
  }
  return out.reverse();
}

export interface HistPage {
  records: HistRecord[];
  /**
   * Opaque cursor to pass as `--before` for the next (older) page, or null when
   * the history is exhausted. Opaque rather than a numeric offset: sessions are
   * appended to constantly, so `--skip N` would shift under the caller between
   * pages.
   */
  cursor: string | null;
  /** Transcripts consulted, for reporting when nothing matched. */
  scanned: number;
}

export interface HistQuery extends TailOpts {
  home?: string;
  cwd?: string;
  sources?: readonly HistSource[];
  /**
   * Cap on transcripts to tail before merging. Sessions are sorted newest-first,
   * so a low cap only excludes sessions too old to appear in the page anyway.
   */
  maxFiles?: number;
}

/**
 * Merge the tails of the most recently touched transcripts into one
 * chronological page — "what have my agents been saying", across sessions.
 */
export async function histPage(q: HistQuery): Promise<HistPage> {
  const files = await discoverTranscripts({ home: q.home, cwd: q.cwd, sources: q.sources });
  const considered = files.slice(0, q.maxFiles ?? 40);

  // Over-read by one per transcript. Without it, a page filled entirely by a
  // single session would look exhausted — we would have stopped at exactly
  // `limit` and had no evidence that older records remained.
  const perFile = q.limit > 0 ? q.limit + 1 : Number.MAX_SAFE_INTEGER;
  // `--before` accepts either an encoded cursor or a bare ISO timestamp typed by
  // hand; only the former can page without losing timestamp ties.
  const cursor = q.cursor ?? (q.before ? decodeCursor(q.before) : null);
  const tails = await Promise.all(
    considered.map((f) =>
      tailTranscript(f, { ...q, limit: perFile, cursor: cursor ?? undefined }),
    ),
  );
  const merged = tails.flat();

  // Records without a timestamp sort oldest, so a well-timestamped page is
  // never displaced by metadata-poor records.
  merged.sort(compareRecords);

  const records = q.limit > 0 ? merged.slice(-q.limit) : merged;
  const oldest = records[0];
  const more = merged.length > records.length;

  return {
    records,
    cursor: more && oldest ? encodeCursor(oldest) : null,
    scanned: considered.length,
  };
}
