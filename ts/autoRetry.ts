// Auto-retry on recoverable API errors (overload / rate-limit / usage-limit):
// agent-yes types "retry" with exponential backoff instead of letting the run
// die. This module holds the backoff schedule shared by the heartbeat logic and
// its tests. It mirrors the Rust runtime — see rs/src/context.rs
// (retry_backoff_secs / RETRY_* constants) — keep the two in sync.

export const AUTO_RETRY_BASE_SECS = 8; // first backoff; doubles each consecutive failure
export const AUTO_RETRY_MAX_DELAY_SECS = 256; // cap: 8,16,32,…,256 then hold
export const AUTO_RETRY_GIVE_UP_MS = 8 * 3600 * 1000; // stop after 8h (claude's usage window is ~5h)

// Minimum quiet time (no CLI output, no forwarded stdin — see idleWaiter.ping()
// call sites) required before a scheduled auto-retry may actually fire, on top
// of the backoff delay above. The backoff schedule alone can elapse while the
// user is mid-typing into the prompt; typing "retry" + Enter over that would
// submit a mangled line. Deliberately short — this only debounces against
// active typing, not a real excuse to delay recovery.
export const AUTO_RETRY_MIN_IDLE_MS = 5_000;

/** Backoff (ms) before the Nth consecutive auto-retry — doubles, then caps. */
export function autoRetryBackoffMs(streak: number): number {
  const shift = Math.min(streak, 20); // guard against absurd streaks blowing up 2 ** n
  const secs = Math.min(AUTO_RETRY_BASE_SECS * 2 ** shift, AUTO_RETRY_MAX_DELAY_SECS);
  return secs * 1000;
}

/**
 * Whether a scheduled auto-retry may actually fire: the agent must be sitting
 * idle at a ready prompt (not mid-work) AND the terminal must have been quiet
 * for at least `minIdleMs` — see AUTO_RETRY_MIN_IDLE_MS. Mirrors Rust's
 * should_fire_retry in rs/src/context.rs.
 */
export function shouldFireRetry(
  working: boolean,
  ready: boolean,
  idleMs: number,
  minIdleMs: number,
): boolean {
  return !working && ready && idleMs >= minIdleMs;
}
