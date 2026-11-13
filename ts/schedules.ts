// Shared schedule store + cross-platform scheduler core for `ay cron` and `ay schedules`.
//
// ONE store ($AY_SCHEDULES_STORE, else ~/.config/agent-yes/schedules.json) holds every
// reminder. `ay cron` adds/lists/removes entries (source "cron"); `ay schedules ls`
// lists them together with the legacy oxmgr-backed `ay schedule` jobs. A single
// per-machine daemon (`ay schedules daemon run`) wakes every minute, fires due
// entries with `ay send --force`, and keeps last-run state on disk
// ($AY_SCHEDULES_STATE) so a restart neither double-fires nor storms missed runs.
// It is kept alive by oxmgr when present (the runner `ay schedule` already uses),
// else systemd --user, launchd, Windows Task Scheduler, or a detached nohup process.
//
// This file is the pure core; I/O lives in schedulesCli.ts.
import { homedir } from "os";
import path from "path";

export const DEFAULT_TZ = "Asia/Tokyo";

export interface Schedule {
  /** unique id/name (cron entries: c1, c2, …) */
  name: string;
  /** 5-field cron */
  cron: string;
  tz: string;
  /** lane:<name>, or an agent id / pid / keyword */
  target: string;
  message: string;
  enabled: boolean;
  /** missed fires (daemon down): skip, or fire once on restart */
  missed: "skip" | "run-once";
}

export const CRON_HELP = `Usage:
  ay cron "<cron>" <lane:<name>|agent> <message...>   add a reminder (5-field cron, tz $AY_CRON_TZ or ${DEFAULT_TZ})
  ay cron ls                                         list reminders with next run and last result
  ay cron rm <id>                                    remove one

A target is lane:<name> (resolved with ay lanes id), a lane name tagged in a live
agent's prompt, or an agent id / pid / keyword. The message is sent with
ay send --force; {now} and {name} are substituted. Reminders are fired by the
per-machine scheduler daemon (ay schedules daemon status|install). A missed tick
(daemon down) is skipped. Each fire is logged as JSONL to
~/.local/share/agent-yes/schedules.log ($AY_SCHEDULES_LOG).

Example:
  ay cron "*/30 9-18 * * 1-5" lane:alpha "progress report please ({now})"
`;

export const SCHEDULES_HELP = `Usage: ay schedules <command>   (alias: ay sched)

  ay schedules ls                   every schedule on this machine: ay cron reminders
                                    (source=cron) and legacy ay schedule jobs (source=schedule)
  ay schedules daemon status        is the scheduler daemon running, and how it is kept alive
  ay schedules daemon install       start it and keep it alive (oxmgr / systemd --user /
                                    launchd / Task Scheduler / nohup)
  ay schedules daemon run           the daemon loop itself (foreground)

Declarative schedules.yaml, apply and missed-run policies are pending a design decision.
`;

export function logFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.AY_SCHEDULES_LOG || path.join(home, ".local", "share", "agent-yes", "schedules.log");
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
}
const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  {
    min: 1,
    max: 12,
    names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  },
  { min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];
const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];

export interface CronField {
  /** sorted distinct values */
  values: number[];
  /** the field was `*` or `*\/n` with n=1 (unrestricted) */
  star: boolean;
}
export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

function parseNum(s: string, spec: FieldSpec): number {
  const lower = s.toLowerCase();
  const idx = spec.names?.indexOf(lower) ?? -1;
  if (idx >= 0) return idx + (spec.names!.length === 12 ? 1 : 0);
  if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number`);
  const n = Number(s);
  if (n < spec.min || n > spec.max) throw new Error(`${n} out of range ${spec.min}-${spec.max}`);
  return n;
}

function parseField(text: string, spec: FieldSpec, isDow: boolean): CronField {
  const set = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    const [range, stepS, extra] = part.split("/");
    if (extra !== undefined || range === "") throw new Error(`bad term "${part}"`);
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1 || (stepS !== undefined && !/^\d+$/.test(stepS)))
      throw new Error(`bad step in "${part}"`);
    let lo: number, hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = isDow ? 6 : spec.max;
      if (step === 1) star = true;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      lo = parseNum(a!, spec);
      hi = parseNum(b!, spec);
      if (lo > hi) throw new Error(`range ${range} goes backwards`);
    } else {
      lo = parseNum(range!, spec);
      hi = stepS === undefined ? lo : isDow ? 6 : spec.max;
    }
    for (let v = lo; v <= hi; v += step) set.add(isDow && v === 7 ? 0 : v);
  }
  return { values: [...set].sort((a, b) => a - b), star };
}

export function parseCron(cron: string): ParsedCron {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 fields, got ${parts.length}`);
  const f = parts.map((p, i) => {
    try {
      return parseField(p, FIELDS[i]!, i === 4);
    } catch (e) {
      throw new Error(`${FIELD_NAMES[i]}: ${(e as Error).message}`);
    }
  });
  return { minute: f[0]!, hour: f[1]!, dom: f[2]!, month: f[3]!, dow: f[4]! };
}

