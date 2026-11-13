import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  claudeProjectDir,
  lanesFile,
  normalizeName,
  parseDuration,
  parseLanes,
  parseLive,
  pickForLs,
  pickSession,
  planResume,
  promptTag,
  resolveLane,
  resumeNote,
  type LiveAgent,
} from "./lanes.ts";

const HOME = "/home/alice";
const TSV = [
  "# name\tcwd\thost",
  "alpha\twork/acme/tree/main",
  "beta\twork/acme/tree/main",
  "gamma\twork/other\tbuild-box",
  "broken-line-without-tab",
  "",
].join("\n");
const lanes = parseLanes(TSV);
const agent = (o: Partial<LiveAgent>): LiveAgent => ({
  started_at: 1,
  pid: 1111,
  agent_id: "id-1111",
  cwd: `${HOME}/work/acme/tree/main`,
  tag: null,
  ...o,
});

describe("parsing", () => {
  it("parses the TSV registry, skipping comments and malformed lines", () => {
    expect(lanes).toEqual([
      { name: "alpha", rel: "work/acme/tree/main", host: "" },
      { name: "beta", rel: "work/acme/tree/main", host: "" },
      { name: "gamma", rel: "work/other", host: "build-box" },
    ]);
  });
  it("locates the registry from AY_LANES_FILE, else ~/.config/agent-yes", () => {
    expect(lanesFile({ AY_LANES_FILE: "/x/l.tsv" })).toBe("/x/l.tsv");
    expect(lanesFile({})).toMatch(/\.config\/agent-yes\/lanes\.tsv$/);
  });
  it("normalizes [name@host] forms and reads prompt tags", () => {
    expect(normalizeName("[alpha@box]")).toBe("alpha");
    expect(promptTag("You are the [beta@x] lane")).toBe("beta");
    expect(promptTag("hello")).toBe(null);
  });
  it("keeps only live records, newest first", () => {
    const live = parseLive([
      { started_at: 1, pid: 1, agent_id: "a", cwd: "/a", prompt: "" },
      { started_at: 3, pid: 3, agent_id: "c", cwd: "/a", prompt: "You are the [alpha" },
      { started_at: 2, pid: 2, agent_id: "b", cwd: "/a", state: "exited" },
    ]);
    expect(live.map((a) => a.pid)).toEqual([3, 1]);
    expect(live[0]!.tag).toBe("alpha");
  });
  it("parses durations (bare number = hours)", () => {
    expect(parseDuration("48h")).toBe(48 * 3600e3);
    expect(parseDuration("2d")).toBe(2 * 86400e3);
    expect(parseDuration("5")).toBe(5 * 3600e3);
    expect(parseDuration("x")).toBe(null);
  });
});

describe("resolveLane", () => {
  it("resolves the single live agent in the lane's cwd", () => {
    const r = resolveLane("alpha", lanes, [agent({})], HOME);
    expect(r).toEqual({ ok: true, agent: agent({}) });
  });
  it("shared cwd: the agent tagged with the lane name wins", () => {
    const live = [agent({ pid: 1, tag: "alpha" }), agent({ pid: 2, tag: "beta" })];
    const a = resolveLane("alpha", lanes, live, HOME);
    const b = resolveLane("[beta]", lanes, live, HOME);
    expect(a.ok && a.agent.pid).toBe(1);
    expect(b.ok && b.agent.pid).toBe(2);
  });
  it("refuses (4) when several untagged agents share the cwd", () => {
    const r = resolveLane("alpha", lanes, [agent({ pid: 1 }), agent({ pid: 2 })], HOME);
    expect(r.ok === false && r.code).toBe(4);
  });
  it("returns 3 when no agent is live in the cwd", () => {
    const r = resolveLane("alpha", lanes, [agent({ cwd: "/elsewhere" })], HOME);
    expect(r.ok === false && r.code).toBe(3);
  });
  it("unregistered name: exactly one tagged agent resolves, else 2 / 4", () => {
    const one = resolveLane("delta", lanes, [agent({ tag: "delta", cwd: "/z" })], HOME);
    expect(one.ok && one.agent.cwd).toBe("/z");
    const none = resolveLane("delta", lanes, [], HOME);
    expect(none.ok === false && none.code).toBe(2);
    const two = resolveLane(
      "delta",
      lanes,
      [agent({ tag: "delta" }), agent({ tag: "delta" })],
      HOME,
    );
    expect(two.ok === false && two.code).toBe(4);
  });
  it("ls picks tag match, else the newest (never refuses)", () => {
    const live = [agent({ pid: 2 }), agent({ pid: 1, tag: "beta" })];
    expect(pickForLs(lanes[1]!, live, HOME)?.pid).toBe(1);
    expect(pickForLs(lanes[0]!, live, HOME)?.pid).toBe(2);
  });
});

