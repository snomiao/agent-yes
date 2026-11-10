import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/**
 * Cached-first `ay ls` across remotes.
 *
 * Every `ay ls` used to probe every configured remote before printing a single
 * row, so one slow or unreachable machine (a WebRTC remote costs up to 25 s to
 * give up on) held the whole fleet view hostage. The listing is read far more
 * often than the fleet changes, so the trade is clear: print the LAST KNOWN
 * rows for each remote at once, say how old they are, and refresh in the
 * background so the next call is fresh. Nothing stale may ever look live —
 * every cached row and section carries its age — and `--waitFor` is the
 * explicit way to pay for fresh data when a decision needs it.
 *
 * One snapshot file per alias under `$AGENT_YES_HOME/remotes/`, beside the
 * health file (ts/remoteHealth.ts) and like it derived, disposable data:
 * deleting one costs a single "no cache yet" listing.
 */

/** The current failure streak of a remote, kept alongside its last good rows. */
export interface RemoteCacheError {
  message: string;
  /** When the current run of failures began (unchanged by later failures). */
  since: number;
  lastTriedAt: number;
}

export interface RemoteSnapshot {
  version: 1;
  alias: string;
  /** Time of the last SUCCESSFUL fetch; null when the remote has never answered. */
  fetchedAt: number | null;
  /** The `/api/ls` rows from that fetch (kept across later failures). */
  records: any[];
  error: RemoteCacheError | null;
}

/** Rows younger than this are served as-is without kicking a refresh. */
export const REMOTE_CACHE_FRESH_MS = 30_000;

export function remoteCachePath(alias: string): string {
  return path.join(agentYesHome(), "remotes", `${encodeURIComponent(alias)}.cache.json`);
}

/** The persisted snapshot, or null for missing/corrupt — a cold cache, never an error. */
export async function readRemoteSnapshot(alias: string): Promise<RemoteSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(remoteCachePath(alias), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const s = parsed as Partial<RemoteSnapshot>;
    if (s.version !== 1 || !Array.isArray(s.records)) return null;
    const fetchedAt =
      typeof s.fetchedAt === "number" && Number.isFinite(s.fetchedAt) ? s.fetchedAt : null;
    const e = s.error;
    const error =
      e && typeof e === "object" && typeof e.message === "string" && typeof e.since === "number"
        ? { message: e.message, since: e.since, lastTriedAt: Number(e.lastTriedAt) || e.since }
        : null;
    return { version: 1, alias, fetchedAt, records: s.records, error };
  } catch {
    return null;
  }
}

/** tmp + rename, like the health file: a concurrent reader never sees a torn file. */
export async function writeRemoteSnapshot(snap: RemoteSnapshot): Promise<void> {
  const dest = remoteCachePath(snap.alias);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snap));
  await rename(tmp, dest);
}

export type FetchOutcome = { ok: true; records: any[] } | { ok: false; message: string };

/**
 * Fold one fetch into the snapshot. Success replaces the rows and clears the
 * error; failure keeps the last good rows and extends the streak, preserving
 * `since` so the operator sees "unreachable since 14:02", not "since now".
 */
export function noteSnapshotResult(
  prev: RemoteSnapshot | null,
  alias: string,
  result: FetchOutcome,
  now: number,
): RemoteSnapshot {
  if (result.ok) return { version: 1, alias, fetchedAt: now, records: result.records, error: null };
  return {
    version: 1,
    alias,
    fetchedAt: prev?.fetchedAt ?? null,
    records: prev?.records ?? [],
    error: { message: result.message, since: prev?.error?.since ?? now, lastTriedAt: now },
  };
}

/** Whether the rows are old enough to warrant a refresh. Fails open to "stale". */
export function isStale(
  snap: RemoteSnapshot | null,
  now: number,
  freshMs = REMOTE_CACHE_FRESH_MS,
): boolean {
  if (!snap || snap.fetchedAt === null) return true;
  const age = now - snap.fetchedAt;
  return age < 0 || age >= freshMs;
}

/** "0s", "42s", "3m", "5h", "2d" — the table's AGE column vocabulary. */
export function humanizeAge(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** Local wall-clock HH:MM, for "unreachable since 14:02". */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The per-remote tag printed beside its section: where the rows came from and
 * how old they are. `refreshing` says a background refresh was just kicked.
 */
export function cacheAgeLabel(
  snap: RemoteSnapshot | null,
  now: number,
  refreshing: boolean,
): string {
  const base =
    snap && snap.fetchedAt !== null
      ? `cached ${humanizeAge(now - snap.fetchedAt)} ago`
      : "no cache yet";
  if (snap?.error) return `${base}, unreachable since ${hhmm(snap.error.since)}`;
  return refreshing ? `${base}, refreshing…` : base;
}

/** What `--waitFor` asked to block on. */
export interface WaitFor {
  local: boolean;
  /** Configured aliases to refresh in the foreground before printing. */
  remotes: string[];
}

/**
 * `--waitFor=all|local|<alias>[,<alias>…]`. Unknown aliases are an error
 * rather than silently waited-for-nothing: the flag exists so a caller can
 * trust the rows it gets, and a typo must not become a false "fresh".
 */
export function parseWaitFor(value: string, aliases: string[]): WaitFor | { error: string } {
  const v = value.trim();
  if (!v) return { error: "--waitFor needs a value: all, local, or an alias list" };
  if (v === "all") return { local: true, remotes: [...aliases] };
  if (v === "local") return { local: true, remotes: [] };
  const want = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = want.filter((a) => !aliases.includes(a));
  if (unknown.length)
    return {
      error: `--waitFor: unknown remote ${unknown.join(", ")} (configured: ${aliases.join(", ") || "none"})`,
    };
  return { local: false, remotes: [...new Set(want)] };
}

/** The `--json` shape for one remote: additive, so a parser can decide on staleness. */
export function jsonRemote(
  snap: RemoteSnapshot | null,
  now: number,
): {
  fetchedAt: number | null;
  stale: boolean;
  ageMs: number | null;
  error: RemoteCacheError | null;
  records: any[];
} {
  return {
    fetchedAt: snap?.fetchedAt ?? null,
    stale: isStale(snap, now),
    ageMs: snap && snap.fetchedAt !== null ? now - snap.fetchedAt : null,
    error: snap?.error ?? null,
    records: snap?.records ?? [],
  };
}
