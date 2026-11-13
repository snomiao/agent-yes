// `ay cron` / `ay schedules` CLI shell: store files, ay ls/send, the daemon loop and
// its autostart, over the pure core in schedules.ts.
import { spawn, spawnSync } from "child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import path from "path";
import {
  CRON_HELP,
  DAEMON_NAME,
  SCHEDULES_HELP,
  type LogEntry,
  type RunState,
  type Store,
  type StoreEntry,
  dueNow,
  fmtTime,
  launchdDaemonPlist,
  legacyRows,
  logFile,
  msToNextMinute,
  nextCronId,
  nextRuns,
  parseCronAdd,
  parseState,
  parseStore,
  pickAutostart,
  renderMessage,
  resolveTarget,
  stateFile,
  storeFile,
  systemdDaemonUnit,
  windowsTaskArgs,
} from "./schedules.ts";

function selfCmd(): string[] {
  const argv1 = process.argv[1];
  return argv1 && /\.(c|m)?[jt]s$/.test(argv1) ? [process.execPath, argv1] : [argv1 || "ay"];
}

function runSelf(args: string[]) {
  const [cmd, ...pre] = selfCmd();
  return spawnSync(cmd!, [...pre, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readText(f: string): string | null {
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

function writeAtomic(f: string, text: string) {
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, f);
}

const loadStore = (): Store => parseStore(readText(storeFile()));
const saveStore = (s: Store) => writeAtomic(storeFile(), JSON.stringify(s, null, 2) + "\n");
const loadState = (): RunState => parseState(readText(stateFile()));
const saveState = (s: RunState) => writeAtomic(stateFile(), JSON.stringify(s) + "\n");

function log(e: LogEntry) {
  const f = logFile();
  mkdirSync(path.dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(e) + "\n");
}

/** Resolve the target and `ay send --force`. Returns the exit code (3 = target not live). */
export function fire(e: StoreEntry, now: number, manual = false): number {
  let live: { pid: number; agent_id: string; cwd: string }[] = [];
  try {
    live = JSON.parse(runSelf(["ls", "--json"]).stdout || "[]");
  } catch {
    /* none */
  }
  const r = resolveTarget(e.target, live, (lane) => {
    const x = runSelf(["lanes", "id", lane]);
    return {
      ok: x.status === 0,
      out: x.status === 0 ? x.stdout : (x.stderr || "").trim().split("\n")[0] || "",
    };
  });
  const base = {
    ts: new Date(now).toISOString(),
    name: e.name,
    target: e.target,
    ...(manual ? { manual } : {}),
  };
  if (!r.ok) {
    log({ ...base, ok: false, code: 3, error: r.error });
    console.error(`ay cron ${e.name}: ${r.error}; nothing sent`);
    return 3;
  }
  const s = runSelf(["send", r.agentId, renderMessage(e, now), "--force"]);
  const code = s.status ?? 1;
  log({
    ...base,
    agent_id: r.agentId,
    ok: code === 0,
    code,
    ...(code ? { error: (s.stderr || "").trim().slice(0, 500) } : {}),
  });
  return code;
}

function lastStr(st: RunState, name: string, tz: string): string {
  const l = st.last[name];
  return l ? `${fmtTime(l.at, tz)} ${l.ok ? "ok" : `exit ${l.code}`}` : "-";
}

function printEntries(entries: StoreEntry[], st: RunState, withSource: boolean) {
  const now = Date.now();
  for (const e of entries) {
    const next = e.enabled ? nextRuns(e.cron, e.tz, now, 1)[0] : undefined;
    console.log(
      [
        e.name.padEnd(6),
        ...(withSource ? [`source=${e.source}`] : []),
        `"${e.cron}" ${e.tz}`,
        e.target,
        e.enabled ? "" : "(disabled)",
        `next ${next ? fmtTime(next, e.tz) : "-"}`,
        `last ${lastStr(st, e.name, e.tz)}`,
        `: ${e.message.length > 60 ? e.message.slice(0, 59) + "…" : e.message}`,
      ]
        .filter(Boolean)
        .join("  "),
    );
  }
}

// ---------------------------------------------------------------------------
// ay cron
// ---------------------------------------------------------------------------

export async function cmdCron(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(CRON_HELP);
    return sub ? 0 : 1;
  }
  if (sub === "ls" || sub === "list") {
    const st = loadState();
    const entries = loadStore().entries.filter((e) => e.source === "cron");
    if (!entries.length) console.log("no reminders (ay cron help)");
    printEntries(entries, st, false);
    if (entries.length && !daemonPid())
      console.log(`\nwarning: the scheduler daemon is not running (ay schedules daemon install)`);
    return 0;
  }
  if (sub === "rm" || sub === "remove") {
    const id = rest[0];
    const store = loadStore();
    const hit = store.entries.find((e) => e.name === id && e.source === "cron");
    if (!id || !hit) {
      console.error(`ay cron rm: no reminder "${id ?? ""}" (see ay cron ls)`);
      return 2;
    }
    saveStore({ ...store, entries: store.entries.filter((e) => e !== hit) });
    console.log(`removed ${id}`);
    return 0;
  }
  const p = parseCronAdd(argv);
  if (!p.ok) {
    console.error(`ay cron: ${p.error}`);
    return 1;
  }
  const store = loadStore();
  const name = nextCronId(store);
  const entry: StoreEntry = {
    name,
    cron: p.cron,
    tz: p.tz,
    target: p.target,
    message: p.message,
    enabled: true,
    missed: "skip",
    source: "cron",
    since: Date.now(),
  };
  saveStore({ ...store, entries: [...store.entries, entry] });
  const next = nextRuns(p.cron, p.tz, Date.now(), 1)[0];
  console.log(
    `added ${name}: "${p.cron}" ${p.tz} -> ${p.target}; next ${next ? fmtTime(next, p.tz) : "-"}`,
  );
  const started = await ensureDaemon(false);
  if (!started)
    console.log(`warning: could not start the scheduler daemon (ay schedules daemon install)`);
  return 0;
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

const pidFile = () => path.join(path.dirname(stateFile()), "schedulerd.pid");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function daemonPid(): number | null {
  const pid = Number(readText(pidFile())?.trim());
  return pid && alive(pid) ? pid : null;
}

/** Foreground loop. One per machine (pid file); wakes each minute. */
export async function daemonRun(): Promise<number> {
  const other = daemonPid();
  if (other && other !== process.pid) {
    console.error(`${DAEMON_NAME}: already running (pid ${other})`);
    return 0;
  }
  writeAtomic(pidFile(), `${process.pid}\n`);
  console.error(`${DAEMON_NAME}: started pid ${process.pid}, store ${storeFile()}`);
  for (;;) {
    const now = Date.now();
    const st = loadState();
    if (!st.lastTick) st.lastTick = now - 60000; // first start: nothing is "missed"
    for (const e of dueNow(loadStore().entries, st, now)) {
      const code = fire(e, now);
      st.last[e.name] = { at: now, ok: code === 0, code };
    }
    st.lastTick = now;
    saveState(st);
    await new Promise((r) => setTimeout(r, msToNextMinute(Date.now())));
  }
}

function has(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return r.status === 0;
}

function which(cmd: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() || null : null;
}

function autostartKind() {
  return pickAutostart({
    platform: process.platform,
    hasOxmgr: !!which("oxmgr"),
    systemdUser: process.platform === "linux" && has("systemctl", ["--user", "show-environment"]),
  });
}

/** Start the daemon and register it to stay alive. Returns whether it is running. */
export async function ensureDaemon(verbose: boolean): Promise<boolean> {
  if (daemonPid()) {
    if (verbose) console.log(`${DAEMON_NAME}: already running (pid ${daemonPid()})`);
    return true;
  }
  const argv = [...selfCmd(), "schedules", "daemon", "run"];
  const pathEnv = process.env.PATH || "";
  const kind = autostartKind();
  const home = homedir();
  const say = (m: string) => verbose && console.log(m);
  let ok = false;
  if (kind === "oxmgr") {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    ok = has("oxmgr", [
      "start",
      argv.map(q).join(" "),
      "--name",
      DAEMON_NAME,
      "--restart",
      "always",
    ]);
    if (ok) {
      const { ensureBootAutostart } = await import("./oxmgrService.ts");
      await ensureBootAutostart(which("oxmgr")!).catch(() => false);
    }
  } else if (kind === "systemd") {
    const f = path.join(home, ".config", "systemd", "user", `${DAEMON_NAME}.service`);
    writeAtomic(f, systemdDaemonUnit(argv, pathEnv));
    ok =
      has("systemctl", ["--user", "daemon-reload"]) &&
      has("systemctl", ["--user", "enable", "--now", `${DAEMON_NAME}.service`]);
  } else if (kind === "launchd") {
    const f = path.join(home, "Library", "LaunchAgents", "com.agent-yes.schedulerd.plist");
    writeAtomic(
      f,
      launchdDaemonPlist(argv, pathEnv, path.join(path.dirname(stateFile()), "schedulerd.log")),
    );
    ok = has("launchctl", ["load", "-w", f]);
  } else if (kind === "schtasks") {
    ok = has("schtasks", windowsTaskArgs(argv)) && has("schtasks", ["/Run", "/TN", DAEMON_NAME]);
  }
  if (!ok) {
    // nohup fallback (containers without an init system): detached child; not restarted on reboot.
    const f = path.join(path.dirname(stateFile()), "schedulerd.log");
    mkdirSync(path.dirname(f), { recursive: true });
    const out = openSync(f, "a");
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    say(
      `${DAEMON_NAME}: ${kind === "nohup" ? "" : `${kind} failed; `}started detached (pid ${child.pid}); not restarted on reboot`,
    );
  } else say(`${DAEMON_NAME}: installed via ${kind}`);
  for (let i = 0; i < 20 && !daemonPid(); i++) await new Promise((r) => setTimeout(r, 250));
  return !!daemonPid();
}

// ---------------------------------------------------------------------------
// ay schedules
// ---------------------------------------------------------------------------

export async function cmdSchedules(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(SCHEDULES_HELP);
    return sub ? 0 : 1;
  }
  if (sub === "ls" || sub === "list") {
    printEntries(loadStore().entries, loadState(), true);
    const ox = which("oxmgr");
    if (ox) {
      const r = spawnSync(ox, ["list"], { encoding: "utf8" });
      for (const row of legacyRows(r.stdout || "")) console.log(`source=schedule  ${row.trim()}`);
    }
    const pid = daemonPid();
    console.log(
      `\ndaemon: ${pid ? `running (pid ${pid})` : "not running (ay schedules daemon install)"}`,
    );
    return 0;
  }
  if (sub === "daemon") {
    const what = rest[0] ?? "status";
    if (what === "run") return daemonRun();
    if (what === "install" || what === "start") return (await ensureDaemon(true)) ? 0 : 1;
    if (what === "status") {
      const pid = daemonPid();
      console.log(
        pid
          ? `running (pid ${pid}); autostart: ${autostartKind()}`
          : `not running; autostart would use ${autostartKind()}`,
      );
      return pid ? 0 : 3;
    }
  }
  console.error(`ay schedules: unknown command "${argv.join(" ")}"\n`);
  process.stdout.write(SCHEDULES_HELP);
  return 1;
}
