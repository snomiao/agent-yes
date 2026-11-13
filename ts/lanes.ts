// `ay lanes` — address agents by a stable lane name that survives wrapper restarts.
//
// A lane is a name bound to a working directory (and optionally a host). The lane's
// agent is the newest live agent whose cwd is exactly that directory. When several
// lanes share one cwd, the agent whose prompt says "You are the [<name>" wins.
//
// Registry: $AY_LANES_FILE, else ~/.config/agent-yes/lanes.tsv. One lane per line:
//   name<TAB>cwd relative to $HOME<TAB>[host ssh alias; empty = this machine]
// Lines starting with # are comments.
import { readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";

export interface Lane {
  name: string;
  rel: string;
  host: string;
}

export interface LiveAgent {
  started_at: number;
  pid: number;
  agent_id: string;
  cwd: string;
  /** "x" of "You are the [x" in the agent's prompt, or null */
  tag: string | null;
}

export type Resolution =
  | { ok: true; agent: LiveAgent }
  | { ok: false; code: 2 | 3 | 4; error: string };

export const HELP = `Usage: ay lanes <command>

Address agents by a stable lane name (survives wrapper restarts).

  ay lanes ls                       table: lane -> live pid / agent_id / cwd (/host)
  ay lanes id <name>                print the lane's live agent_id (exit 3 if none)
  ay lanes pid <name>               print the lane's live pid
  ay lanes send <name> <msg...> [-- <ay send flags>]
                                    ay send to the lane (e.g. -- --force)
  ay lanes resume <name>|--all [--dry-run] [--max-age 48h]
                                    restart a lane with no live agent from its newest
                                    Claude session: ay --detach claude -- --resume <id>

Registry: $AY_LANES_FILE, else ~/.config/agent-yes/lanes.tsv. Format, one lane per line:
  name<TAB>cwd relative to $HOME<TAB>[host ssh alias; empty = this machine]
A lane is the newest live agent whose cwd is exactly ~/<cwd>; when lanes share a cwd,
the agent whose prompt says "You are the [<name>" wins. Lanes on another host are
resolved there over ssh (ay lanes runs on that host with AY_LANES_LOCAL=1).
`;

export function lanesFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.AY_LANES_FILE || path.join(homedir(), ".config", "agent-yes", "lanes.tsv");
}

export function parseLanes(text: string): Lane[] {
  const out: Lane[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const f = line.replace(/\r$/, "").split("\t");
    if (f.length < 2 || !f[0] || !f[1]) continue;
    out.push({ name: f[0], rel: f[1], host: f[2] ?? "" });
  }
  return out;
}

/** "[shr@x]" / "shr@x" / "shr" -> "shr" */
export function normalizeName(name: string): string {
  return name.replace(/^\[/, "").replace(/\]$/, "").replace(/@.*$/, "");
}

