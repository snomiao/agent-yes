import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

/**
 * Backoff for remotes that are not answering.
 *
 * `ay ls` gathers every configured remote on every invocation. A host that has
 * gone away costs a full `CONNECT_TIMEOUT_MS` (25s for a WebRTC spec) and
 * returns nothing, and `Promise.allSettled` waits for all of them — so two dead
 * entries in `remotes.yaml` made every `ay ls` on this fleet take 27s instead of
 * 5s. Measured, then confirmed by removing only those two from a COPY of the
 * config: 27.40s → 5.49s.
 *
 * Deleting the remote is the wrong remedy: those machines can come back, and a
 * config someone must REMEMBER to re-add is a worse failure than a slow list.
 * So the entry stays, and we stop paying for it every time.
 *
 * WHY EXPONENTIAL AND NOT φ: the operator's φ-backoff rule (golden ratio, no
 * 2x) is a symval/symval convention — its AGENTS.md, its helpers. agent-yes is a
 * general tool in snomiao/ and that rule does not reach it. This repo already
 * has one backoff shape, `ts/autoRetry.ts` (base × 2ⁿ, capped, mirrored in
 * rs/src/context.rs), and one repo with two backoff shapes is its own defect.
 * So this mirrors autoRetry deliberately rather than importing a foreign
 * convention or inventing a third.
 */

/** First skip window after a host fails. Short: a blip should barely register. */
export const REMOTE_BACKOFF_BASE_MS = 60_000;
/** Cap, mirroring autoRetry's shape: 1m, 2m, 4m, … 32m, then hold. */
export const REMOTE_BACKOFF_MAX_MS = 32 * 60_000;

/** One host's consecutive-failure state. Empty for a host that has never failed. */
export interface RemoteHealth {
  /** Consecutive failures. Reset to 0 by any success. */
  streak: number;
  /** When the most recent failure was recorded. */
  lastFailedAt: number;
}

/**
 * How long to skip a host after `streak` consecutive failures — doubling, then
 * capped, exactly as `autoRetryBackoffMs` does.
 */
export function remoteBackoffMs(streak: number): number {
  if (streak <= 0) return 0;
  const shift = Math.min(streak - 1, 20); // guard: 2**n on an absurd streak
  return Math.min(REMOTE_BACKOFF_BASE_MS * 2 ** shift, REMOTE_BACKOFF_MAX_MS);
}

/**
 * Whether a host should be SKIPPED right now.
 *
 * Fails OPEN in every ambiguous case — no record, a zero/negative streak, a
 * clock that has gone backwards. The cost of wrongly skipping is an agent that
 * silently vanishes from `ay ls`; the cost of wrongly probing is one slow list.
 * Those are not symmetric, so the tie goes to probing.
 */
export function shouldSkipRemote(health: RemoteHealth | undefined, now: number): boolean {
  // The `streak <= 0` half is REDUNDANT today — `remoteBackoffMs` already
  // returns 0 for a non-positive streak, so the comparison below is false
  // anyway. Verified: no input distinguishes this function with and without it,
  // which is why no test covers that clause and none pretends to. Kept because
  // it states the invariant at the point a reader needs it, and it stops a
  // future change to the backoff curve from silently making "healthy" skippable.
  // The tripwire for that lives in the spec, on `remoteBackoffMs(0) === 0` —
  // reachable, so it can actually fail — and says there that it guards this.
  if (!health || health.streak <= 0) return false;
  const elapsed = now - health.lastFailedAt;
  if (elapsed < 0) return false; // clock moved backwards — probe rather than guess
  return elapsed < remoteBackoffMs(health.streak);
}

/** Record an outcome. Success clears the streak entirely; failure extends it. */
export function noteRemoteResult(
  health: RemoteHealth | undefined,
  ok: boolean,
  now: number,
): RemoteHealth {
  if (ok) return { streak: 0, lastFailedAt: 0 };
  return { streak: (health?.streak ?? 0) + 1, lastFailedAt: now };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Health lives beside `remotes.yaml` in the state dir, NOT inside it: that file
 * is the operator's config and this is derived, disposable data. Deleting it
 * costs one slow `ay ls` and nothing else.
 */
function healthPath(): string {
  const dir = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  return path.join(dir, "remote-health.json");
}

/** Read the per-alias health map. Any error yields {} — probe rather than skip. */
export async function readRemoteHealth(): Promise<Record<string, RemoteHealth>> {
  try {
    const raw = await readFile(healthPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Validate each entry rather than trusting the file. This is derived data in
    // a writable path: a hand-edited or half-migrated record with a plausible
    // streak would otherwise skip a healthy host, and the whole point of the
    // fail-open design is that no bad input can hide a live agent.
    const out: Record<string, RemoteHealth> = {};
    for (const [alias, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const { streak, lastFailedAt } = v as Partial<RemoteHealth>;
      if (typeof streak !== "number" || !Number.isFinite(streak)) continue;
      if (typeof lastFailedAt !== "number" || !Number.isFinite(lastFailedAt)) continue;
      out[alias] = { streak, lastFailedAt };
    }
    return out;
  } catch {
    return {}; // missing, unreadable, or corrupt — fail open
  }
}

/**
 * Best-effort write. A health file we cannot persist must never break `ay ls`.
 *
 * Written to a temp file and renamed, so a concurrent reader sees either the old
 * file or the new one and never a truncated one. Two `ay ls` processes finishing
 * together still last-writer-wins — that is acceptable here because the loser's
 * data is one probe's worth of a self-correcting counter, and because reading a
 * torn file already fails open to "probe".
 */
export async function writeRemoteHealth(health: Record<string, RemoteHealth>): Promise<void> {
  const dest = healthPath();
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(health, null, 2));
  await rename(tmp, dest);
}

/**
 * Drop entries for aliases that are no longer configured, so the file cannot
 * grow without bound as remotes come and go. Called with the live alias set.
 */
export function pruneRemoteHealth(
  health: Record<string, RemoteHealth>,
  aliases: Iterable<string>,
): Record<string, RemoteHealth> {
  const live = new Set(aliases);
  return Object.fromEntries(Object.entries(health).filter(([alias]) => live.has(alias)));
}
