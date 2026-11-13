import { describe, expect, it } from "bun:test";
import path from "path";
import {
  type RunState,
  type StoreEntry,
  cronError,
  dueNow,
  fmtTime,
  launchdDaemonPlist,
  legacyRows,
  logFile,
  MAX_SLEEP_MS,
  nextCronId,
  nextRuns,
  parseCron,
  parseCronAdd,
  parseState,
  parseStore,
  pickAutostart,
  renderMessage,
  resolveTarget,
  stateFile,
  storeFile,
  systemdDaemonUnit,
  tick,
  validTz,
  wakeDelay,
  windowsTaskArgs,
} from "./schedules.ts";

const TZ = "Asia/Tokyo";
// 2026-01-05 (Mon) 00:00 Asia/Tokyo == 2026-01-04T15:00Z
const T0 = Date.UTC(2026, 0, 4, 15, 0);
const MIN = 60000;
const fmt = (ms: number[], tz = TZ) => ms.map((t) => fmtTime(t, tz).slice(0, 16));

function entry(over: Partial<StoreEntry> = {}): StoreEntry {
  return {
    name: "c1",
    cron: "*/5 * * * *",
    tz: TZ,
    target: "lane:alpha",
    message: "ping {name} at {now}",
    enabled: true,
    missed: "skip",
    source: "cron",
    since: 0,
    ...over,
  };
}

describe("parseCron", () => {
  it("expands steps, ranges, lists, names and dow 7", () => {
    const c = parseCron("*/15 9-11,14 1,15 jan-mar 5-7");
    expect(c.minute.values).toEqual([0, 15, 30, 45]);
    expect(c.minute.star).toBe(false);
    expect(c.hour.values).toEqual([9, 10, 11, 14]);
    expect(c.dom.values).toEqual([1, 15]);
    expect(c.month.values).toEqual([1, 2, 3]);
    expect(c.dow.values).toEqual([0, 5, 6]);
    expect(parseCron("* * * * *").dow.star).toBe(true);
    expect(parseCron("5/20 * * * MON").minute.values).toEqual([5, 25, 45]);
    expect(parseCron("0 0 * * */2").dow.values).toEqual([0, 2, 4, 6]);
    expect(parseCron("10-30/10 * * * *").minute.values).toEqual([10, 20, 30]);
  });
  it("rejects bad expressions", () => {
    expect(cronError("* * * *")).toMatch(/5 fields/);
    expect(cronError("60 * * * *")).toMatch(/minute: 60 out of range/);
    expect(cronError("* 5-2 * * *")).toMatch(/backwards/);
    expect(cronError("*/0 * * * *")).toMatch(/bad step/);
    expect(cronError("*/x * * * *")).toMatch(/bad step/);
    expect(cronError("1/2/3 * * * *")).toMatch(/bad term/);
    expect(cronError(", * * * *")).toMatch(/bad term/);
    expect(cronError("* * * foo *")).toMatch(/not a number/);
    expect(cronError("0 9 * * 1-5")).toBeNull();
  });
});

