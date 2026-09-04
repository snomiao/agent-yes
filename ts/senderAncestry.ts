/**
 * Who is calling `ay send`, established by OBSERVING the caller rather than by
 * asking it.
 *
 * `resolveSender()` reads `AGENT_YES_PID`, which the `ay` wrapper injects. That
 * covers a lane launched through the wrapper and nothing else. A session that
 * shells out to `ay send` WITHOUT that env — an SDK / `claude -p` pass, a
 * cron-driven script, anything re-exec'd through a shell that scrubbed the
 * environment — was recorded with `from: null`, i.e. indistinguishable from an
 * anonymous stranger.
 *
 * That is not a cosmetic mislabel. Receiving lanes refuse messages they cannot
 * attribute, which is correct doctrine; so an honest sender whose env happened
 * to be missing had its traffic dropped as untrustworthy, and two lanes spent
 * hours on an intrusion theory that was false.
 *
 * The env var is a CLAIM the caller passes along. The process tree is a FACT
 * the kernel keeps and the caller cannot forge from inside a message body: a
 * process cannot choose its own ancestors. So when the claim is absent, walk up
 * from our own pid and stop at the first ancestor that is a REGISTERED agent.
 * A lane's `ay send`, however many shells deep, is a descendant of that lane.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It never invents a sender. No ancestor registered ⇒ nothing is attributed,
 *    and the caller is described by what was measured about it (user, host,
 *    cwd, pid) rather than guessed. Filling the field with a plausible name is
 *    the failure one level worse than the one this fixes.
 *  - It never lets the BODY supply identity. Everything here comes from the
 *    kernel and the registry.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** How a sender attribution was established, weakest last. */
export type SenderVia =
  /** `AGENT_YES_PID` named a registered agent AND that agent is a real ancestor
   * of this process — the claim and the kernel agree. */
  | "env"
  /** No env, but an ancestor process is a registered agent. Not forgeable from
   * inside a message: a process cannot choose its own ancestors. */
  | "ancestry"
  /** `AGENT_YES_PID` named one registered agent while a DIFFERENT registered
   * agent is this process's actual ancestor. The two disagree, and the tree is
   * the half that cannot be forged — so this is evidence, and the only value
   * that says so out loud. */
  | "env-uncorroborated"
  /** `AGENT_YES_PID` named a registered agent and the process tree contains no
   * registered agent at all — so there is nothing to agree or disagree with.
   *
   * This is NOT evidence of anything. A detached helper, a process re-parented
   * to init, an `ay send` from a background job, or an unreadable process table
   * all land here, and every one of them is honest. Distinguishing it from a
   * real contradiction is the whole point: the first live firing of the loud
   * marker was a legitimate long-lived lane, and a warning that fires on honest
   * traffic is one people learn to skip — which destroys the signal for the
   * case it was built for. Unknown has to stay expressible AS unknown. */
  | "env-unverified"
  /** Nothing identified the caller; only its observable facts are recorded. */
  | "observed";

/** One row of the process table: who its parent is, and how long it has run. */
export interface ProcRow {
  ppid: number;
  /** Seconds since the process started, from `ps -o etime=`. */
  ageSecs: number;
}

/**
 * Ancestor pids of `pid`, nearest first, via `ps`.
 *
 * `ps` rather than `/proc` so it works on macOS as well as Linux — this repo's
 * other walker is `/proc`-only and the fleet is mostly macOS. ONE invocation
 * for the whole table: a call per hop would multiply the cost of every send by
 * the depth of the tree. Measured at ~40ms for 887 processes.
 *
 * Best-effort by construction. A failure here means "could not establish",
 * which is a legitimate answer — never an error that blocks a send.
 */
