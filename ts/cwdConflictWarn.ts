/**
 * Pre-launch warning: another live agent is already working in THIS exact
 * directory. Two agents sharing one working tree clobber each other's edits,
 * builds, and dev-server ports — so we warn (stderr, non-fatal) and hand the
 * user a copy-pasteable git-worktree isolation command.
 *
 * Lives in cli.ts's launch path (before the --rust dispatch) so it covers BOTH
 * the Rust and TypeScript runtimes with one check. The launching agent isn't
 * registered in the pid index yet, so every same-cwd match here is a genuine
 * pre-existing peer, never itself.
 */
import path from "path";
import { readGlobalPids, type GlobalPidRecord } from "./globalPidIndex.ts";

/** A pre-existing peer for the warning: just what we render. */
export interface CwdOccupant {
  pid: number;
  cli: string;
}

/** The vendor behind a cli name: claude/cy/claude-yes -> claude, codex-* -> codex. */
export function vendorOf(cli: string): string {
  const c = cli.toLowerCase().replace(/-yes$/, "");
  if (c === "cy" || c.startsWith("claude")) return "claude";
  if (c.startsWith("codex")) return "codex";
  return c;
}

/** The cli this launch starts: a `<cli>-yes` entry name, else the first non-flag argument. */
export function launchingCli(rawArgv: string[]): string | null {
  const bin = path.basename(rawArgv[1] ?? "").replace(/\.(c?js|ts)$/, "");
  if (bin.endsWith("-yes") && bin !== "agent-yes") return bin.replace(/-yes$/, "");
  return rawArgv.slice(2).find((a) => !a.startsWith("-")) ?? null;
}

/**
 * POSIX single-quote a shell token so a copy-pasted recovery command survives
 * spaces, quotes, `$`, `;`, `&`, etc. Safe-charset tokens pass through unquoted
 * so the common case (`ay claude -- fix`) stays readable. Empty string → `''`.
 */
export function shQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9,._+@%/:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pure renderer — given the peers already in `cwd`, the cwd, and the original
 * `ay …` command, produce the warning text (or null when there's no conflict).
 * Separated from IO so the message/branching is unit-tested without a live index.
 */
export function formatCwdConflictWarning(
  occupants: CwdOccupant[],
  cwd: string,
  origCmd: string,
  launching: string | null = null,
): string | null {
  if (occupants.length === 0) return null;
  // Different vendors in one cwd (say claude + codex) that know about each other
  // are fine, even good: only same-vendor duplicates get the strong warning.
  const same = launching
    ? occupants.filter((r) => vendorOf(r.cli) === vendorOf(launching))
    : occupants;
  if (launching && same.length === 0) {
    const names = occupants
      .slice(0, 3)
      .map((r) => `${r.cli} ${r.pid}`)
      .join(", ");
    return (
      `\nℹ  ${names} ${occupants.length > 1 ? "are" : "is"} already running in this directory (${cwd}), from a different vendor than ${launching}.\n` +
      `   That is fine if they are aware of each other (\`ay ls --cwd .\`, \`ay send <pid> "…"\`). Are they? Otherwise\n` +
      `   they share one checkout, builds and ports without knowing it. (AGENT_YES_NO_CWD_WARN=1 silences this)\n\n`
    );
  }
  occupants = same;
  // Worktree name doubles as the new dir AND the new branch. `git worktree add`
  // (not `git clone .`) is the correct primitive: it resolves the repo root even
  // from a subdir, shares the object store, and creates the branch in one step.
  const wt = `${path.basename(cwd) || "agent"}-work`;
  const list = occupants
    .slice(0, 3)
    .map((r) => `      ${r.pid}  ${r.cli}`)
    .join("\n");
  const more = occupants.length > 3 ? `\n      …and ${occupants.length - 3} more` : "";
  const cmd = origCmd.trim() || "ay <cli> …";
  const branch = shQuote(wt);
  const dir = shQuote(`../${wt}`);
  return (
    `\n⚠⚠⚠  STRONGLY NOT RECOMMENDED: ${occupants.length} agent${occupants.length > 1 ? "s are" : " is"} already running in this directory (${cwd}):\n` +
    `${list}${more}\n` +
    `   Two top-level agents in one working tree share one checkout, one set of builds and\n` +
    `   one set of live services and ports, and neither knows what the other is doing.\n` +
    `   Do one of these instead (cancel with Ctrl-C):\n` +
    `    1. Parallel work in THIS directory: use in-harness subagents inside the existing\n` +
    `       agent (e.g. Claude's Agent tool), not a second \`ay\`. Subagents are not counted here.\n` +
    `    2. Parallel work on another branch: start it in its OWN directory (a git worktree)\n` +
    `       and let the main branch harvest that work by git (merge or PR):\n` +
    `         git worktree add -b ${branch} ${dir} && cd ${dir} && ${cmd}\n` +
    `   (set AGENT_YES_NO_CWD_WARN=1 to silence)\n\n`
  );
}

/**
 * IO wrapper: discover live same-cwd peers and print the warning to stderr.
 * Best-effort and swallow-all — a discovery hiccup must NEVER block a launch.
 * No-op when AGENT_YES_NO_CWD_WARN=1.
 */
export async function warnIfCwdOccupied(rawArgv: string[]): Promise<void> {
  if (process.env.AGENT_YES_NO_CWD_WARN === "1") return;
  try {
    const here = path.resolve(process.cwd());
    const occupants: CwdOccupant[] = (await readGlobalPids({ liveOnly: true }))
      .filter((r: GlobalPidRecord) => path.resolve(r.cwd) === here)
      .map((r) => ({ pid: r.pid, cli: r.cli }));
    // Shell-quote each argv token so the suggested command reproduces the
    // original launch even with spaces/quotes in a prompt (e.g. a multi-word
    // `-- "fix the bug"`). We can't recover the user's exact original quoting
    // from argv, but per-token quoting is copy-paste-correct.
    const origCmd = ["ay", ...rawArgv.slice(2)].map(shQuote).join(" ");
    const msg = formatCwdConflictWarning(occupants, here, origCmd, launchingCli(rawArgv));
    if (msg) {
      process.stderr.write(msg);
      // Interactive CLIs (claude/codex) switch to the alternate screen
      // buffer on startup, which clears the terminal — the warning would flash
      // and vanish before a human could read it. Hold briefly (only on a real
      // conflict, only when attached to a TTY) so they get a beat to Ctrl-C and
      // switch to a worktree. Non-TTY / detached launches skip the pause.
      if (process.stdout.isTTY) {
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  } catch {
    // Non-fatal — never block launching the agent over a warning.
  }
}
