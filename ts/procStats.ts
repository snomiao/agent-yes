/**
 * Per-process-TREE resource rollup, for `ay ps`.
 *
 * Why this exists: `ay ls` lists WRAPPER pids, but a single ay-managed agent is
 * a whole subtree — the wrapper, the CLI, its version process, `bg-pty-host`,
 * `bg-spare`, the daemon, plus whatever the agent itself spawned. On a busy box
 * one session can be 30+ processes. `ps`/`htop`/`glances` see those as
 * unrelated rows and cannot attribute them to an agent; only ay knows the
 * wrapper pids, so only ay can roll the cost up to "this session costs 612 MiB".
 *
 * Two things here are deliberately NOT the obvious approach:
 *
 * 1. CPU is a SAMPLED DELTA, never `ps`'s lifetime average. A session alive for
 *    7 days shows a meaningless smeared percentage; "is this agent busy right
 *    now" needs two reads of the cumulative counter a moment apart. That's why
 *    the caller must await a sampling window — see `sampleTrees`.
 *
 * 2. Rollup walks the FULL descendant closure, not direct children. Agents spawn
 *    subagents that spawn shells; a depth-1 sum undercounts badly.
 *
 * BEST-EFFORT by contract, like `procStartTime.ts`: every reader returns null /
 * empty when it cannot answer (no /proc, unreadable pid, a process that exited
 * mid-sample). Callers render "-" rather than failing — this is an inspection
 * command, it must never be the thing that breaks.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One process, as sampled. `cpuSeconds` is CUMULATIVE since its start. */
export interface ProcSample {
  pid: number;
  ppid: number;
  /** Resident set size in bytes. */
  rss: number;
  /** Cumulative CPU (user+sys) in seconds since process start. */
  cpuSeconds: number;
  /** Single-letter state: R, S, D, Z, T… */
  state: string;
  /**
   * Opaque "when did this pid start" token, for detecting pid REUSE between the
   * two samples. Empty when unknowable (the non-Linux `ps` fallback), which
   * callers must read as "no opinion", never as a mismatch.
   */
  startToken: string;
}

/**
 * USER_HZ. The kernel reports utime/stime in clock ticks, and this is 100 on
 * every Linux ABI we run on — it is fixed at the syscall boundary, NOT the
 * configurable CONFIG_HZ. There is no cheap way to query it from Node.
 */
const USER_HZ = 100;

/** Assumed page size when we cannot measure the real one. */
const DEFAULT_PAGE_SIZE = 4096;

/**
 * Real page size for the `rss` field of /proc/<pid>/stat, which is in PAGES.
 *
 * Hardcoding 4 KiB under-reports by 4× on a 16 KiB-page arm64 kernel, so measure
 * it instead — for free, with no `getconf` spawn: /proc/self/status reports our
 * own VmRSS in kB while /proc/self/stat reports the same figure in pages, and
 * the ratio is the page size. Snapped to the nearest supported power of two
 * because VmRSS is kB-rounded. Measured once per process, then cached.
 */
let cachedPageSize: number | null = null;

export function derivePageSize(statLine: string, statusText: string): number {
  const close = statLine.lastIndexOf(")");
  if (close < 0) return DEFAULT_PAGE_SIZE;
  const pages = Number(
    statLine
      .slice(close + 1)
      .trim()
      .split(/\s+/)[21],
  );
  const kb = Number(/^VmRSS:\s+(\d+)/m.exec(statusText)?.[1]);
  if (!Number.isFinite(pages) || !Number.isFinite(kb) || pages <= 0 || kb <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  const raw = (kb * 1024) / pages;
  let best = DEFAULT_PAGE_SIZE;
  for (const candidate of [4096, 8192, 16384, 65536]) {
    if (Math.abs(raw - candidate) < Math.abs(raw - best)) best = candidate;
  }
  return best;
}

async function pageSize(deps?: ProcReaders): Promise<number> {
  if (cachedPageSize !== null) return cachedPageSize;
  const readSys = deps?.readSys ?? defaultReadSys;
  const [stat, status] = await Promise.all([readSys("self/stat"), readSys("self/status")]);
  cachedPageSize = stat && status ? derivePageSize(stat, status) : DEFAULT_PAGE_SIZE;
  return cachedPageSize;
}

/**
 * Parse the fields of a /proc/<pid>/stat line that we need.
 *
 * As in `parseLinuxStartTime`, the parse MUST start after the last `)`: field 2
 * is the comm and may contain spaces and parens, so naive splitting mis-indexes
 * everything after it. Post-`)` fields begin at field 3, so field N is at index
 * N-3: state=3→0, ppid=4→1, utime=14→11, stime=15→12, starttime=22→19, rss=24→21.
 */
export function parseProcStat(
  pid: number,
  stat: string,
  pageSizeBytes: number = DEFAULT_PAGE_SIZE,
): ProcSample | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = f[0];
  const ppid = Number(f[1]);
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  const rssPages = Number(f[21]);
  if (!state || !Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) {
    return null;
  }
  return {
    pid,
    ppid,
    rss: Number.isFinite(rssPages) ? rssPages * pageSizeBytes : 0,
    cpuSeconds: (utime + stime) / USER_HZ,
    state,
    startToken: f[19] ?? "",
  };
}

