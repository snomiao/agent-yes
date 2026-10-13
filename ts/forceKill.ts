// The force-kill shared by the console's POST /api/kill and `ay kill <pid>`.
//
// SIGKILL the agent's process GROUP (wrapper + CLI + children), via the pgid
// the reaper recorded, then the pids directly in case they aren't group
// leaders. The >1 guards are critical — process.kill(-1)/kill(0) would signal
// far too much. Unix only; callers refuse win32.

import { pgidForWrapper } from "./reaper.ts";

export interface ForceKillTarget {
  pid: number;
  wrapper_pid?: number | null;
}

/** What forceKill would signal, without signalling it. */
export async function forceKillTargets(record: ForceKillTarget): Promise<{
  pgid: number | null;
  pids: number[];
}> {
  const g = await pgidForWrapper(record.wrapper_pid ?? 0);
  const pids = [record.pid];
  if (record.wrapper_pid && record.wrapper_pid !== record.pid) pids.push(record.wrapper_pid);
  return { pgid: g && g > 1 ? g : null, pids: pids.filter((p) => p > 1) };
}

/** SIGKILL the targets; returns labels of what was actually signalled. */
export function forceKill(targets: { pgid: number | null; pids: number[] }): string[] {
  const killed: string[] = [];
  if (targets.pgid && targets.pgid > 1) {
    try {
      process.kill(-targets.pgid, "SIGKILL");
      killed.push(`group ${targets.pgid}`);
    } catch {
      /* group already gone */
    }
  }
  for (const pid of targets.pids) {
    if (pid <= 1) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid === targets.pids[0] ? `pid ${pid}` : `wrapper ${pid}`);
    } catch {
      /* ESRCH: already gone */
    }
  }
  return killed;
}
