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

/**
 * SIGKILL the targets. Returns labels of what was signalled, and of what could
 * NOT be signalled for a reason other than "already gone" (ESRCH) — e.g. EPERM,
 * a process owned by another user.
 */
export function forceKill(targets: { pgid: number | null; pids: number[] }): {
  killed: string[];
  failed: string[];
} {
  const killed: string[] = [];
  const failed: string[] = [];
  const sig = (target: number, label: string) => {
    try {
      process.kill(target, "SIGKILL");
      killed.push(label);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") failed.push(`${label} (${code ?? "error"})`);
    }
  };
  if (targets.pgid && targets.pgid > 1) sig(-targets.pgid, `group ${targets.pgid}`);
  for (const pid of targets.pids) {
    if (pid <= 1) continue;
    sig(pid, pid === targets.pids[0] ? `pid ${pid}` : `wrapper ${pid}`);
  }
  return { killed, failed };
}