export function promptTag(prompt: string | null | undefined): string | null {
  const m = /You are the \[([a-z0-9-]+)/.exec(prompt ?? "");
  return m ? m[1]! : null;
}

/** Live agents from `ay ls --json` records, newest first. */
export function parseLive(records: any[]): LiveAgent[] {
  return records
    .filter((r) => r && r.state !== "exited" && r.status !== "exited")
    .map((r) => ({
      started_at: Number(r.started_at) || 0,
      pid: Number(r.pid),
      agent_id: String(r.agent_id ?? ""),
      cwd: String(r.cwd ?? ""),
      tag: promptTag(r.prompt),
    }))
    .sort((a, b) => b.started_at - a.started_at);
}

/** The lane's agent among `live` (for `ls`: never refuses; picks tag match, else newest). */
export function pickForLs(lane: Lane, live: LiveAgent[], home: string): LiveAgent | null {
  const dir = path.join(home, lane.rel);
  const inDir = live.filter((a) => a.cwd === dir);
  return inDir.find((a) => a.tag === lane.name) ?? inDir[0] ?? null;
}

export function resolveLane(
  rawName: string,
  lanes: Lane[],
  live: LiveAgent[],
  home: string,
): Resolution {
  const name = normalizeName(rawName);
  const lane = lanes.find((l) => l.name === name);
  if (!lane) {
    // not registered: exactly one live agent tagged "[<name>" still resolves
    const tagged = live.filter((a) => a.tag === name);
    if (tagged.length === 1) return { ok: true, agent: tagged[0]! };
    if (tagged.length > 1)
      return {
        ok: false,
        code: 4,
        error:
          `several live agents are tagged [${name}]; refusing to pick one:\n` +
          tagged.map((a) => `  pid ${a.pid} id ${a.agent_id}`).join("\n"),
      };
    return {
      ok: false,
      code: 2,
      error: `unknown lane "${name}". Known: ${lanes.map((l) => l.name).join(" ")}`,
    };
  }
  const dir = path.join(home, lane.rel);
  const inDir = live.filter((a) => a.cwd === dir);
  const tagged = inDir.filter((a) => a.tag === name);
  const hits = tagged.length ? tagged : inDir;
  if (hits.length > 1)
    return {
      ok: false,
      code: 4,
      error:
        `${hits.length} live agents match "${name}" (cwd ~/${lane.rel}); refusing to pick one:\n` +
        hits.map((a) => `  pid ${a.pid} id ${a.agent_id}`).join("\n"),
    };
  if (hits.length === 0)
    return { ok: false, code: 3, error: `no live agent for "${name}" (cwd ~/${lane.rel}).` };
  return { ok: true, agent: hits[0]! };
}

/** Claude's project dir for a cwd: ~/.claude/projects/<cwd with / and . replaced by -> */
export function claudeProjectDir(cwd: string, home: string): string {
  return path.join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

export interface SessionPick {
  id: string;
  file: string;
  mtimeMs: number;
}

const TAIL_BYTES = 256 * 1024;

function tailText(file: string): string {
  try {
    const buf = readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - TAIL_BYTES)).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The session to resume for a lane: the newest *.jsonl in its Claude project dir.
 * When `shared` (several lanes use this cwd), prefer the session whose recent content
 * mentions "[<name>]" most; ties (and no mentions at all) fall back to newest.
 */
export function pickSession(projectDir: string, name: string, shared: boolean): SessionPick | null {
  let files: SessionPick[];
  try {
    files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = path.join(projectDir, f);
        return { id: f.slice(0, -".jsonl".length), file, mtimeMs: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  if (!files.length) return null;
  if (!shared) return files[0]!;
  const needle = `[${name}]`;
  let best = files[0]!;
  let bestCount = 0;
  for (const f of files) {
    const count = tailText(f.file).split(needle).length - 1;
    if (count > bestCount) {
      best = f;
      bestCount = count;
    }
  }
  return best;
}

export function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) return null;
  const mult = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[(m[2] ?? "h") as "h"];
  return Number(m[1]) * mult;
}

export interface ResumePlan {
  lane: string;
  cwd: string;
  action: "resume" | "skip";
  reason?: string;
  session?: SessionPick;
}

/** What `resume` would do for each lane (pure apart from reading session files). */
export function planResume(
  targets: Lane[],
  allLanes: Lane[],
  live: LiveAgent[],
  home: string,
  maxAgeMs: number,
  now: number,
): ResumePlan[] {
  return targets.map((lane) => {
    const cwd = path.join(home, lane.rel);
    const r = resolveLane(lane.name, allLanes, live, home);
    // an agent tagged for ANOTHER lane in a shared cwd does not make this lane live
    if (r.ok && (r.agent.tag === null || r.agent.tag === lane.name))
      return { lane: lane.name, cwd, action: "skip", reason: `live (pid ${r.agent.pid})` };
    if (!r.ok && r.code === 4) return { lane: lane.name, cwd, action: "skip", reason: r.error };
    const shared = allLanes.filter((l) => l.rel === lane.rel).length > 1;
    const s = pickSession(claudeProjectDir(cwd, home), lane.name, shared);
    if (!s) return { lane: lane.name, cwd, action: "skip", reason: "no Claude session found" };
    const age = now - s.mtimeMs;
    if (age > maxAgeMs)
      return {
        lane: lane.name,
        cwd,
        action: "skip",
        reason: `newest session ${s.id} is ${Math.round(age / 3600e3)}h old (> --max-age)`,
        session: s,
      };
    return { lane: lane.name, cwd, action: "resume", session: s };
  });
}

export function resumeNote(name: string): string {
  return `[ay lanes resume] Lane [${name}] was restarted from its last session (the previous agent had exited). Continue where you left off.`;
}
