/**
 * Scheduler policy: agent CLIs run at a positive nice so they YIELD CPU to the
 * interactive `ay serve` daemon (which stays at nice 0) under host load. This is
 * why the web console (/w/) lags while the local terminal stays smooth: every
 * byte for /w/ flows through the single `ay serve` event loop, which competes
 * with N busy agent CLIs for CPU. We deprioritize the agents rather than raise
 * serve because RAISING priority (negative nice) needs CAP_SYS_NICE, which is
 * dropped in many containers (e.g. this one) — LOWERING priority is always
 * allowed for your own processes, so this is portable.
 *
 * The value applies to the freshly-spawned CLI child; its threads and descendant
 * processes inherit it. Standalone `ay claude` with no contention is unaffected
 * (nice only matters when CPU is scarce).
 *
 * Configure with AGENT_YES_AGENT_NICE: an integer 0..19. Default 5. 0 disables.
 * Mirrored in the Rust runtime (rs/src/pty_spawner.rs) — keep them in sync.
 */

const DEFAULT_AGENT_NICE = 5;

/** Parse AGENT_YES_AGENT_NICE → a clamped positive nice (0..19). 0 = disabled. */
export function agentNiceValue(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_YES_AGENT_NICE;
  if (raw === undefined || raw === "") return DEFAULT_AGENT_NICE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_AGENT_NICE;
  // Positive-only: we never elevate (negative needs CAP_SYS_NICE and would fight
  // the daemon). Clamp into the standard nice range.
  return Math.max(0, Math.min(19, Math.trunc(n)));
}

/**
 * Best-effort: deprioritize a freshly-spawned agent process to the configured
 * nice. Swallows all errors — a scheduling hint must never break a spawn (and on
 * a platform/where setpriority is unavailable it simply no-ops).
 */
export async function applyAgentNice(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const nice = agentNiceValue(env);
  if (nice <= 0) return;
  try {
    const os = await import("os");
    os.setPriority(pid, nice);
  } catch {
    /* setpriority unavailable / raced with exit — ignore */
  }
}
