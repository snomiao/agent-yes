// Env vars that PIN a process to a PARENT Claude Code session.
//
// When `ay` launches an agent, the wrapped CLI must be a CLEAN TOP-LEVEL session
// — every agent-yes agent gets its own pid, its own log, and (for claude) its
// own saved transcript. If these markers leak in from the launching env (e.g.
// `ay claude` run from inside another Claude Code session, or from this claude's
// Bash tool), the child claude:
//   - sees CLAUDE_CODE_CHILD_SESSION and turns transcript saving OFF
//     ("⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"), and
//   - sees CLAUDE_CODE_SSE_PORT / CLAUDE_CODE_SESSION_ID and tries to attach to
//     the parent's stale session, surfacing as "fail to connect".
//
// So we strip exactly this set on every spawn path. It is deliberately NARROW —
// the many OTHER CLAUDE_CODE_* settings configure provider/auth/limits
// (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_MAX_OUTPUT_TOKENS,
// …) and MUST pass through untouched.
//
// MIRRORED in rs/src/pty_spawner.rs (`CLAUDE_SESSION_PIN_ENV`) — the Rust runtime
// (the default) strips the same set; keep the two lists in sync. `AGENT_YES_PID`
// is handled separately per spawn path (index.ts re-stamps it with its own pid to
// build the subagent tree; serve.ts's freshAgentEnv drops it for clean console
// roots), so it is NOT part of this shared set.
export const CLAUDE_SESSION_PIN_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
] as const;

/** Delete the parent Claude Code session-pin vars from a mutable env map, in
 *  place. Idempotent (a no-op when they're already absent, e.g. a console spawn
 *  whose env came from freshAgentEnv). Returns the same object for chaining. */
export function stripClaudeSessionPin<T extends Record<string, string | undefined>>(env: T): T {
  for (const k of CLAUDE_SESSION_PIN_ENV) delete env[k];
  return env;
}
