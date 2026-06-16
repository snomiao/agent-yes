// Defense-in-depth orphan reaper — mirrors rs/src/reaper.rs (see it for the full
// rationale). Records each running agent's (wrapper pid, agent pgid) so a later
// sweep kills the recorded process group of any agent whose wrapper died WITHOUT
// running its own group cleanup (SIGKILL by an OOM killer / oxmgr force-restart /
// a panic). It targets the recorded pgid of a CONFIRMED-DEAD wrapper — never
// ppid==1 — so it is container-safe and never touches an unrelated process.

import { appendFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

const registryPath = () => path.join(agentYesHome(), "reaper.jsonl");

function isAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0); // signal 0 probes existence without affecting the target
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
  }
}

/** Record this wrapper + its agent's process group for later sweeping. */
export async function register(wrapperPid: number, pgid: number): Promise<void> {
  if (pgid <= 1) return; // never persist a group we'd refuse to signal
  try {
    await mkdir(agentYesHome(), { recursive: true });
    await appendFile(registryPath(), JSON.stringify({ wpid: wrapperPid, pgid }) + "\n");
  } catch {
    // best-effort
  }
}

/** SIGKILL the recorded group of every agent whose wrapper has exited, and
 *  rewrite the registry keeping only still-running agents. Best-effort. */
export async function sweep(): Promise<void> {
  let content: string;
  try {
    content = await readFile(registryPath(), "utf8");
  } catch {
    return; // no registry yet
  }
  const keep: string[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let entry: { wpid?: unknown; pgid?: unknown };
    try {
      entry = JSON.parse(t);
    } catch {
      continue; // drop malformed lines
    }
    if (typeof entry.wpid !== "number" || typeof entry.pgid !== "number") continue;
    if (isAlive(entry.wpid)) {
      keep.push(t); // agent still running — keep watching it
      continue;
    }
    // Wrapper gone — reap its recorded group. The pgid outlives the leader, so
    // this catches descendants already reparented to PID 1. The `> 1` guard is
    // critical: process.kill(-1) would signal every process the user owns.
    if (process.platform !== "win32" && entry.pgid > 1) {
      try {
        process.kill(-entry.pgid, "SIGKILL");
      } catch {
        // ESRCH = nothing left alive in that group
      }
    }
  }
  try {
    const tmp = registryPath() + ".tmp";
    await writeFile(tmp, keep.join("\n"));
    await rename(tmp, registryPath());
  } catch {
    // best-effort
  }
}