export async function ancestorPids(
  pid: number,
  opts: { maxHops?: number; readTable?: () => Promise<Map<number, ProcRow>> } = {},
): Promise<number[]> {
  const maxHops = opts.maxHops ?? 32;
  let table: Map<number, ProcRow>;
  try {
    table = await (opts.readTable ?? readProcessTable)();
  } catch {
    return [];
  }
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = pid;
  // Bounded and cycle-guarded: pid reuse can make a table that loops, and a
  // spin here would hang every send on the host.
  for (let hops = 0; hops < maxHops; hops++) {
    const parent = table.get(cur)?.ppid;
    if (parent === undefined || parent <= 1 || seen.has(parent)) break;
    out.push(parent);
    seen.add(parent);
    cur = parent;
  }
  return out;
}

/**
 * pid → {ppid, ageSecs} for every visible process, from one `ps`.
 *
 * `etime` (elapsed) rather than `lstart` because it is POSIX and identically
 * available on macOS and Linux, where `etimes` is Linux-only. Windows has no
 * `ps` at all — the caller must not spawn one there; see {@link readProcessTable}.
 */
async function readProcessTable(): Promise<Map<number, ProcRow>> {
  if (process.platform === "win32") {
    // No `ps`. Spawning one would cost a failed exec on every send just to
    // reach the same "could not establish" answer.
    throw new Error("no process table reader on win32");
  }
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,etime="], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseProcessTable(stdout);
}

/**
 * Seconds from a POSIX `etime` field: `[[DD-]hh:]mm:ss`.
 *
 * Returns null for anything that does not match, so a `ps` variant printing an
 * unexpected shape degrades to "cannot check" rather than to a wrong number —
 * a bogus age would defeat the pid-reuse guard it exists to feed.
 */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return Number(dd ?? 0) * 86400 + Number(hh ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

/**
 * Parse `ps -A -o pid=,ppid=,etime=` output. Split out from the read so the
 * parsing — the part that can actually be wrong — is testable without a `ps`.
 */
export function parseProcessTable(stdout: string): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const ageSecs = parseEtime(m[3]!);
    if (ageSecs === null) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), ageSecs });
  }
  return table;
}

/**
 * Is the process now at `pid` plausibly the one that registered as this agent?
 *
 * pids are reused. When a registered agent exits and the OS hands its number to
 * something else, matching on the number alone attributes the new process to
 * the dead agent — and, worse, to anything that arranges to be its child. The
 * registry records when the agent started, so compare: a process that began
 * AFTER the registration cannot be the thing that was registered.
 *
 * `toleranceSecs` absorbs the ordinary gap between a process starting and its
 * record being written, plus clock granularity. Unknown age ⇒ null ⇒ the caller
 * declines to attribute, because an unverifiable identity is the case this
 * whole change exists to stop papering over.
 */
export function ageMatchesRegistration(
  ageSecs: number | undefined,
  startedAt: number | undefined,
  now = Date.now(),
  toleranceSecs = 60,
): boolean {
  if (ageSecs === undefined || startedAt === undefined) return false;
  const registeredAgoSecs = (now - startedAt) / 1000;
  return ageSecs >= registeredAgoSecs - toleranceSecs;
}

/**
 * The first ancestor of `pid` that `isAgent` recognizes, or null.
 *
 * Nearest-first: with nested agents, the closest enclosing lane is the one that
 * actually made this call, so it is the honest attribution.
 */
export async function findAgentAncestor<T>(
  pid: number,
  isAgent: (pid: number) => T | null,
  opts?: { maxHops?: number; readTable?: () => Promise<Map<number, ProcRow>> },
): Promise<T | null> {
  for (const ancestor of await ancestorPids(pid, opts)) {
    const hit = isAgent(ancestor);
    if (hit) return hit;
  }
  return null;
}

/**
 * The process table, read once, or null when it cannot be read.
 *
 * Exposed so a caller can do the ancestry walk AND the pid-reuse age check off
 * a single `ps`, instead of paying for the spawn twice.
 */
export async function readAncestryTable(
  read: () => Promise<Map<number, ProcRow>> = readProcessTable,
): Promise<Map<number, ProcRow> | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}
