import path from "path";

/**
 * Should a nested agent-run detach (fork) instead of blocking the caller?
 *
 * A claude/codex agent that runs `ay <cli> -- <task>` inside its Bash tool would
 * otherwise block that Bash call for the whole (possibly very long) session and
 * time out. When we detect that context we spawn the agent detached, print a
 * tutorial, and return immediately so the parent stays responsive.
 *
 * The context is: we are NESTED inside another agent (`AGENT_YES_PID` is injected
 * into an agent's environment by its wrapper — a human shell never has it) AND
 * stdout is not a TTY (captured/piped, e.g. a tool's Bash). A human piping output
 * (`ay claude | cat`) has no `AGENT_YES_PID`, so they still block as before.
 * `attach` (the `--attach` flag or `AGENT_YES_ATTACH=1`) forces foreground.
 */
export function shouldForkNested(opts: {
  isTTY: boolean;
  ayPid: string | undefined;
  attach: boolean;
}): boolean {
  if (opts.attach) return false;
  if (opts.isTTY) return false;
  return Boolean(opts.ayPid && opts.ayPid.trim());
}

/** The tutorial printed to the parent agent after a detached spawn, telling it
 *  exactly how to drive the agent it just started. */
export function buildSpawnTutorial(cli: string, pid: number): string {
  return [
    `Spawned ${cli} agent as pid ${pid} (detached — this shell returned immediately).`,
    `It runs in the background; drive it with:`,
    `  ay tail ${pid}          # watch its output (live)`,
    `  ay send ${pid} "..."    # send it a message / instruction`,
    `  ay send ${pid} /compact # send a slash command`,
    `  ay ls                   # list running agents`,
    `  ay result get ${pid}    # read its final result when done`,
    `  ay exit ${pid}          # stop it`,
  ].join("\n");
}

/**
 * Poll the global pid registry (`~/.agent-yes/pids.jsonl`) for `pid` to become
 * resolvable — the actual contract `ay tail`/`ay send` depend on (both resolve
 * through `readGlobalPids()`), not a proxy signal. The wrapper creates its
 * stdin FIFO BEFORE writing its pid_store record (see rs/src/main.rs), so
 * polling the FIFO's existence — the previous approach — could report "ready"
 * before the registration it's meant to confirm had even happened.
 *
 * A record with `status: "exited"` doesn't count: the agent registered and
 * then immediately died, so it's no more "addressable" than never registering.
 * Resolves true once a live record for this pid appears, false on timeout or
 * if `aborted()` reports the child already died (so a startup failure fails
 * fast instead of waiting out the whole window).
 */
export async function waitForRegistration(
  pid: number,
  timeoutMs = 5000,
  aborted?: () => boolean,
): Promise<boolean> {
  const { readGlobalPids } = await import("./globalPidIndex.ts");
  const isRegistered = async () =>
    (await readGlobalPids()).some((r) => r.pid === pid && r.status !== "exited");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted?.()) return false;
    if (await isRegistered()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return isRegistered();
}

/** Predicted per-agent raw log path — deterministic from cwd + pid (see
 *  rs/src/log_files.rs's `project_log_dir`), so it's known even when the
 *  agent never registered. */
export function predictedLogPath(cwd: string, pid: number): string {
  return path.join(cwd, ".agent-yes", `${pid}.raw.log`);
}
