import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  cacheAgeLabel,
  hhmm,
  humanizeAge,
  isStale,
  jsonRemote,
  noteSnapshotResult,
  parseWaitFor,
  readRemoteSnapshot,
  remoteCachePath,
  writeRemoteSnapshot,
  type RemoteSnapshot,
} from "./remoteCache.ts";

const T = 1_800_000_000_000;
const rows = [{ pid: 1111, cli: "claude", status: "active" }];
const good: RemoteSnapshot = {
  version: 1,
  alias: "alpha",
  fetchedAt: T,
  records: rows,
  error: null,
};

describe("noteSnapshotResult", () => {
  it("a success replaces the rows, stamps fetchedAt and clears the error", () => {
    const prev: RemoteSnapshot = {
      ...good,
      fetchedAt: T - 60_000,
      records: [],
      error: { message: "x", since: T - 30_000, lastTriedAt: T - 1 },
    };
    expect(noteSnapshotResult(prev, "alpha", { ok: true, records: rows }, T)).toEqual(good);
  });

  it("a failure keeps the last good rows and preserves when the streak began", () => {
    const first = noteSnapshotResult(good, "alpha", { ok: false, message: "timeout" }, T + 1000);
    expect(first.records).toBe(rows);
    expect(first.fetchedAt).toBe(T);
    expect(first.error).toEqual({ message: "timeout", since: T + 1000, lastTriedAt: T + 1000 });
    const second = noteSnapshotResult(first, "alpha", { ok: false, message: "refused" }, T + 5000);
    expect(second.error).toEqual({ message: "refused", since: T + 1000, lastTriedAt: T + 5000 });
  });

  it("a first-ever failure has no rows and starts the streak now", () => {
    const s = noteSnapshotResult(null, "beta", { ok: false, message: "dns" }, T);
    expect(s).toEqual({
      version: 1,
      alias: "beta",
      fetchedAt: null,
      records: [],
      error: { message: "dns", since: T, lastTriedAt: T },
    });
  });
});

describe("isStale", () => {
  it("treats no snapshot, never-fetched, old, and clock-backwards as stale", () => {
    expect(isStale(null, T)).toBe(true);
    expect(isStale({ ...good, fetchedAt: null }, T)).toBe(true);
    expect(isStale(good, T + 30_000)).toBe(true);
    expect(isStale(good, T - 1)).toBe(true);
  });
  it("serves fresh rows as-is", () => {
    expect(isStale(good, T + 29_999)).toBe(false);
    expect(isStale(good, T + 5_000, 1_000)).toBe(true);
  });
});

describe("labels", () => {
  it("humanizeAge keeps the table vocabulary", () => {
    expect(humanizeAge(500)).toBe("0s");
    expect(humanizeAge(59_000)).toBe("59s");
    expect(humanizeAge(60_000)).toBe("1m");
    expect(humanizeAge(3_600_000)).toBe("1h");
    expect(humanizeAge(2 * 86_400_000)).toBe("2d");
  });

  it("hhmm is zero-padded local wall-clock", () => {
    const d = new Date(2026, 0, 1, 9, 5);
    expect(hhmm(d.getTime())).toBe("09:05");
  });

  it("cacheAgeLabel says where the rows came from and never hides an outage", () => {
    expect(cacheAgeLabel(good, T + 180_000, true)).toBe("cached 3m ago, refreshing…");
    expect(cacheAgeLabel(good, T + 180_000, false)).toBe("cached 3m ago");
    expect(cacheAgeLabel(null, T, true)).toBe("no cache yet, refreshing…");
    const since = new Date(2026, 0, 1, 14, 2).getTime();
    const down: RemoteSnapshot = { ...good, error: { message: "x", since, lastTriedAt: since } };
    expect(cacheAgeLabel(down, T + 720_000, true)).toBe("cached 12m ago, unreachable since 14:02");
  });
});

describe("parseWaitFor", () => {
  const aliases = ["alpha", "beta"];
  it("expands all / local, and accepts a comma list of configured aliases", () => {
    expect(parseWaitFor("all", aliases)).toEqual({ local: true, remotes: ["alpha", "beta"] });
    expect(parseWaitFor("local", aliases)).toEqual({ local: true, remotes: [] });
    expect(parseWaitFor("beta", aliases)).toEqual({ local: false, remotes: ["beta"] });
    expect(parseWaitFor(" alpha, beta ,alpha", aliases)).toEqual({
      local: false,
      remotes: ["alpha", "beta"],
    });
  });
  it("refuses an unknown alias or an empty value rather than waiting for nothing", () => {
    expect(parseWaitFor("gamma", aliases)).toMatchObject({
      error: expect.stringContaining("gamma"),
    });
    expect(parseWaitFor("", aliases)).toMatchObject({
      error: expect.stringContaining("--waitFor"),
    });
    expect(parseWaitFor("x", [])).toMatchObject({ error: expect.stringContaining("none") });
  });
});

describe("jsonRemote", () => {
  it("exposes fetchedAt, stale and age so a parser can decide", () => {
    expect(jsonRemote(good, T + 1000)).toEqual({
      fetchedAt: T,
      stale: false,
      ageMs: 1000,
      error: null,
      records: rows,
    });
    expect(jsonRemote(null, T)).toEqual({
      fetchedAt: null,
      stale: true,
      ageMs: null,
      error: null,
      records: [],
    });
  });
});

describe("snapshot files", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-remote-cache-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it("round-trips, encodes an unsafe alias into the file name, and leaves no temp file", async () => {
    const snap: RemoteSnapshot = { ...good, alias: "a/b c" };
    await writeRemoteSnapshot(snap);
    expect(remoteCachePath("a/b c")).toBe(path.join(home, "remotes", "a%2Fb%20c.cache.json"));
    expect(await readRemoteSnapshot("a/b c")).toEqual(snap);
    expect(await readdir(path.join(home, "remotes"))).toEqual(["a%2Fb%20c.cache.json"]);
    expect(JSON.parse(await readFile(remoteCachePath("a/b c"), "utf-8")).version).toBe(1);
  });

  it("reads a missing, corrupt, or foreign file as a cold cache", async () => {
    expect(await readRemoteSnapshot("none")).toBeNull();
    await writeRemoteSnapshot(good);
    await writeFile(remoteCachePath("alpha"), "{not json");
    expect(await readRemoteSnapshot("alpha")).toBeNull();
    await writeFile(remoteCachePath("alpha"), JSON.stringify({ version: 2, records: [] }));
    expect(await readRemoteSnapshot("alpha")).toBeNull();
    await writeFile(remoteCachePath("alpha"), JSON.stringify([1, 2]));
    expect(await readRemoteSnapshot("alpha")).toBeNull();
  });

  it("tolerates a half-valid error object and a bad fetchedAt", async () => {
    await writeFile(
      remoteCachePath("alpha"),
      JSON.stringify({ version: 1, fetchedAt: "soon", records: rows, error: { message: "x" } }),
    ).catch(async () => {
      await writeRemoteSnapshot(good); // ensure the dir exists, then overwrite
      await writeFile(
        remoteCachePath("alpha"),
        JSON.stringify({ version: 1, fetchedAt: "soon", records: rows, error: { message: "x" } }),
      );
    });
    expect(await readRemoteSnapshot("alpha")).toEqual({
      version: 1,
      alias: "alpha",
      fetchedAt: null,
      records: rows,
      error: null,
    });
  });
});
