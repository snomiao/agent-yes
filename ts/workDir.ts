import { readFile, stat } from "fs/promises";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/**
 * Where an agent actually WORKS, as opposed to where it was spawned.
 *
 * A lane is often launched in one dir and works in another (`cd <worktree> &&
 * …` per Bash call). The wrapped CLI's own cwd never moves, so the registry's
 * `cwd` stays the spawn dir. The Rust wrapper samples the kernel cwd of the
 * agent's shells and writes the repo they run in to
 * `<agentYesHome>/workdir/<pid>.json` (rs/src/workdir_sampler.rs) — a
 * measurement, not something the agent wrote or claimed. This module only
 * reads it back.
 */

export type WorkDirSource = "observed" | "spawn";

export interface WorkDir {
  workdir: string;
  workdir_source: WorkDirSource;
  /** epoch ms of the latest sample that confirmed `workdir`; null for spawn. */
  workdir_at: number | null;
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function workdirSamplePath(pid: number): string {
  return path.join(agentYesHome(), "workdir", `${pid}.json`);
}

/**
 * The wrapper's latest sample for this agent, or null. A sample whose
 * `agent_id` doesn't match belongs to an earlier agent that had the same pid.
 */
export async function readWorkdirSample(r: {
  pid: number;
  agent_id?: string | null;
}): Promise<{ workdir: string; at: number } | null> {
  try {
    const j = JSON.parse(await readFile(workdirSamplePath(r.pid), "utf-8"));
    if (typeof j?.workdir !== "string" || typeof j?.at !== "number") return null;
    // Both sides must carry the id and agree: a sample without one (or a record
    // without one) can't be told apart from a crashed predecessor's leftover.
    if (!r.agent_id || j.agent_id !== r.agent_id) return null;
    return { workdir: j.workdir, at: j.at };
  } catch {
    return null;
  }
}

/**
 * The effective work dir for a record. The sampled repo wins unless it merely
 * contains the spawn dir (a lane working in the repo it was spawned in — the
 * spawn cwd is the more precise answer) or it no longer exists.
 */
export async function resolveWorkDir(r: {
  pid: number;
  cwd: string;
  agent_id?: string | null;
}): Promise<WorkDir> {
  const spawn: WorkDir = { workdir: r.cwd, workdir_source: "spawn", workdir_at: null };
  const sample = await readWorkdirSample(r);
  const w = sample?.workdir;
  if (!w || isWithin(r.cwd, w)) return spawn;
  const isDir = await stat(w).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) return spawn;
  return { workdir: w, workdir_source: "observed", workdir_at: sample.at };
}
