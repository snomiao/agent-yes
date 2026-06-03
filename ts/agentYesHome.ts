import { homedir } from "os";
import path from "path";

/**
 * Root directory for cross-runtime, machine-global agent-yes state:
 * the pid index (`pids.jsonl`), FIFO/named-pipe IPC endpoints (`fifo/`),
 * winsize signals, notes, and the serve token.
 *
 * Durable per-session *logs* deliberately do NOT live here — they go under
 * `<cwd>/.agent-yes/` so they stay colocated with the project that produced
 * them (see `PidStore`). Only ephemeral IPC + the discovery index are global,
 * which keeps FIFOs on the local home filesystem (reliable `mkfifo`) and lets
 * `ay ls`/`ay attach` find every agent regardless of the caller's cwd.
 *
 * Resolved at call time (not module load) so tests and callers can override
 * via `$AGENT_YES_HOME` without juggling the module cache.
 */
export function agentYesHome(): string {
  return process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
}
