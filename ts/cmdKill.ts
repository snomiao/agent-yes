// `ay kill <pid>` — force-kill one agent, by the exact pid `ay ls` prints.
//
// The CLI counterpart of the console's POST /api/kill, using the same kill path
// (ts/forceKill.ts: SIGKILL the recorded process group, then pid + wrapper).
// It exists so nobody reaches for `pkill -f <pattern>`: that pattern usually
// also matches the caller's own shell (its argv contains it), so the caller
// kills itself. Deliberately narrow: local only, exact pid only, no keyword
// matching, and it refuses when the kill would reach the caller.

import yargs from "yargs";
import type { GlobalPidRecord } from "./globalPidIndex.ts";
import { pidOwnershipVerdict } from "./senderAncestry.ts";

/**
 * Why a kill of `record` must not go ahead, or null. Pure, so each refusal is
 * unit-tested. `selfChain` is the caller and its ancestors; `selfPgid` the
 * caller's process group (null when unknown).
 */
export function killRefusal(
  record: Pick<GlobalPidRecord, "pid" | "wrapper_pid">,
  targets: { pgid: number | null },
  selfChain: number[],
  selfPgid: number | null,
): string | null {
  for (const [pid, what] of [
    [record.pid, "pid"],
    [record.wrapper_pid, "wrapper pid"],
  ] as const) {
    if (pid && selfChain.includes(pid)) {
      return (
        `${what} ${pid} is this shell or one of its ancestors — killing it would kill the ` +
        `caller too. To end your own agent, use: ay exit ${record.pid}`
      );
    }
  }
  if (targets.pgid && selfPgid && targets.pgid === selfPgid) {
    return `process group ${targets.pgid} is the caller's own group — refusing to kill it`;
  }
  return null;
}

/** The record's wrapper pid if it now belongs to a process younger than the
 * registration (reused), else null. Same age test as `ay restart`. */
export function reusedWrapperPid(
  record: Pick<GlobalPidRecord, "pid" | "wrapper_pid" | "started_at">,
  table: Map<number, { ageSecs: number }>,
  now = Date.now(),
): number | null {
  const w = record.wrapper_pid;
  if (!w || w === record.pid) return null;
  return pidOwnershipVerdict(table.get(w)?.ageSecs, record.started_at, now) === "reused" ? w : null;
}

async function ownPgid(): Promise<number | null> {
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
    const n = Number(out.trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

export async function cmdKill(rest: string[]): Promise<number> {
  const usage = "usage: ay kill <pid> [--dry-run]   (the exact pid shown by ay ls)";
  const argv = await yargs(rest)
    .usage(usage)
    .option("dry-run", {
      alias: "n",
      type: "boolean",
      default: false,
      description: "Print what would be killed, send nothing",
    })
    .strictOptions()
    // Keep the selector a string (`12e3` must not become 12000).
    .parserConfiguration({ "parse-positional-numbers": false })
    .help(false)
    .version(false)
    .exitProcess(false)
    .parseAsync();
  const sel = argv._.length === 1 ? String(argv._[0]) : "";
  if (!/^[1-9]\d*$/.test(sel)) {
    process.stderr.write(
      `ay kill: expected exactly one pid as printed by \`ay ls\`${sel ? ` (got '${sel}')` : ""}.\n` +
        `  No keyword, agent-id or remote matching — for a graceful stop use: ay stop <keyword>\n`,
    );
    return 1;
  }
  if (process.platform === "win32") {
    process.stderr.write(`ay kill: not supported on Windows (as with the console's Kill)\n`);
    return 1;
  }
  const pid = Number(sel);

  const { readGlobalPids, updateGlobalPidStatus } = await import("./globalPidIndex.ts");
  const matches = (await readGlobalPids()).filter((r) => r.pid === pid);
  if (matches.length !== 1) {
    process.stderr.write(
      matches.length === 0
        ? `ay kill: no registered agent has pid ${pid} (see: ay ls --all)\n`
        : `ay kill: ${matches.length} registry rows claim pid ${pid} — refusing an ambiguous kill\n`,
    );
    return 1;
  }
  const record = matches[0]!;
  if (record.status === "exited") {
    process.stderr.write(
      `ay kill: pid ${pid} is registered as exited — refusing: the number may belong to ` +
        `another process by now\n`,
    );
    return 1;
  }

  // Everything below needs the process table; without it we can neither protect
  // the caller nor detect a reused pid, so refuse rather than guess.
  const { ancestorPids, pidOwnershipVerdict, readAncestryTable } =
    await import("./senderAncestry.ts");
  const table = await readAncestryTable();
  const selfPgid = await ownPgid();
  if (!table || !selfPgid) {
    process.stderr.write(
      `ay kill: could not read the process table (ps) — refusing, since it is unknown ` +
        `whether pid ${pid} is still this agent or an ancestor of this shell\n`,
    );
    return 1;
  }
  // Same pid-reuse guard as \`ay restart\`'s force-kill: a process younger than
  // its registration cannot be the agent that registered.
  if (pidOwnershipVerdict(table.get(pid)?.ageSecs, record.started_at) === "reused") {
    process.stderr.write(
      `ay kill: pid ${pid} is alive but is NOT the agent that registered it (the number ` +
        `was reused) — refusing. Retire the stale row with: ay stop ${pid}\n`,
    );
    return 1;
  }

  const { forceKill, forceKillTargets } = await import("./forceKill.ts");
  const targets = await forceKillTargets(record);
  // The wrapper pid gets the same reuse guard; a reused one is left alone.
  const reusedWrapper = reusedWrapperPid(record, table);
  if (reusedWrapper) {
    targets.pids = targets.pids.filter((p) => p !== reusedWrapper);
    process.stderr.write(
      `ay kill: warning: wrapper pid ${reusedWrapper} was reused — not signalling it\n`,
    );
  }
  const selfChain = [
    process.pid,
    process.ppid,
    ...(await ancestorPids(process.pid, { readTable: async () => table })),
  ];
  const refusal = killRefusal(record, targets, selfChain, selfPgid);
  if (refusal) {
    process.stderr.write(`ay kill: ${refusal}\n`);
    return 1;
  }

  const what = `pid ${pid} (${record.cli}, ${record.cwd})`;
  if (argv["dry-run"]) {
    const list = [...(targets.pgid ? [`group ${targets.pgid}`] : []), ...targets.pids];
    process.stdout.write(`would SIGKILL ${list.join(", ")} — ${what}\n`);
    return 0;
  }
  const { killed, failed } = forceKill(targets);
  if (failed.length) {
    process.stderr.write(
      `ay kill: could not signal ${failed.join(", ")} — ${what} not marked exited\n`,
    );
    return 1;
  }
  await updateGlobalPidStatus(pid, {
    status: "exited",
    exit_reason: "force-killed via ay kill",
  }).catch(() => {});
  process.stdout.write(
    `killed ${what}: ${killed.join(", ") || "nothing left to signal (already gone)"}\n`,
  );
  return 0;
}
