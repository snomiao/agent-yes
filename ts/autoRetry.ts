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

/** Fallback reason when no autoRetry match was captured before firing. */
export const AUTO_RETRY_REASON_FALLBACK = "a transient server-side error";

/**
 * All reason strings `classifyAutoRetryReason` can produce — used by the
 * self-trigger guard spec to prove every possible typed message is inert
 * against every CLI's screen-scrape patterns. Mirrors Rust's RETRY_REASONS.
 */
export const AUTO_RETRY_REASONS = [
  "the model backend reported it is temporarily busy",
  "the response stream stalled mid-way",
  "the connection dropped mid-response",
  "a usage cap was reached (it may need time to reset)",
  "requests are being throttled by the server",
  AUTO_RETRY_REASON_FALLBACK,
] as const;

/**
 * Paraphrase the matched recoverable-error banner into a short reason.
 *
 * Deliberately NEVER echoes the raw banner wording ("API Error", "Overloaded",
 * "rate limit", …): the built message is typed into the PTY and stays visible
 * in the transcript, where raw wording would re-match the autoRetry patterns —
 * keeping the error state true forever, which blocks the streak reset on
 * recovery. Mirrors Rust's classify_retry_reason.
 */
export function classifyAutoRetryReason(screen: string): string {
  const s = screen.toLowerCase();
  if (s.includes("overload")) return AUTO_RETRY_REASONS[0];
  if (s.includes("stalled")) return AUTO_RETRY_REASONS[1];
  if (s.includes("connection closed")) return AUTO_RETRY_REASONS[2];
  if (s.includes("usage limit") || s.includes("session limit")) return AUTO_RETRY_REASONS[3];
  if (s.includes("rate") && s.includes("limit")) return AUTO_RETRY_REASONS[4];
  return AUTO_RETRY_REASON_FALLBACK;
}

/** Human-readable duration: "45s", "3m20s", "1h04m", "8h". Mirrors Rust's fmt_dur_secs. */
export function formatDurationSecs(total: number): string {
  const t = Math.max(0, Math.floor(total));
  if (t < 60) return `${t}s`;
  if (t < 3600) {
    const m = Math.floor(t / 60);
    const s = t % 60;
    return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

/**
 * The single line typed into the agent's prompt instead of a bare "retry":
 * says WHO is nudging (agent-yes, automated), WHY (paraphrased reason), and
 * the backoff state (attempt #, elapsed, next delay, give-up horizon), plus an
 * explicit "ignore if nothing failed" clause so an agent that already
 * recovered — or is mid-question — doesn't burn a turn asking what "retry"
 * refers to. Must stay one line (it is submitted with a single "\r").
 * Mirrors Rust's build_retry_message in rs/src/context.rs.
 */
export function buildAutoRetryMessage(
  attempt: number,
  reason: string,
  sinceFirstSecs: number,
  nextBackoffSecs: number,
): string {
  const since = formatDurationSecs(sinceFirstSecs);
  const next = formatDurationSecs(nextBackoffSecs);
  const giveUp = formatDurationSecs(AUTO_RETRY_GIVE_UP_MS / 1000);
  return (
    `retry [auto-retry #${attempt} by agent-yes: ${reason}; first seen ${since} ago; ` +
    `if this attempt fails too, the next nudge comes in ${next} (giving up after ${giveUp}). ` +
    `This is an automated recovery nudge - if no request actually failed, ignore it and ` +
    `simply continue your previous task.]`
  );
}
