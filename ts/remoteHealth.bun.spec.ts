import { describe, expect, it } from "bun:test";
import {
  REMOTE_BACKOFF_BASE_MS,
  REMOTE_BACKOFF_MAX_MS,
  noteRemoteResult,
  pruneRemoteHealth,
  remoteBackoffMs,
  shouldSkipRemote,
} from "./remoteHealth.ts";

describe("remoteHealth.remoteBackoffMs", () => {
  it("doubles from the base and then holds at the cap", () => {
    expect(remoteBackoffMs(1)).toBe(REMOTE_BACKOFF_BASE_MS);
    expect(remoteBackoffMs(2)).toBe(REMOTE_BACKOFF_BASE_MS * 2);
    expect(remoteBackoffMs(3)).toBe(REMOTE_BACKOFF_BASE_MS * 4);
    expect(remoteBackoffMs(99)).toBe(REMOTE_BACKOFF_MAX_MS);
  });

  it("is zero for a host that has not failed — and this GUARDS the clause below", () => {
    // A streak of 0 must never produce a wait: that is the difference between
    // "healthy" and "failed once", and getting it wrong skips a live host.
    expect(remoteBackoffMs(0)).toBe(0);
    expect(remoteBackoffMs(-1)).toBe(0);

    // This is also the tripwire for `shouldSkipRemote`'s `streak <= 0` clause.
    // That clause is UNREACHABLE while this holds, which is why no test can
    // redden it directly — but change the curve so a non-positive streak yields
    // a non-zero wait and the clause goes LIVE, with nothing behind it, at the
    // exact moment someone is editing the thing it guards. So the invariant is
    // pinned HERE, where it is reachable and can fail loudly, instead.
  });

  it("does not overflow on an absurd streak", () => {
    // 2 ** 5000 is Infinity; the shift clamp is what keeps this finite.
    expect(Number.isFinite(remoteBackoffMs(5000))).toBe(true);
  });
});

describe("remoteHealth.shouldSkipRemote", () => {
  const NOW = 1_000_000_000;

  it("never skips a host with no record — the control that matters", () => {
    // Wrongly skipping makes an agent silently vanish from `ay ls`; wrongly
    // probing costs one slow list. Those are not symmetric, so the tie goes to
    // probing, and an unknown host is always probed.
    expect(shouldSkipRemote(undefined, NOW)).toBe(false);
    // A cleared host carrying a stale timestamp — what `noteRemoteResult`
    // produces on success — must also never be skipped. This asserts the
    // BEHAVIOUR; it does not isolate the `streak <= 0` clause, which is
    // redundant with `remoteBackoffMs(0) === 0` and cannot be reddened on its
    // own. Said plainly rather than left looking like coverage it is not.
    expect(shouldSkipRemote({ streak: 0, lastFailedAt: NOW - 1 }, NOW)).toBe(false);
    expect(shouldSkipRemote({ streak: -3, lastFailedAt: NOW - 1 }, NOW)).toBe(false);
  });

  it("skips inside the backoff window and probes again once it elapses", () => {
    const h = { streak: 1, lastFailedAt: NOW };
    expect(shouldSkipRemote(h, NOW + REMOTE_BACKOFF_BASE_MS - 1)).toBe(true);
    expect(shouldSkipRemote(h, NOW + REMOTE_BACKOFF_BASE_MS)).toBe(false);
  });

  it("probes rather than guesses when the clock has moved backwards", () => {
    // A backwards clock makes `elapsed` negative, which would otherwise read as
    // "still inside the window" and skip the host until the clock caught up.
    expect(shouldSkipRemote({ streak: 3, lastFailedAt: NOW }, NOW - 60_000)).toBe(false);
  });
});

describe("remoteHealth.readRemoteHealth validation", () => {
  it("ignores an entry whose shape it cannot trust", async () => {
    // The file is derived data in a writable path. A valid-JSON record with a
    // plausible-looking streak must not be able to hide a live agent, so
    // anything that is not two finite numbers is dropped rather than trusted.
    const { mkdtemp, writeFile } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const path = (await import("path")).default;
    const dir = await mkdtemp(path.join(tmpdir(), "ay-health-"));
    const saved = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = dir;
    try {
      await writeFile(
        path.join(dir, "remote-health.json"),
        JSON.stringify({
          good: { streak: 2, lastFailedAt: 123 },
          missingField: { streak: 2 },
          wrongType: { streak: "9", lastFailedAt: 1 },
          notFinite: { streak: Number.POSITIVE_INFINITY, lastFailedAt: 1 },
          notAnObject: 7,
        }),
      );
      const { readRemoteHealth } = await import("./remoteHealth.ts");
      expect(await readRemoteHealth()).toEqual({ good: { streak: 2, lastFailedAt: 123 } });
    } finally {
      if (saved === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = saved;
    }
  });
});

describe("remoteHealth.pruneRemoteHealth", () => {
  it("drops aliases no longer configured, so the file cannot grow forever", () => {
    const h = {
      live: { streak: 1, lastFailedAt: 5 },
      removed: { streak: 9, lastFailedAt: 5 },
    };
    expect(pruneRemoteHealth(h, ["live"])).toEqual({ live: { streak: 1, lastFailedAt: 5 } });
    expect(pruneRemoteHealth(h, [])).toEqual({});
  });
});

describe("remoteHealth.noteRemoteResult", () => {
  const NOW = 1_000_000_000;

  it("clears the streak completely on success", () => {
    // A host that comes back must return to full speed immediately, not decay
    // through the backoff it earned while it was down.
    expect(noteRemoteResult({ streak: 9, lastFailedAt: NOW }, true, NOW + 1)).toEqual({
      streak: 0,
      lastFailedAt: 0,
    });
  });

  it("extends the streak on failure, from no record and from an existing one", () => {
    expect(noteRemoteResult(undefined, false, NOW)).toEqual({ streak: 1, lastFailedAt: NOW });
    expect(noteRemoteResult({ streak: 2, lastFailedAt: 1 }, false, NOW)).toEqual({
      streak: 3,
      lastFailedAt: NOW,
    });
  });
});