export function cronError(cron: string): string | null {
  try {
    parseCron(cron);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  dow: number;
}
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function tzParts(ms: number, tz: string): Parts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    dow: DOW_NAMES.indexOf(p.weekday!),
  };
}

/** Next fire times (epoch ms) strictly after `from`, in `tz`. */
export function nextRuns(cron: string, tz: string, from: number, n = 1): number[] {
  const c = parseCron(cron);
  const has = (f: CronField, v: number) => f.star || f.values.includes(v);
  const dayOk = (p: Parts) => {
    if (!c.dom.star && !c.dow.star) return has(c.dom, p.d) || has(c.dow, p.dow);
    return has(c.dom, p.d) && has(c.dow, p.dow);
  };
  const out: number[] = [];
  let t = Math.floor(from / 60000) * 60000 + 60000;
  const end = from + 400 * 86400000;
  while (out.length < n && t < end) {
    const p = tzParts(t, tz);
    if (!has(c.month, p.mo) || !dayOk(p)) t += (1440 - p.h * 60 - p.mi) * 60000;
    else if (!has(c.hour, p.h)) t += (60 - p.mi) * 60000;
    else if (!has(c.minute, p.mi)) t += 60000;
    else {
      out.push(t);
      t += 60000;
    }
  }
  return out;
}