/** Injection seam so specs can drive every path without a real /proc. */
export interface ProcReaders {
  platform?: string;
  /** Numeric pid entries of /proc. */
  listPids?: () => Promise<number[]>;
  /** Contents of /proc/<pid>/stat, or null when gone. */
  readStat?: (pid: number) => Promise<string | null>;
  /** Whole-file read of /proc/loadavg, /proc/meminfo, … or null. */
  readSys?: (name: string) => Promise<string | null>;
  /** `ps -eo pid=,ppid=,rss=,time=,state=` output, for the non-Linux fallback. */
  readPsTable?: () => Promise<string | null>;
}

export async function defaultListPids(): Promise<number[]> {
  try {
    const entries = await readdir("/proc");
    const out: number[] = [];
    for (const e of entries) {
      // /proc holds plenty of non-pid entries (self, meminfo, sys…); the
      // all-digits test is the standard way to pick out the processes.
      if (/^\d+$/.test(e)) out.push(Number(e));
    }
    return out;
  } catch {
    return [];
  }
}

export async function defaultReadStat(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    // Racing a process that exited between readdir and read is NORMAL on a busy
    // box, not an error worth surfacing.
    return null;
  }
}

export async function defaultReadSys(name: string): Promise<string | null> {
  try {
    return await readFile(`/proc/${name}`, "utf8");
  } catch {
    return null;
  }
}

export async function defaultReadPsTable(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,time=,state="], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Parse `[[dd-]hh:]mm:ss` (ps `time=`) into seconds. */
export function parsePsTime(raw: string): number {
  const [dayPart, clockPart] = raw.includes("-") ? raw.split("-", 2) : [null, raw];
  const parts = (clockPart ?? "").split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  if (dayPart !== null) {
    const days = Number(dayPart);
    if (Number.isFinite(days)) seconds += days * 86400;
  }
  return seconds;
}

/** Parse the `ps -eo pid=,ppid=,rss=,time=,state=` fallback table. */
export function parsePsTable(out: string): Map<number, ProcSample> {
  const procs = new Map<number, ProcSample>();
  for (const line of out.split("\n")) {
    const m = line.trim().split(/\s+/);
    if (m.length < 5) continue;
    const [pidS, ppidS, rssS, timeS, state] = m;
    const pid = Number(pidS);
    const ppid = Number(ppidS);
    const rssKib = Number(rssS);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    procs.set(pid, {
      pid,
      ppid,
      // ps reports RSS in KiB; /proc gives bytes. Normalize to bytes so both
      // backends feed identical numbers into the rollup.
      rss: Number.isFinite(rssKib) ? rssKib * 1024 : 0,
      cpuSeconds: parsePsTime(timeS ?? ""),
      state: state ?? "?",
      // No start token from this table: `ps -o lstart=` contains spaces and
      // would break the column split, and `etimes` changes between samples so
      // it cannot serve as a stable identity. The pid-reuse guard is therefore
      // Linux-only; elsewhere we fall back to matching on pid alone.
      startToken: "",
    });
  }
  return procs;
}

/** One snapshot of every visible process, keyed by pid. */
export async function snapshotProcs(deps?: ProcReaders): Promise<Map<number, ProcSample>> {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "linux" && !deps?.listPids) {
    const table = await (deps?.readPsTable ?? defaultReadPsTable)();
    return table ? parsePsTable(table) : new Map();
  }
  const pids = await (deps?.listPids ?? defaultListPids)();
  const readStat = deps?.readStat ?? defaultReadStat;
  const bytesPerPage = await pageSize(deps);
  const procs = new Map<number, ProcSample>();
  const samples = await Promise.all(
    pids.map(async (pid) => {
      const stat = await readStat(pid);
      return stat ? parseProcStat(pid, stat, bytesPerPage) : null;
    }),
  );
  for (const s of samples) if (s) procs.set(s.pid, s);
  return procs;
}