describe("resume session selection", () => {
  let home: string;
  const now = Date.now();
  const write = (dir: string, id: string, body: string, ageH: number) => {
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${id}.jsonl`);
    writeFileSync(f, body);
    const t = (now - ageH * 3600e3) / 1000;
    utimesSync(f, t, t);
  };
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ay-lanes-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("maps a cwd to Claude's project dir", () => {
    expect(claudeProjectDir("/home/alice/work/a.b", "/h")).toBe(
      "/h/.claude/projects/-home-alice-work-a-b",
    );
  });
  it("picks the newest session for an unshared cwd", () => {
    const d = claudeProjectDir(path.join(home, "work/other"), home);
    write(d, "old", "", 5);
    write(d, "new", "", 1);
    expect(pickSession(d, "gamma", false)?.id).toBe("new");
    expect(pickSession(path.join(home, "missing"), "gamma", false)).toBe(null);
  });
  it("shared cwd: prefers the session that mentions [name] most", () => {
    const d = claudeProjectDir(path.join(home, "work/acme/tree/main"), home);
    write(d, "s-alpha", "[alpha] [alpha] [beta]", 3);
    write(d, "s-beta", "[beta] [beta] [beta]", 2);
    write(d, "s-none", "nothing", 1);
    expect(pickSession(d, "alpha", true)?.id).toBe("s-alpha");
    expect(pickSession(d, "beta", true)?.id).toBe("s-beta");
    expect(pickSession(d, "zeta", true)?.id).toBe("s-none");
  });
  it("plans: skips live lanes and stale sessions, resumes the rest", () => {
    const reg = parseLanes(
      "alpha\twork/acme/tree/main\nbeta\twork/acme/tree/main\ngamma\twork/other\n",
    );
    const shared = claudeProjectDir(path.join(home, "work/acme/tree/main"), home);
    write(shared, "s-beta", "[beta]", 1);
    write(claudeProjectDir(path.join(home, "work/other"), home), "s-gamma", "", 72);
    const live = [agent({ pid: 7, cwd: path.join(home, "work/acme/tree/main"), tag: "alpha" })];
    const plans = planResume(reg, reg, live, home, 48 * 3600e3, now);
    expect(plans.map((p) => [p.lane, p.action, p.session?.id])).toEqual([
      ["alpha", "skip", undefined],
      ["beta", "resume", "s-beta"],
      ["gamma", "skip", "s-gamma"],
    ]);
    expect(plans[2]!.reason).toMatch(/max-age/);
  });
});

describe("edge cases", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ay-lanes-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("tolerates sparse records and missing prompts", () => {
    const live = parseLive([null, { pid: 5 }]);
    expect(live).toEqual([{ started_at: 0, pid: 5, agent_id: "", cwd: "", tag: null }]);
    expect(promptTag(undefined)).toBe(null);
    expect(pickForLs(lanes[0]!, [], HOME)).toBe(null);
  });
  it("empty project dir has no session", () => {
    mkdirSync(path.join(home, "p"));
    expect(pickSession(path.join(home, "p"), "alpha", true)).toBe(null);
  });
  it("plans skip ambiguous lanes and lanes without a session", () => {
    const reg = parseLanes("alpha\tw/a\nbeta\tw/b\n");
    const live = [
      agent({ pid: 1, cwd: path.join(home, "w/a") }),
      agent({ pid: 2, cwd: path.join(home, "w/a") }),
    ];
    const plans = planResume(reg, reg, live, home, 3600e3, Date.now());
    expect(plans[0]!.reason).toMatch(/refusing/);
    expect(plans[1]!.reason).toMatch(/no Claude session/);
  });
  it("the resume note names the lane", () => {
    expect(resumeNote("alpha")).toContain("[alpha]");
  });
});
