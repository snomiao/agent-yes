import { describe, expect, it } from "bun:test";
import {
  REMOTE_BACKOFF_BASE_MS,
  REMOTE_BACKOFF_MAX_MS,
  noteRemoteResult,
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

  it("is zero for a host that has not failed", () => {
    // A streak of 0 must never produce a wait: that is the difference between
    // "healthy" and "failed once", and getting it wrong skips a live host.
    expect(remoteBackoffMs(0)).toBe(0);
    expect(remoteBackoffMs(-1)).toBe(0);
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