/** ppid → children index, for descendant walks. */
export function buildChildIndex(procs: Map<number, ProcSample>): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const p of procs.values()) {
    const list = kids.get(p.ppid);
    if (list) list.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }
  return kids;
}

/**
 * Every pid in the subtree rooted at `root`, inclusive.
 *
 * Iterative with a seen-set: a corrupt/racing snapshot can present a parent
 * cycle, and recursion would blow the stack rather than degrade.
 */
export function descendantsOf(
  root: number,
  kids: Map<number, number[]>,
  seen = new Set<number>(),
): Set<number> {
  const out = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (out.has(pid) || seen.has(pid)) continue;
    out.add(pid);
    for (const child of kids.get(pid) ?? []) stack.push(child);
  }
  return out;
}

/** Rolled-up cost of one agent's whole process subtree. */
export interface TreeStats {
  /** The wrapper pid this tree is rooted at. */
  pid: number;
  /** Summed RSS in bytes across the subtree. */
  rss: number;
  /** Percent of ONE core, summed across the subtree (may exceed 100). */
  cpuPercent: number;
  /** Number of live processes in the subtree, inclusive of the root. */
  procs: number;
}

function rollup(
  root: number,
  members: Set<number>,
  first: Map<number, ProcSample>,
  second: Map<number, ProcSample>,
  elapsedSeconds: number,
): TreeStats {
  let rss = 0;
  let cpuDelta = 0;
  let count = 0;
  for (const pid of members) {
    const now = second.get(pid);
    if (!now) continue; // exited during the window
    count++;
    rss += now.rss;
    const before = first.get(pid);
    // Two reasons to skip the delta:
    //
    // - No baseline: the process appeared DURING the window. Counting its full
    //   cumulative CPU would credit a long-lived child's entire history to this
    //   one-second window and spike the row to nonsense, so a newcomer
    //   contributes 0 until the next sample. It under-reports a genuinely new
    //   busy child for one tick, which beats a wildly wrong number.
    //
    // - PID REUSE: the pid is the same but the process behind it is not, so the
    //   two counters belong to unrelated processes and subtracting them is
    //   meaningless. An empty token means "no opinion" (the ps fallback), which
    //   must not be read as a mismatch.
    const reused =
      before !== undefined &&
      before.startToken !== "" &&
      now.startToken !== "" &&
      before.startToken !== now.startToken;
    if (before && !reused) cpuDelta += Math.max(0, now.cpuSeconds - before.cpuSeconds);
  }
  return {
    pid: root,
    rss,
    cpuPercent: elapsedSeconds > 0 ? (cpuDelta / elapsedSeconds) * 100 : 0,
    procs: count,
  };
}

/**
 * Sample every root's subtree over a real time window.
 *
 * Roots are attributed in the order given, and a pid is claimed by the FIRST
 * root that reaches it — so a nested agent whose wrapper is itself listed as a
 * root is never double-counted into its parent's total.
 *
 * Pass DEEPEST-FIRST (children before parents). A nested agent must claim its
 * own subtree before its parent walks through it; parent-first instead makes the
 * parent absorb everything and renders the child as a bogus 0-proc row.
 */
