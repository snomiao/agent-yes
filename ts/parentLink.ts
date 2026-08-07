/**
 * Resolve "who spawned me" from the wrapper-pid link the registry already
 * carries, into an addressable identity.
 *
 * The link itself is just a number: a nested `ay` inherits its parent wrapper's
 * `AGENT_YES_PID` and records it as `parent_pid` (see globalPidIndex's
 * GlobalPidRecord). To actually TALK to that parent — which is what
 * `<ay-init-msg>` and the finished/stuck ping both need — we have to map that
 * wrapper pid back to the parent's canonical record, because the reply route is
 * its `agent_id` (stable across restart), not its pid.
 *
 * Shared by ts/initMsg.ts's caller and ts/parentPing's delivery so both address
 * the SAME identity — a child that reports to a different route than the one
 * printed in its own init block would be maddening to debug.
 */

import { readGlobalPids, type GlobalPidRecord } from "./globalPidIndex.ts";
import type { InitSpawner } from "./initMsg.ts";

/**
 * The parent agent for `parentPid` (a parent WRAPPER pid), or null.
 *
 * Null covers three different situations that all mean the same thing here —
 * "nobody to report to": no parent at all (top-level, human-launched); a parent
 * whose record aged out of the registry; or a parent on another host. Callers
 * treat all three as "skip the wrapper / skip the ping" rather than guessing a
 * route that would silently go nowhere.
 */
export async function resolveSpawner(
  parentPid: number | null | undefined,
): Promise<InitSpawner | null> {
  if (typeof parentPid !== "number" || !Number.isInteger(parentPid) || parentPid <= 0) return null;
  let records: GlobalPidRecord[];
  try {
    records = await readGlobalPids();
  } catch {
    return null; // registry unreadable — never block a spawn over attribution
  }
  return spawnerFromRecords(records, parentPid);
}

/** Pure half of resolveSpawner, so the match rule is testable without the fs. */
export function spawnerFromRecords(
  records: GlobalPidRecord[],
  parentPid: number,
): InitSpawner | null {
  // Prefer a live record: a recycled wrapper pid can match an old exited entry
  // too, and reporting into a dead agent's fifo is worse than not reporting.
  const matches = records.filter((r) => r.wrapper_pid === parentPid);
  const parent = matches.find((r) => r.status !== "exited") ?? matches[0];
  if (!parent) return null;
  return {
    cli: parent.cli,
    pid: parent.pid,
    agentId: parent.agent_id ?? null,
    cwd: parent.cwd,
  };
}