/** `2026-01-02 03:04 Asia/Tokyo` */
export function fmtTime(ms: number, tz: string): string {
  const p = tzParts(ms, tz);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)} ${tz}`;
}

export function renderMessage(s: Schedule, now: number): string {
  return s.message.replaceAll("{now}", fmtTime(now, s.tz)).replaceAll("{name}", s.name);
}

// ---------------------------------------------------------------------------
// Store: entries + run state (separate files: the CLI writes the store, the daemon the state).
// ---------------------------------------------------------------------------

export type Source = "cron";

export interface StoreEntry extends Schedule {
  source: Source;
  /** epoch ms the entry was added: nothing before it is due */
  since: number;
}

export interface Store {
  version: 1;
  entries: StoreEntry[];
}

export interface RunState {
  /** last time the daemon finished a tick (epoch ms) */
  lastTick: number;
  /** per name: last fire */
  last: Record<string, { at: number; ok: boolean; code: number }>;
}

export function storeFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.AY_SCHEDULES_STORE || path.join(home, ".config", "agent-yes", "schedules.json");
}

export function stateFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return (
    env.AY_SCHEDULES_STATE ||
    path.join(home, ".local", "share", "agent-yes", "schedules.state.json")
  );
}

export function parseStore(text: string | null): Store {
  if (!text) return { version: 1, entries: [] };
  const j = JSON.parse(text);
  return { version: 1, entries: Array.isArray(j?.entries) ? j.entries : [] };
}

export function parseState(text: string | null): RunState {
  try {
    const j = text ? JSON.parse(text) : {};
    return {
      lastTick: Number(j.lastTick) || 0,
      last: j.last && typeof j.last === "object" ? j.last : {},
    };
  } catch {
    return { lastTick: 0, last: {} };
  }
}

/** Next free cron-entry id: c1, c2, … */
export function nextCronId(store: Store): string {
  let n = 1;
  while (store.entries.some((e) => e.name === `c${n}`)) n++;
  return `c${n}`;
}

/** Window in which a due fire still counts as on time (not missed). */
export const ON_TIME_MS = 90_000;

/**
 * One scheduler tick: which entries fire now. For each enabled entry, a fire is
 * due if a cron time falls in (max(lastTick, since, last run), now]. If the most
 * recent due time is within ON_TIME_MS it is on time and fires; otherwise it was
 * missed (daemon down / machine asleep) and fires once only when missed=run-once.
 */
export function dueNow(entries: StoreEntry[], state: RunState, now: number): StoreEntry[] {
  const out: StoreEntry[] = [];
  for (const e of entries) {
    if (!e.enabled) continue;
    const from = Math.max(state.lastTick, e.since, state.last[e.name]?.at ?? 0);
    const first = nextRuns(e.cron, e.tz, from, 1)[0];
    if (first == null || first > now) continue;
    // the latest slot at or before now (a */1 cron has two in the window)
    const recent = nextRuns(e.cron, e.tz, now - ON_TIME_MS, 3)
      .filter((t) => t <= now)
      .at(-1);
    const onTime = recent != null && recent <= now && recent > from;
    if (onTime || e.missed === "run-once") out.push(e);
  }
  return out;
}

/**
 * Longest single sleep. The daemon sleeps until the earliest next fire (no polling),
 * but never longer than this, so a wall-clock jump or a suspend is noticed within a day.
 */
export const MAX_SLEEP_MS = 24 * 3600e3;

/** How long to sleep from `now` until the earliest next fire of any enabled entry. */
export function wakeDelay(entries: StoreEntry[], now: number): number {
  let best = Infinity;
  for (const e of entries) {
    if (!e.enabled) continue;
    const t = nextRuns(e.cron, e.tz, now, 1)[0];
    if (t != null && t < best) best = t;
  }
  return best === Infinity ? MAX_SLEEP_MS : Math.min(MAX_SLEEP_MS, Math.max(0, best - now + 50));
}

/**
 * One wake-up, judged by the wall clock: what fires, and the new state. A clock
 * that jumped backwards (lastTick in the future) resets lastTick to now, so
 * nothing replays and the schedule resumes from the new time. A jump forwards
 * or a suspend is a plain "slept past the slot": skip, or run-once.
 */
export function tick(
  entries: StoreEntry[],
  state: RunState,
  now: number,
): { fire: StoreEntry[]; state: RunState; clockBack: boolean } {
  const clockBack = state.lastTick > now;
  const last = Object.fromEntries(
    Object.entries(state.last).map(([k, v]) => [k, v.at > now ? { ...v, at: now } : v]),
  );
  const st: RunState = { lastTick: clockBack ? now : state.lastTick || now - 60000, last };
  return { fire: dueNow(entries, st, now), state: { ...st, lastTick: now }, clockBack };
}

// ---------------------------------------------------------------------------
// Daemon autostart (one `ay schedules daemon run` per machine)
// ---------------------------------------------------------------------------

export const DAEMON_NAME = "agent-yes-schedulerd";

export function systemdDaemonUnit(argv: string[], pathEnv: string): string {
  const q = (s: string) =>
    /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"`;
  return (
    `[Unit]\nDescription=agent-yes scheduler (ay schedules / ay cron)\n\n` +
    `[Service]\nExecStart=${argv.map(q).join(" ")}\nEnvironment=${q(`PATH=${pathEnv}`)}\n` +
    `Restart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`
  );
}

