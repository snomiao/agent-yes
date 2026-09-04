import { describe, expect, it } from "bun:test";
import {
  ageMatchesRegistration,
  ancestorPids,
  findAgentAncestor,
  parseEtime,
  parseProcessTable,
} from "./senderAncestry.ts";

const table = (pairs: [number, number][]) => async () =>
  new Map(pairs.map(([pid, ppid]) => [pid, { ppid, ageSecs: 9_999 }]));

describe("parseProcessTable", () => {
  it("reads the pid/ppid/etime columns ps prints", () => {
    const t = parseProcessTable("  501   1 01-21:37:19\n  777 501 05:04\n 1234   777 00:02\n");
    expect(t.get(501)).toEqual({ ppid: 1, ageSecs: 164239 });
    expect(t.get(1234)).toEqual({ ppid: 777, ageSecs: 2 });
  });

  it("drops any row it cannot fully parse", () => {
    // A header, a blank line, a truncated read, or an unparsable etime must not
    // become an edge — a row with a bogus age would defeat the reuse guard.
    const t = parseProcessTable("  PID PPID ELAPSED\n\n  501 1 05:04\ngarbage\n 12 13 nope\n");
    expect([...t.keys()]).toEqual([501]);
  });
});

describe("ancestorPids", () => {
  it("walks parents nearest-first", async () => {
    expect(
      await ancestorPids(400, { readTable: table([[400, 300], [300, 200], [200, 100], [100, 1]]) }),
    ).toEqual([300, 200, 100]);
  });

  it("stops at pid 1 rather than reporting the init process", async () => {
    expect(await ancestorPids(50, { readTable: table([[50, 1]]) })).toEqual([]);
  });

  it("terminates on a cycle instead of spinning", async () => {
    // pid reuse can produce a table that loops; a spin here hangs every send.
    expect(await ancestorPids(10, { readTable: table([[10, 20], [20, 30], [30, 10]]) })).toEqual([
      20, 30,
    ]);
  });

  it("respects the hop bound", async () => {
    const chain: [number, number][] = [];
    for (let i = 1; i <= 100; i++) chain.push([i, i + 1]);
    expect(await ancestorPids(1, { readTable: table(chain), maxHops: 5 })).toHaveLength(5);
  });

  it("answers 'cannot establish' rather than throwing when ps fails", async () => {
    // Provenance is best-effort by design: a failure here must never block a send.
    const boom = async () => {
      throw new Error("ps: command not found");
    };
    expect(await ancestorPids(400, { readTable: boom })).toEqual([]);
  });

  it("returns nothing for a process with no visible parent", async () => {
    expect(await ancestorPids(999, { readTable: table([[1, 0]]) })).toEqual([]);
  });
});

describe("findAgentAncestor", () => {
  const chain = table([[400, 300], [300, 200], [200, 100], [100, 1]]);

  it("finds a registered ancestor however many hops up", async () => {
    expect(await findAgentAncestor(400, (p) => (p === 100 ? "lane-A" : null), { readTable: chain }))
      .toBe("lane-A");
  });

  it("prefers the NEAREST enclosing agent", async () => {
    // With nested lanes, the closest one is the process that actually made the
    // call; attributing to an outer lane would name the wrong sender.
    expect(
      await findAgentAncestor(400, (p) => (p === 300 || p === 100 ? `lane-${p}` : null), {
        readTable: chain,
      }),
    ).toBe("lane-300");
  });

  it("returns null when no ancestor is an agent — it must never invent one", async () => {
    // Filling this in with a plausible sender is the failure one level worse
    // than the anonymity it would paper over.
    expect(await findAgentAncestor(400, () => null, { readTable: chain })).toBeNull();
  });

  it("does not attribute the caller to ITSELF", async () => {
    // The walk starts at the parent: a bare `ay send` is not its own sender.
    expect(await findAgentAncestor(400, (p) => (p === 400 ? "self" : null), { readTable: chain }))
      .toBeNull();
  });
});

describe("parseEtime", () => {
  it("reads every POSIX etime shape", () => {
    expect(parseEtime("05:04")).toBe(304);
    expect(parseEtime("01:05:04")).toBe(3904);
    expect(parseEtime("01-21:37:19")).toBe(164239);
    expect(parseEtime("   00:00 ")).toBe(0);
  });

  it("returns null for a shape it does not recognize", () => {
    // A wrong number here would defeat the pid-reuse guard it feeds, so an
    // unfamiliar `ps` variant must degrade to "cannot check", not to a guess.
    for (const bad of ["", "-", "abc", "1:2:3:4", "12"]) expect(parseEtime(bad)).toBeNull();
  });
});

describe("ageMatchesRegistration", () => {
  const now = 1_000_000_000;

  it("accepts a process at least as old as its registration", () => {
    expect(ageMatchesRegistration(3600, now - 3600_000, now)).toBe(true);
    expect(ageMatchesRegistration(7200, now - 3600_000, now)).toBe(true);
  });

  it("REJECTS a process younger than the record — the pid was reused", () => {
    // The attack: an agent exits, the OS hands its number to something else,
    // and matching on the number alone would give that process the identity.
    expect(ageMatchesRegistration(10, now - 3600_000, now)).toBe(false);
  });

  it("tolerates the gap between a process starting and its record landing", () => {
    expect(ageMatchesRegistration(3595, now - 3600_000, now)).toBe(true);
  });

  it("declines when either side is unknown rather than assuming a match", () => {
    expect(ageMatchesRegistration(undefined, now - 3600_000, now)).toBe(false);
    expect(ageMatchesRegistration(3600, undefined, now)).toBe(false);
  });
});