describe("nextRuns", () => {
  it("*/5 in the given tz", () => {
    expect(fmt(nextRuns("*/5 * * * *", TZ, T0, 3))).toEqual([
      "2026-01-05 00:05",
      "2026-01-05 00:10",
      "2026-01-05 00:15",
    ]);
  });
  it("ranges and lists; weekdays only", () => {
    // Fri 2026-01-09 17:40 -> next: Fri 18:00, then Mon 09:00
    const fri = Date.UTC(2026, 0, 9, 8, 40);
    expect(fmt(nextRuns("0,30 9-18 * * 1-5", TZ, fri, 3))).toEqual([
      "2026-01-09 18:00",
      "2026-01-09 18:30",
      "2026-01-12 09:00",
    ]);
  });
  it("same instant in another tz is a different wall clock", () => {
    const [ny] = nextRuns("0 9 * * *", "America/New_York", T0, 1);
    expect(new Date(ny!).toISOString()).toBe("2026-01-05T14:00:00.000Z");
    const [tk] = nextRuns("0 9 * * *", TZ, T0, 1);
    expect(new Date(tk!).toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });
  it("dom and dow both restricted: either matches (cron OR)", () => {
    // 2026-01-05 Mon: the 13th (Tue) OR Fridays
    expect(fmt(nextRuns("0 0 13 * 5", TZ, T0, 3))).toEqual([
      "2026-01-09 00:00",
      "2026-01-13 00:00",
      "2026-01-16 00:00",
    ]);
  });
  it("months and impossible dates", () => {
    expect(fmt(nextRuns("0 12 1 mar *", TZ, T0, 1))).toEqual(["2026-03-01 12:00"]);
    expect(nextRuns("0 0 31 2 *", TZ, T0, 1)).toEqual([]);
  });
});

describe("parseCronAdd", () => {
  it("parses quoted and unquoted cron", () => {
    expect(parseCronAdd(["*/10 * * * *", "lane:alpha", "send", "progress"], {})).toEqual({
      ok: true,
      cron: "*/10 * * * *",
      tz: TZ,
      target: "lane:alpha",
      message: "send progress",
    });
    const r = parseCronAdd(["0", "9", "*", "*", "1-5", "1111", "hi"], { AY_CRON_TZ: "UTC" });
    expect(r).toMatchObject({ ok: true, cron: "0 9 * * 1-5", tz: "UTC", target: "1111" });
  });
  it("validates", () => {
    expect(parseCronAdd(["* * * * *", "x"], {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/usage/),
    });
    expect(parseCronAdd(["61 * * * *", "x", "m"], {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/bad cron/),
    });
    expect(parseCronAdd(["* * * * *", "x", "m"], { AY_CRON_TZ: "Mars/Base" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown tz/),
    });
    expect(parseCronAdd(["* * * * *", "lane:", "m"], {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/lane name/),
    });
    expect(validTz(TZ)).toBe(true);
  });
});

describe("store", () => {
  it("parses store and state defensively", () => {
    expect(parseStore(null)).toEqual({ version: 1, entries: [] });
    expect(parseStore('{"entries":{}}').entries).toEqual([]);
    expect(parseStore(JSON.stringify({ entries: [entry()] })).entries[0]!.name).toBe("c1");
    expect(parseState(null)).toEqual({ lastTick: 0, last: {} });
    expect(parseState("{bad")).toEqual({ lastTick: 0, last: {} });
    expect(parseState('{"lastTick":5,"last":{"a":{"at":1,"ok":true,"code":0}}}').last.a!.ok).toBe(
      true,
    );
  });
  it("allocates ids", () => {
    expect(nextCronId({ version: 1, entries: [] })).toBe("c1");
    expect(
      nextCronId({ version: 1, entries: [entry({ name: "c1" }), entry({ name: "c3" })] }),
    ).toBe("c2");
  });
  it("paths honor env", () => {
    expect(storeFile({ AY_SCHEDULES_STORE: "/s" })).toBe("/s");
    expect(stateFile({ AY_SCHEDULES_STATE: "/t" })).toBe("/t");
    expect(logFile({ AY_SCHEDULES_LOG: "/l" })).toBe("/l");
    expect(storeFile({}, "/home/alice")).toBe(
      path.join("/home/alice", ".config", "agent-yes", "schedules.json"),
    );
    expect(stateFile({}, "/home/alice")).toMatch(/schedules\.state\.json$/);
    expect(logFile({}, "/home/alice")).toBe(
      path.join("/home/alice", ".local", "share", "agent-yes", "schedules.log"),
    );
  });
  it("renders messages", () => {
    expect(renderMessage(entry(), T0)).toBe("ping c1 at 2026-01-05 00:00 Asia/Tokyo");
  });
  it("legacy oxmgr rows", () => {
    expect(legacyRows("id name\n1 agent-yes-cron-a\n2 other\n")).toEqual(["1 agent-yes-cron-a"]);
  });
});

/** Run the daemon loop against a fake clock: one tick per minute, recording fires. */
function simulate(entries: StoreEntry[], st: RunState, from: number, minutes: number) {
  const fired: string[] = [];
  for (let i = 0; i < minutes; i++) {
    const now = from + i * MIN + 50;
    for (const e of dueNow(entries, st, now)) {
      fired.push(`${e.name}@${fmtTime(now, TZ).slice(11, 16)}`);
      st.last[e.name] = { at: now, ok: true, code: 0 };
    }
    st.lastTick = now;
  }
  return fired;
}

describe("scheduler loop (fake clock)", () => {
  it("fires */5 on time, once per slot", () => {
    const st: RunState = { lastTick: T0 - MIN, last: {} };
    expect(simulate([entry()], st, T0, 16)).toEqual([
      "c1@00:00",
      "c1@00:05",
      "c1@00:10",
      "c1@00:15",
    ]);
  });
  it("every minute fires every minute", () => {
    const st: RunState = { lastTick: T0 - 30000, last: {} };
    expect(simulate([entry({ cron: "* * * * *", since: T0 - 30000 })], st, T0, 3)).toEqual([
      "c1@00:00",
      "c1@00:01",
      "c1@00:02",
    ]);
  });
  it("does not fire before an entry was added", () => {
    const st: RunState = { lastTick: T0 - MIN, last: {} };
    expect(simulate([entry({ since: T0 + 2 * MIN })], st, T0, 6)).toEqual(["c1@00:05"]);
  });
  it("skips disabled entries", () => {
    expect(simulate([entry({ enabled: false })], { lastTick: T0 - MIN, last: {} }, T0, 10)).toEqual(
      [],
    );
  });
  it("restart after downtime: missed=skip fires nothing for the gap", () => {
    const st: RunState = { lastTick: T0, last: {} };
    // daemon down 00:01..00:32, restarts at 00:33
    expect(dueNow([entry()], st, T0 + 33 * MIN)).toEqual([]);
  });
  it("restart after downtime: missed=run-once fires exactly once", () => {
    const st: RunState = { lastTick: T0, last: {} };
    const e = entry({ cron: "0 * * * *", missed: "run-once" });
    expect(simulate([e], st, T0 + 200 * MIN, 3)).toEqual(["c1@03:20"]);
  });
  it("restart exactly on a slot still fires it (on time)", () => {
    const st: RunState = { lastTick: T0, last: {} };
    expect(dueNow([entry()], st, T0 + 30 * MIN + 50).map((e) => e.name)).toEqual(["c1"]);
  });
});

/**
 * Event-driven daemon on a fake clock: sleep wakeDelay(), unless the store changes
 * first (`changes`: at -> new entries) or the machine suspends (`suspend`: the
 * wake that was due at or after `from` happens at `until`).
 */
function runDaemon(
  initial: StoreEntry[],
  start: number,
  end: number,
  o: {
    changes?: [number, StoreEntry[]][];
    suspend?: { from: number; until: number };
    state?: RunState;
  } = {},
) {
  let entries = initial;
  let st: RunState = o.state ?? { lastTick: 0, last: {} };
  let now = start;
  const changes = [...(o.changes ?? [])];
  const fired: string[] = [];
  const wakes: string[] = [];
  let suspended = false;
  for (;;) {
    const t = tick(entries, st, now);
    for (const e of t.fire) {
      fired.push(`${e.name}@${fmtTime(now, TZ).slice(11, 16)}`);
      t.state.last[e.name] = { at: now, ok: true, code: 0 };
    }
    st = t.state;
    let next = now + wakeDelay(entries, now);
    if (changes.length && changes[0]![0] < next) {
      const [at, es] = changes.shift()!;
      next = at;
      entries = es;
    }
    if (o.suspend && !suspended && next >= o.suspend.from) {
      suspended = true;
      next = o.suspend.until;
    }
    if (next > end) break;
    now = next;
    wakes.push(fmtTime(now, TZ).slice(11, 16));
  }
  return { fired, wakes };
}

describe("daemon wake-ups (no polling)", () => {
  const hourly = entry({ name: "h", cron: "0 * * * *" });
  it("sleeps until the earliest next fire, capped at a day", () => {
    expect(wakeDelay([hourly, entry({ cron: "*/20 * * * *" })], T0 + 10 * MIN)).toBe(10 * MIN + 50);
    expect(wakeDelay([], T0)).toBe(MAX_SLEEP_MS);
    expect(wakeDelay([entry({ enabled: false })], T0)).toBe(MAX_SLEEP_MS);
    expect(wakeDelay([entry({ cron: "0 0 1 1 *" })], T0)).toBe(MAX_SLEEP_MS);
  });
  it("wakes only at fire times and re-arms after each", () => {
    const r = runDaemon([hourly], T0 + 10 * MIN, T0 + 3 * 60 * MIN + MIN);
    expect(r.fired).toEqual(["h@01:00", "h@02:00", "h@03:00"]);
    expect(r.wakes).toEqual(["01:00", "02:00", "03:00"]);
  });
  it("store changed while sleeping: re-plans at once", () => {
    const r = runDaemon([hourly], T0 + 10 * MIN, T0 + 51 * MIN, {
      changes: [[T0 + 31 * MIN, [hourly, entry({ name: "c2", since: T0 + 31 * MIN })]]],
    });
    expect(r.wakes.slice(0, 3)).toEqual(["00:31", "00:35", "00:40"]);
    expect(r.fired).toEqual(["c2@00:35", "c2@00:40", "c2@00:45", "c2@00:50"]);
  });
  it("slept past the slot (suspend): skip fires nothing, run-once fires once", () => {
    const sus = { from: T0 + 60 * MIN, until: T0 + 200 * MIN };
    const skip = runDaemon([hourly], T0 + 10 * MIN, T0 + 241 * MIN, { suspend: sus });
    expect(skip.fired).toEqual(["h@04:00"]);
    const once = runDaemon([{ ...hourly, missed: "run-once" }], T0 + 10 * MIN, T0 + 241 * MIN, {
      suspend: sus,
    });
    expect(once.fired).toEqual(["h@03:20", "h@04:00"]);
  });
  it("clock jumped backwards: no replay, resumes from the new time", () => {
    const st: RunState = {
      lastTick: T0 + 120 * MIN,
      last: { h: { at: T0 + 120 * MIN, ok: true, code: 0 } },
    };
    const t = tick([hourly], st, T0 + 30 * MIN);
    expect(t.clockBack).toBe(true);
    expect(t.fire).toEqual([]);
    expect(t.state.lastTick).toBe(T0 + 30 * MIN);
    const r = runDaemon([hourly], T0 + 30 * MIN, T0 + 61 * MIN, { state: st });
    expect(r.fired).toEqual(["h@01:00"]);
  });
  it("first start fires nothing missed", () => {
    expect(tick([entry()], { lastTick: 0, last: {} }, T0 + 2 * MIN + 50).fire).toEqual([]);
    expect(tick([entry()], { lastTick: 0, last: {} }, T0 + 50).fire.length).toBe(1);
  });
});

describe("resolveTarget", () => {
  const live = [
    { pid: 1111, agent_id: "abc123", cwd: "/repo/alpha" },
    { pid: 2222, agent_id: "abd456", cwd: "/repo/beta" },
  ];
  const lane = (ok: boolean, out: string) => () => ({ ok, out });
  it("lanes go through ay lanes id", () => {
    expect(resolveTarget("lane:alpha", live, lane(true, "zz9\n"))).toEqual({
      ok: true,
      agentId: "zz9",
    });
    expect(resolveTarget("lane:alpha", live, lane(false, "no live agent"))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/lane "alpha" has no live agent: no live agent/),
    });
    expect(resolveTarget("lane:alpha", live, lane(false, ""))).toEqual({
      ok: false,
      error: `lane "alpha" has no live agent`,
    });
  });
  it("agent id, pid, prefix, keyword", () => {
    expect(resolveTarget("abd456", live, lane(false, ""))).toEqual({ ok: true, agentId: "abd456" });
    expect(resolveTarget("1111", live, lane(false, ""))).toEqual({ ok: true, agentId: "abc123" });
    expect(resolveTarget("abc", live, lane(false, ""))).toEqual({ ok: true, agentId: "abc123" });
    expect(resolveTarget("beta", live, lane(false, ""))).toEqual({ ok: true, agentId: "abd456" });
    expect(resolveTarget("ab", live, lane(false, ""))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/matches 2/),
    });
    expect(resolveTarget("gamma", live, lane(false, ""))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no live agent/),
    });
  });
});

