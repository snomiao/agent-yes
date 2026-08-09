/**
 * `ay ps` — what each agent COSTS, rolled up per process tree.
 *
 * The split from `ay ls`: `ls` answers "what is running and what is it doing"
 * (prompt, git, badges, forest); `ps` answers "what is this box spending on
 * each agent, and is any of it safe to reclaim". Same rows, different question.
 *
 * `ps` used to be a plain alias for `ls`. It is now its own command, because the
 * number you actually want is not in any `ps`/`htop` output: one agent is a
 * whole subtree of wrapper + CLI + pty hosts + subagents, and only ay knows
 * which pids collapse into which session.
 *
 * Deliberately local-only. Resource numbers are per-machine and there is nothing
 * meaningful to sum across remotes; `ay ls` remains the fleet-wide view.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import yargs from "yargs";
import { buildAgentForest, flattenForest } from "./agentTree.ts";
import {
  humanBytes,
  sampleTrees,
  snapshotProcs,
  systemStats,
  type SystemStats,
  type TreeStats,
} from "./procStats.ts";
import { deriveLiveState, listRecords } from "./subcommands.ts";

/** Default CPU sampling window. Long enough to be meaningful, short enough to feel instant. */
const DEFAULT_WINDOW_MS = 1000;

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Trailing path segment that identifies a worktree — `/code/x/foo/tree/main` → `foo`. */
export function repoLabel(cwd: string): string {
  // Split on BOTH separators, not `path.sep`. Agent cwds come off the registry,
  // which stores whatever the wrapper recorded — a posix path is perfectly
  // normal on a Windows host (msys/WSL shells, or a record synced from another
  // box). Keying on path.sep left the whole path unsplit there, so the REPO
  // column printed the full path instead of the repo name.
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const treeAt = parts.lastIndexOf("tree");
  // The repo's own name is more useful than the branch dir every checkout shares.
  if (treeAt > 0) return parts[treeAt - 1] as string;
  return parts[parts.length - 1] ?? shortenPath(cwd);
}

/** `15.23 12.52 9.86 (8 cpu, 1.9x)  mem 13.0/15Gi  swap 4.8/4.8Gi FULL  zombies 1440` */
export function formatSystemLine(sys: SystemStats): string {
  const bits: string[] = [];
  if (sys.load) {
    const [one, five, fifteen] = sys.load;
    const ratio = one / Math.max(1, sys.ncpu);
    // Flag oversubscription explicitly — "15.23" means nothing without the core
    // count beside it, and that ratio is the whole point of the number.
    bits.push(
      `load ${one.toFixed(2)} ${five.toFixed(2)} ${fifteen.toFixed(2)} ` +
        `(${sys.ncpu} cpu, ${ratio.toFixed(1)}x)`,
    );
  }
  if (sys.memTotalBytes !== null) {
    const used = sys.memAvailableBytes !== null ? sys.memTotalBytes - sys.memAvailableBytes : null;
    bits.push(`mem ${humanBytes(used)}/${humanBytes(sys.memTotalBytes)}`);
  }
  if (sys.swapTotalBytes !== null && sys.swapTotalBytes > 0) {
    const usedSwap = sys.swapFreeBytes !== null ? sys.swapTotalBytes - sys.swapFreeBytes : null;
    // A full swap is the difference between "loaded" and "one allocation away
    // from the OOM killer", so it gets a word rather than just a ratio.
    const full = sys.swapFreeBytes !== null && sys.swapFreeBytes <= 0 ? " FULL" : "";
    bits.push(`swap ${humanBytes(usedSwap)}/${humanBytes(sys.swapTotalBytes)}${full}`);
  }
  if (sys.zombies > 0) bits.push(`zombies ${sys.zombies}`);
  return bits.join("   ");
}

