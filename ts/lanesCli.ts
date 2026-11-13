// `ay lanes` CLI shell: registry/ay-ls/ssh/spawn I/O over the pure core in lanes.ts.
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir, hostname } from "os";
import path from "path";
import {
  HELP,
  type Lane,
  type LiveAgent,
  lanesFile,
  normalizeName,
  parseDuration,
  parseLanes,
  parseLive,
  pickForLs,
  planResume,
  resolveLane,
  resumeNote,
} from "./lanes.ts";

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function selfCmd(): string[] {
  const argv1 = process.argv[1];
  return argv1 && /\.(c|m)?[jt]s$/.test(argv1) ? [process.execPath, argv1] : [argv1 || "ay"];
}

function runSelf(args: string[], opts: { inherit?: boolean; cwd?: string } = {}) {
  const [cmd, ...pre] = selfCmd();
  return spawnSync(cmd!, [...pre, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readLive(): LiveAgent[] {
  const r = runSelf(["ls", "--json"]);
  try {
    return parseLive(JSON.parse(r.stdout || "[]"));
  } catch {
    return [];
  }
}

function lastKnown(rel: string, home: string): string {
  const r = runSelf(["ls", "--all", "--json"]);
  try {
    const recs = (JSON.parse(r.stdout || "[]") as any[])
      .filter((x) => x.cwd === path.join(home, rel))
      .sort((a, b) => Number(a.started_at) - Number(b.started_at));
    const l = recs.at(-1);
    return l ? `pid ${l.pid} id ${l.agent_id} (${l.exit_reason ?? l.status})` : "none";
  } catch {
    return "none";
  }
}

function isLocal(env = process.env): boolean {
  return !!(env.AY_LANES_LOCAL || env.LANE_LOCAL);
}

function remoteHost(lane: Lane | undefined): string | null {
  if (!lane || !lane.host || isLocal()) return null;
  return lane.host === hostname().split(".")[0] ? null : lane.host;
}

function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run `ay lanes ARGS` on HOST over ssh; lanes resolve there. */
function runRemote(host: string, args: string[], capture = false) {
  const cmd =
    `PATH=$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH ` +
    `AY_LANES_LOCAL=1 ay lanes ${args.map(shQuote).join(" ")}`;
  return spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function loadLanes(): Lane[] | null {
  const f = lanesFile();
  if (!existsSync(f)) {
    console.error(
      `ay lanes: no registry at ${f} (set AY_LANES_FILE or create it; see ay lanes help)`,
    );
    return null;
  }
  return parseLanes(readFileSync(f, "utf8"));
}

export async function cmdLanes(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  const lanes = loadLanes();
  if (!lanes) return 2;
  const home = homedir();
  const laneOf = (n: string) => lanes.find((l) => l.name === normalizeName(n));

  switch (sub) {
    case "ls": {
      const live = readLive();
      for (const l of lanes) {
        const h = remoteHost(l);
        if (h) {
          const r = runRemote(h, ["id", l.name], true);
          const id = r.status === 0 ? r.stdout.trim() : "-";
          console.log(`${l.name.padEnd(12)} ${id.padEnd(24)} ~/${l.rel} (${h})`);
          continue;
        }
        const a = pickForLs(l, live, home);
        console.log(
          `${l.name.padEnd(12)} ${(a ? `${a.pid} ${a.agent_id}` : "-").padEnd(24)} ~/${l.rel}`,
        );
      }
      return 0;
    }
    case "id":
    case "pid":
    case "send": {
      const name = rest[0];
      if (!name) {
        console.error(`ay lanes ${sub}: missing lane name`);
        return 1;
      }
      const h = remoteHost(laneOf(name));
      if (h) return runRemote(h, argv).status ?? 1;
      const r = resolveLane(name, lanes, readLive(), home);
      if (!r.ok) {
        const lane = laneOf(name);
        const extra =
          r.code === 3 && lane ? ` last known: ${lastKnown(lane.rel, home)}. Nothing sent.` : "";
        console.error(`ay lanes: ${r.error}${extra}`);
        return r.code;
      }
      if (sub === "id") console.log(r.agent.agent_id);
      else if (sub === "pid") console.log(r.agent.pid);
      else {
        const args = rest.slice(1);
        const dd = args.indexOf("--");
        const msg = (dd < 0 ? args : args.slice(0, dd)).join(" ");
        const flags = dd < 0 ? [] : args.slice(dd + 1);
        return runSelf(["send", r.agent.agent_id, msg, ...flags], { inherit: true }).status ?? 1;
      }
      return 0;
    }
    case "resume": {
      let all = false;
      let dryRun = false;
      let maxAgeMs = 48 * 3600e3;
      const names: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--all") all = true;
        else if (a === "--dry-run" || a === "-n") dryRun = true;
        else if (a === "--max-age" || a.startsWith("--max-age=")) {
          const v = a.includes("=") ? a.split("=")[1]! : rest[++i];
          const ms = v ? parseDuration(v) : null;
          if (ms == null) {
            console.error(`ay lanes resume: bad --max-age "${v}" (e.g. 48h, 2d, 90m)`);
            return 1;
          }
          maxAgeMs = ms;
        } else names.push(a);
      }
      if (!all && !names.length) {
        console.error("ay lanes resume: give a lane name or --all");
        return 1;
      }
      const passOn = [...(dryRun ? ["--dry-run"] : []), "--max-age", `${maxAgeMs}ms`];
      let rc = 0;
      // remote lanes: run there (named ones only; --all covers this host's lanes)
      const local: Lane[] = [];
      for (const n of names) {
        const lane = laneOf(n);
        if (!lane) {
          console.error(`ay lanes: unknown lane "${normalizeName(n)}"`);
          rc = 2;
          continue;
        }
        const h = remoteHost(lane);
        if (h) rc = runRemote(h, ["resume", lane.name, ...passOn]).status || rc;
        else local.push(lane);
      }
      if (all) local.push(...lanes.filter((l) => !remoteHost(l) && !local.includes(l)));
      const plans = planResume(local, lanes, readLive(), home, maxAgeMs, Date.now());
      for (const p of plans) {
        if (p.action === "skip") {
          console.log(`${p.lane}: skip — ${p.reason}`);
          continue;
        }
        const args = ["--detach", "claude", "--", "--resume", p.session!.id, resumeNote(p.lane)];
        console.log(
          `${p.lane}: ${dryRun ? "would run" : "run"} (cwd ${p.cwd}) ay ${args.map(shQuote).join(" ")}`,
        );
        if (dryRun) continue;
        const [cmd, ...pre] = selfCmd();
        const child = spawn(cmd!, [...pre, ...args], { cwd: p.cwd, stdio: "inherit" });
        const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)));
        if (code !== 0) {
          console.error(`${p.lane}: ay --detach exited ${code}`);
          rc = code;
        }
      }
      return rc;
    }
    default:
      console.error(`ay lanes: unknown command "${sub}"\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
