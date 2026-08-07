import { existsSync } from "fs";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

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
    ``,
    // Both halves of the contract, so the parent picks deliberately instead of
    // defaulting to the bad option (babysitting `ay tail`, which re-blocks the
    // very shell this detached spawn just freed).
    //
    // If your harness HAS a monitor loop, watching is strictly better: you get
    // working/idle/needs_input transitions at your own cadence, with no message
    // landing in your composer. The wrapper's push exists for the parent that
    // ISN'T watching — and it steps aside automatically when you are (see
    // ts/parentWatching.ts), so listing both here doesn't create duplicates.
    `Two ways to keep up with it — use whichever fits your harness:`,
    `  Monitor (preferred if you have a monitor/polling loop):`,
    `    ay ls --watch --json          # NDJSON stream of state changes across agents`,
    `    ay status ${pid}                 # one-shot: working | idle | needs_input | stopped`,
    `    ay status ${pid} --wait-idle     # block until it's done (add --timeout=Ns)`,
    `  Or do nothing: it was told to report back to you, and its wrapper will`,
    `  message you if it finishes, gets stuck, or exits without reporting — the`,
    `  report arrives in your own input as an <ay-report …> block. That fallback`,
    `  stays quiet while you are actively watching, so the two don't duplicate.`,
  ].join("\n");
}

/**
 * Poll for the spawned wrapper's stdin FIFO to appear, so the tutorial's
 * `ay send`/`ay tail` work the instant we print them (the wrapper registers its
 * FIFO a moment after spawn). Resolves true once registered, false on timeout or
 * if `aborted()` reports the child already died (so a startup failure fails fast
 * instead of waiting out the whole window).
 */
export async function waitForFifo(
  pid: number,
  timeoutMs = 2000,
  aborted?: () => boolean,
): Promise<boolean> {
  const fifo = path.join(agentYesHome(), "fifo", `${pid}.stdin`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted?.()) return false;
    if (existsSync(fifo)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(fifo);
}
