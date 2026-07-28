/**
 * Best-effort OS process start time, as an OPAQUE token.
 *
 * Why: `ay notifyd`'s singleton lock records `{pid, started_at}` where
 * `started_at` is OUR OWN wall-clock stamp from when the daemon acquired the
 * lock. That proves nothing about the pid the OS currently has: a pid recycled
 * onto an unrelated live process inside the owner TTL would pass `isPidAlive`
 * and be trusted as "the daemon is running" — so `ensureDaemon` would decline to
 * start a real one. Cross-checking the OS's own notion of when that pid started
 * closes the window: the recycled process has a different start time.
 *
 * The token is deliberately opaque (a raw platform string, compared only for
 * equality) — no epoch math, no clock-tick/boot-time arithmetic, nothing to get
 * subtly wrong across platforms. It is only ever compared against a token this
 * same code produced for the same pid.
 *
 * BEST-EFFORT by contract: every reader returns `null` when it cannot answer
 * (unsupported platform, missing /proc, `ps` unavailable or slow). Callers MUST
 * treat null as "no opinion" and fall back to the existing checks — this
 * tightens an edge, it must never introduce a new way to fail.
 *
 * Issue #169 item 1.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Extract field 22 (`starttime`, in clock ticks since boot) from a Linux
 * `/proc/<pid>/stat` line.
 *
 * The parse must start AFTER the last `)`: field 2 is the executable name in
 * parentheses and may itself contain spaces and parens (`(my prog (v2))`), so
 * naive whitespace splitting mis-indexes every later field. After the last `)`
 * the remaining fields begin at field 3, hence `starttime` is index 19.
 */
export function parseLinuxStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const starttime = fields[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}

/** Injection seam so the specs can exercise every platform on any host. */
export interface StartTokenReaders {
  platform: string;
  /** Contents of /proc/<pid>/stat, or null. */
  readProcStat?: (pid: number) => string | null;
  /** Output of `ps -o lstart= -p <pid>`, or null. */
  readPsLstart?: (pid: number) => string | null;
}

function defaultProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
}

function defaultPsLstart(pid: number): string | null {
  try {
    // `lstart` is the absolute start time ("Sun Jul 27 06:00:00 2026") — stable
    // for the life of the process, unlike `etime`. Second resolution, so it does
    // not by itself distinguish two processes that started in the same second;
    // it is one more independent signal on top of the pid+heartbeat checks, not
    // a replacement for them. Bounded timeout: this runs on interactive paths.
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Normalize a raw reader result: trim, and treat an empty answer as "unknown". */
function normalize(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * An opaque token identifying WHEN `pid` started, or null when unknowable.
 *
 * Windows deliberately returns null: the only readily available reader is a
 * PowerShell `Get-Process` spawn (hundreds of ms), far too heavy for a path
 * that runs every couple of seconds under `ay notify watch`.
 */
export function osProcessStartToken(pid: number, deps?: StartTokenReaders): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const platform = deps?.platform ?? process.platform;
  if (platform === "linux") {
    const stat = (deps?.readProcStat ?? defaultProcStat)(pid);
    return stat ? parseLinuxStartTime(stat) : null;
  }
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") {
    return normalize((deps?.readPsLstart ?? defaultPsLstart)(pid));
  }
  return null;
}

/**
 * Does a RECORDED start token prove the pid has been recycled since?
 *
 * True only on positive disagreement — both sides present and different. A
 * missing record (an owner written by an older build, or on a platform with no
 * reader) or an unreadable current value yields false, i.e. "no opinion, keep
 * trusting the other checks". Fail-open is correct here precisely because this
 * is an ADDITIONAL guard layered on pid-liveness + heartbeat freshness.
 */
export function osStartTokenMismatch(
  recorded: string | null | undefined,
  current: string | null,
): boolean {
  if (typeof recorded !== "string" || recorded === "") return false;
  if (current === null) return false;
  return current !== recorded;
}