export function launchdDaemonPlist(argv: string[], pathEnv: string, logPath: string): string {
  const x = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.agent-yes.schedulerd</string>\n` +
    `  <key>ProgramArguments</key>\n  <array>\n${argv.map((a) => `    <string>${x(a)}</string>\n`).join("")}  </array>\n` +
    `  <key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>${x(pathEnv)}</string></dict>\n` +
    `  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n` +
    `  <key>StandardErrorPath</key><string>${x(logPath)}</string>\n` +
    `</dict>\n</plist>\n`
  );
}

/** Windows Task Scheduler: start at logon, restart is handled by the daemon's own lock. */
export function windowsTaskArgs(argv: string[]): string[] {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return ["/Create", "/F", "/SC", "ONLOGON", "/TN", DAEMON_NAME, "/TR", argv.map(q).join(" ")];
}

export type AutostartKind = "oxmgr" | "systemd" | "launchd" | "schtasks" | "nohup";

/** Pick how to keep the daemon alive: the existing oxmgr runner first, then per-OS. */
export function pickAutostart(o: {
  platform: string;
  hasOxmgr: boolean;
  systemdUser: boolean;
}): AutostartKind {
  if (o.hasOxmgr) return "oxmgr";
  if (o.platform === "darwin") return "launchd";
  if (o.platform === "win32") return "schtasks";
  if (o.platform === "linux" && o.systemdUser) return "systemd";
  return "nohup";
}
// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type Target = { kind: "lane"; lane: string } | { kind: "agent"; ref: string };

export function parseTarget(t: string): Target {
  const s = t.trim();
  return s.startsWith("lane:")
    ? { kind: "lane", lane: s.slice(5).trim() }
    : { kind: "agent", ref: s };
}

export interface LiveRef {
  pid: number;
  agent_id: string;
  cwd: string;
}

export type TargetResolution = { ok: true; agentId: string } | { ok: false; error: string };

/**
 * Resolve a target to a live agent id. `laneId` answers `ay lanes id <name>`.
 * An agent ref matches an exact agent_id or pid, else a unique agent_id prefix,
 * else a unique cwd containing it (a keyword).
 */
export function resolveTarget(
  target: string,
  live: LiveRef[],
  laneId: (lane: string) => { ok: boolean; out: string },
): TargetResolution {
  const t = parseTarget(target);
  if (t.kind === "lane") {
    const r = laneId(t.lane);
    const id = r.out.trim();
    return r.ok && id
      ? { ok: true, agentId: id }
      : { ok: false, error: `lane "${t.lane}" has no live agent${id ? `: ${id}` : ""}` };
  }
  const ref = t.ref;
  const exact = live.filter((a) => a.agent_id === ref || String(a.pid) === ref);
  const tiers = [
    exact,
    live.filter((a) => a.agent_id.startsWith(ref)),
    live.filter((a) => a.cwd.includes(ref)),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return { ok: true, agentId: hits[0]!.agent_id };
    if (hits.length > 1)
      return {
        ok: false,
        error: `"${ref}" matches ${hits.length} live agents (${hits.map((a) => a.pid).join(", ")}); be more specific`,
      };
  }
  return { ok: false, error: `no live agent matches "${ref}"` };
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  name: string;
  target: string;
  agent_id?: string;
  ok: boolean;
  code: number;
  error?: string;
  manual?: boolean;
  host?: string;
}

// ---------------------------------------------------------------------------
// `ay cron` argument parsing
// ---------------------------------------------------------------------------

/** `ay cron "<cron>" <target> <message...>` → a new entry (name filled by the caller). */
export function parseCronAdd(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
):
  | { ok: true; cron: string; tz: string; target: string; message: string }
  | { ok: false; error: string } {
  let args = argv;
  // also accept the cron unquoted: five fields then target then message
  if (args.length >= 7 && !/\s/.test(args[0]!) && cronError(args.slice(0, 5).join(" ")) == null)
    args = [args.slice(0, 5).join(" "), ...args.slice(5)];
  const [cron, target, ...msg] = args;
  if (!cron || !target || !msg.length)
    return { ok: false, error: `usage: ay cron "<cron>" <target> <message...>` };
  const e = cronError(cron);
  if (e) return { ok: false, error: `bad cron "${cron}": ${e}` };
  const tz = env.AY_CRON_TZ || DEFAULT_TZ;
  if (!validTz(tz)) return { ok: false, error: `unknown tz "${tz}" (AY_CRON_TZ)` };
  if (target.startsWith("lane:") && !target.slice(5).trim())
    return { ok: false, error: `target "lane:" needs a lane name` };
  return { ok: true, cron: cron.trim().replace(/\s+/g, " "), tz, target, message: msg.join(" ") };
}

/** Rows of `oxmgr list` output that are legacy `ay schedule` jobs. */
export function legacyRows(oxmgrList: string): string[] {
  return oxmgrList.split("\n").filter((l) => l.includes("agent-yes-cron-"));
}