export async function sampleTrees(
  roots: number[],
  opts: { windowMs?: number; deps?: ProcReaders } = {},
): Promise<{ trees: Map<number, TreeStats>; unattributed: TreeStats }> {
  const windowMs = Math.max(100, opts.windowMs ?? 1000);
  // Measure the ACTUAL elapsed time, not the requested window: a loaded box (the
  // exact case this command is for) can oversleep by hundreds of ms, and
  // dividing by the nominal window would over-report every row.
  //
  // MIDPOINT to MIDPOINT, not end-of-first to end-of-second: a snapshot of ~1400
  // processes is not instantaneous, so each pid's counter is read at some moment
  // *inside* each pass. Anchoring on the ends charges the second pass's whole
  // duration to the window while ignoring the first's, which systematically
  // under-reports CPU% by exactly the scan time — worst on the loaded boxes this
  // command exists for. The midpoints are the unbiased estimate of when the
  // average counter was actually read.
  const firstStart = Date.now();
  const first = await snapshotProcs(opts.deps);
  const firstMid = (firstStart + Date.now()) / 2;
  await new Promise((r) => setTimeout(r, windowMs));
  const secondStart = Date.now();
  const second = await snapshotProcs(opts.deps);
  const secondMid = (secondStart + Date.now()) / 2;
  const elapsedSeconds = Math.max(0.001, (secondMid - firstMid) / 1000);

  const kids = buildChildIndex(second);
  const claimed = new Set<number>();
  const trees = new Map<number, TreeStats>();
  for (const root of roots) {
    const members = descendantsOf(root, kids, claimed);
    for (const pid of members) claimed.add(pid);
    trees.set(root, rollup(root, members, first, second, elapsedSeconds));
  }

  // Everything ay does NOT manage, as one row. This is the answer to "is there
  // anything safe to reap?" — without it you cannot tell a fully-accounted-for
  // box from one quietly hoarding orphans.
  const rest = new Set<number>();
  for (const pid of second.keys()) if (!claimed.has(pid)) rest.add(pid);
  return { trees, unattributed: rollup(0, rest, first, second, elapsedSeconds) };
}

/** Whole-box vitals for the header line. */
export interface SystemStats {
  load: [number, number, number] | null;
  ncpu: number;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  zombies: number;
}

/** Parse /proc/meminfo (`MemTotal:  16316360 kB`) into a kB-valued map. */
export function parseMeminfo(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], Number(m[2]) * 1024);
  }
  return out;
}

export async function systemStats(
  procs: Map<number, ProcSample>,
  deps?: ProcReaders,
): Promise<SystemStats> {
  const readSys = deps?.readSys ?? defaultReadSys;
  const [loadRaw, memRaw] = await Promise.all([readSys("loadavg"), readSys("meminfo")]);
  const loadFields = loadRaw?.trim().split(/\s+/) ?? [];
  const load =
    loadFields.length >= 3
      ? ([Number(loadFields[0]), Number(loadFields[1]), Number(loadFields[2])] as [
          number,
          number,
          number,
        ])
      : null;
  const mem = memRaw ? parseMeminfo(memRaw) : new Map<string, number>();
  let zombies = 0;
  for (const p of procs.values()) if (p.state === "Z") zombies++;

  // Off Linux there is no /proc, so the header would otherwise be entirely
  // blank. node:os supplies load and memory on macOS/BSD — no swap breakdown,
  // and loadavg is always [0,0,0] on Windows, so both stay null there.
  const os = await import("node:os");
  const osLoad = os.loadavg();
  const loadFallback =
    process.platform !== "win32" && osLoad.some((n) => n > 0)
      ? ([osLoad[0], osLoad[1], osLoad[2]] as [number, number, number])
      : null;

  return {
    load: load && load.every(Number.isFinite) ? load : loadFallback,
    ncpu: os.cpus().length || 1,
    memTotalBytes: mem.get("MemTotal") ?? os.totalmem() ?? null,
    // MemAvailable is the kernel's own estimate of what a new allocation can
    // actually get; "free" is misleading on any box with a warm page cache — but
    // os.freemem() is the only portable stand-in.
    memAvailableBytes: mem.get("MemAvailable") ?? os.freemem() ?? null,
    swapTotalBytes: mem.get("SwapTotal") ?? null,
    swapFreeBytes: mem.get("SwapFree") ?? null,
    zombies,
  };
}

/** `612Mi`, `1.4Gi` — fixed-width-ish, no trailing noise. */
export function humanBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "-";
  const units: [number, string][] = [
    [1024 ** 3, "Gi"],
    [1024 ** 2, "Mi"],
    [1024, "Ki"],
  ];
  for (const [scale, suffix] of units) {
    if (bytes >= scale) {
      const v = bytes / scale;
      // Keep one decimal up to 3 significant digits: at Gi scale a bare integer
      // rounds 15.6Gi to "16Gi", which visibly disagrees with `free -h` and
      // makes the header look wrong.
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${suffix}`;
    }
  }
  return `${Math.round(bytes)}B`;
}