describe("daemon autostart", () => {
  it("prefers oxmgr, then the OS's own", () => {
    const p = (platform: string, hasOxmgr = false, systemdUser = false) =>
      pickAutostart({ platform, hasOxmgr, systemdUser });
    expect(p("linux", true, true)).toBe("oxmgr");
    expect(p("linux", false, true)).toBe("systemd");
    expect(p("linux")).toBe("nohup");
    expect(p("darwin")).toBe("launchd");
    expect(p("win32")).toBe("schtasks");
    expect(p("freebsd")).toBe("nohup");
  });
  it("renders units", () => {
    const u = systemdDaemonUnit(
      ["/opt/my bun", "/x/ay.js", "schedules", "daemon", "run"],
      "/usr/bin",
    );
    expect(u).toContain(`ExecStart="/opt/my bun" /x/ay.js schedules daemon run`);
    expect(u).toContain("Restart=always");
    const pl = launchdDaemonPlist(["/x/a&b", "run"], "/usr/bin", "/tmp/l");
    expect(pl).toContain("<string>/x/a&amp;b</string>");
    expect(pl).toContain("<key>KeepAlive</key><true/>");
    expect(windowsTaskArgs(["C:\\Program Files\\ay.exe", "run"])).toContain(
      `"C:\\Program Files\\ay.exe" run`,
    );
  });
});