export interface PsRow {
  pid: number;
  cli: string;
  status: string;
  cwd: string;
  repo: string;
  stats: TreeStats;
  self: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function renderTable(rows: PsRow[], unattributed: TreeStats | null): string {
  const cells = rows.map((r) => ({
    pid: String(r.pid),
    cli: r.cli,
    status: r.status,
    cpu: r.stats.cpuPercent.toFixed(1),
    rss: humanBytes(r.stats.rss),
    procs: String(r.stats.procs),
    repo: r.repo,
    self: r.self,
  }));
  // The unmanaged row participates in the width pass — "unmanaged" is wider than
  // any real CLI name, so sizing without it knocks the whole table out of line.
  if (unattributed && unattributed.procs > 0) {
    cells.push({
      pid: "-",
      cli: "unmanaged",
      status: "-",
      cpu: unattributed.cpuPercent.toFixed(1),
      rss: humanBytes(unattributed.rss),
      procs: String(unattributed.procs),
      repo: "-",
      self: false,
    });
  }
  const w = {
    pid: Math.max(3, ...cells.map((c) => c.pid.length)),
    cli: Math.max(3, ...cells.map((c) => c.cli.length)),
    status: Math.max(6, ...cells.map((c) => c.status.length)),
    cpu: Math.max(5, ...cells.map((c) => c.cpu.length)),
    rss: Math.max(5, ...cells.map((c) => c.rss.length)),
    procs: Math.max(5, ...cells.map((c) => c.procs.length)),
    repo: Math.max(4, ...cells.map((c) => c.repo.length)),
  };
  const line = (
    pid: string,
    cli: string,
    status: string,
    cpu: string,
    rss: string,
    procs: string,
    repo: string,
    tail = "",
  ) =>
    `${pad(pid, w.pid)}  ${pad(cli, w.cli)}  ${pad(status, w.status)}  ` +
    `${padStart(cpu, w.cpu)}  ${padStart(rss, w.rss)}  ${padStart(procs, w.procs)}  ` +
    `${pad(repo, w.repo)}${tail}`;

  const out: string[] = [line("PID", "CLI", "STATUS", "CPU%", "RSS", "PROCS", "REPO")];
  for (const c of cells) {
    out.push(
      line(c.pid, c.cli, c.status, c.cpu, c.rss, c.procs, c.repo, c.self ? "  ← this session" : ""),
    );
  }
  return out.join("\n");
}

export async function cmdPs(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage(
      "Usage: ay ps [keyword] [options]\n\n" +
        "Per-agent resource usage, rolled up across each agent's whole process tree\n" +
        "(wrapper + CLI + pty hosts + subagents). Local-only; use `ay ls` for the\n" +
        "fleet view and per-agent prompts.",
    )
    .option("all", {
      type: "boolean",
      default: false,
      description: "Include exited agents",
    })
    .option("json", { type: "boolean", default: false, description: "Output as JSON" })
    .option("sort", {
      type: "string",
      choices: ["rss", "cpu", "procs", "pid"],
      default: "rss",
      description: "Sort rows by resource usage (default: rss, biggest first)",
    })
    .option("tree", {
      type: "boolean",
      default: false,
      description: "Keep ay ls's parent>child forest order instead of sorting",
    })
    .option("interval", {
      type: "number",
      default: DEFAULT_WINDOW_MS / 1000,
      description: "CPU sampling window in seconds — CPU% is a live delta, not a lifetime average",
    })
    .option("cwd", { type: "string", description: "Restrict to agents whose cwd starts with dir" })
    .option("help", { alias: "h", type: "boolean", default: false, description: "Show this help" })
    .example("ay ps", "biggest agents first, with box vitals")
    .example("ay ps --sort cpu", "who is actually burning CPU right now")
    .example("ay ps --json", "machine-readable rollup")
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  if (argv.help || argv.h) {
    process.stdout.write((await y.getHelp()) + "\n");
    return 0;
  }

  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const records = await listRecords(keyword, {
    all: argv.all,
    active: false,
    json: false,
    latest: false,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  });

  if (records.length === 0) {
    process.stderr.write(keyword ? `no agents matched "${keyword}"\n` : "no running agents\n");
    return 0;
  }

  // `flattenForest` yields parents before children; sampleTrees attributes
  // first-come, so sampling in that order would let a parent absorb a nested
  // agent's whole subtree and render the child as a bogus 0-proc row. Reverse to
  // claim deepest-first, then display in forest order.
  const ordered = flattenForest(buildAgentForest(records)).map((r) => r.record);
  const windowMs = Math.max(100, (Number.isFinite(argv.interval) ? argv.interval : 1) * 1000);
  const { trees, unattributed } = await sampleTrees(
    [...ordered].reverse().map((r) => r.pid),
    { windowMs },
  );

  const states = new Map(
    await Promise.all(ordered.map(async (r) => [r.pid, (await deriveLiveState(r)).state] as const)),
  );
  const selfPid = process.pid;
  const rows: PsRow[] = ordered.map((r) => ({
    pid: r.pid,
    cli: r.cli,
    status: states.get(r.pid) ?? r.status,
    cwd: r.cwd,
    repo: repoLabel(r.cwd),
    stats: trees.get(r.pid) ?? { pid: r.pid, rss: 0, cpuPercent: 0, procs: 0 },
    // Mark the tree we are standing in — anything that later grows a kill
    // affordance must not let you shoot the session issuing the command.
    self: trees.get(r.pid) !== undefined && isSelfTree(r.pid, selfPid),
  }));

  if (!argv.tree) {
    const key = String(argv.sort);
    rows.sort((a, b) => {
      if (key === "cpu") return b.stats.cpuPercent - a.stats.cpuPercent;
      if (key === "procs") return b.stats.procs - a.stats.procs;
      if (key === "pid") return a.pid - b.pid;
      return b.stats.rss - a.stats.rss;
    });
  }

  const sys = await systemStats(await snapshotProcs());

  if (argv.json) {
    process.stdout.write(
      JSON.stringify(
        {
          system: sys,
          agents: rows.map((r) => ({
            pid: r.pid,
            cli: r.cli,
            status: r.status,
            cwd: r.cwd,
            rssBytes: r.stats.rss,
            cpuPercent: Number(r.stats.cpuPercent.toFixed(2)),
            procs: r.stats.procs,
            self: r.self,
          })),
          unattributed: {
            rssBytes: unattributed.rss,
            cpuPercent: Number(unattributed.cpuPercent.toFixed(2)),
            procs: unattributed.procs,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const header = formatSystemLine(sys);
  if (header) process.stdout.write(` ${header}\n\n`);
  process.stdout.write(renderTable(rows, unattributed) + "\n");
  return 0;
}

/**
 * Is `rootPid` the wrapper of the tree this very process lives in?
 *
 * Walks our own ancestry rather than the snapshot: cheap, and correct even when
 * the snapshot raced. Linux-only detail (reads /proc), returns false elsewhere —
 * mislabelling the self row is cosmetic.
 */
export function isSelfTree(
  rootPid: number,
  selfPid: number,
  // Injectable so the ancestry walk itself is testable off Linux — the real
  // reader is /proc-only, but the hop/cycle logic is platform-independent and
  // is the part that can actually be wrong.
  readPpid: (pid: number) => number | null = readPpidSync,
  platform: string = process.platform,
): boolean {
  if (platform !== "linux") return false;
  let pid = selfPid;
  // Bounded: a /proc that reports a cycle (or a pid1 that is its own parent)
  // must not spin here.
  for (let hops = 0; hops < 64 && pid > 1; hops++) {
    if (pid === rootPid) return true;
    const ppid = readPpid(pid);
    if (ppid === null) return false;
    pid = ppid;
  }
  return false;
}

export function readPpidSync(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const ppid = Number(
      stat
        .slice(close + 1)
        .trim()
        .split(/\s+/)[1],
    );
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}
