import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { startInlineHeartbeat, startOwnerHeartbeat, type OwnerHeartbeat } from "./ownerHeartbeat.ts";

// Issue #169 item 5. The daemon's proof-of-life is a `ts` it refreshes in the
// lock owner file; if that stamp goes stale another `ay notify watch` steals the
// lock and a second daemon starts. Two things must hold: the beat keeps
// refreshing while we own the lock, and it never writes once we don't.

const BEAT_MS = 30;
// Generous: a worker thread's cold start on a loaded CI box is unpredictable, so
// every positive assertion waits for a CONDITION rather than a fixed sleep.
const BUDGET_MS = 5_000;

const started: OwnerHeartbeat[] = [];
const track = (h: OwnerHeartbeat) => {
  started.push(h);
  return h;
};

afterEach(async () => {
  for (const h of started.splice(0)) await h.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => Promise<boolean>, budgetMs = BUDGET_MS): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

async function ownerFile(token: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "ay-beat-"));
  const file = path.join(dir, "owner.json");
  await writeFile(file, JSON.stringify({ pid: process.pid, token, ts: 1 }));
  return file;
}

const readOwner = async (file: string) =>
  JSON.parse(await readFile(file, "utf8")) as { ts: number; token?: string; [k: string]: unknown };

/** Resolves once the beat has stamped the file at least once. */
const beaten = (file: string) => waitFor(async () => (await readOwner(file)).ts > 1);

// Both implementations must behave identically — the fallback exists precisely
// so a runtime without workers is no worse off, which only holds if it agrees.
for (const [name, start] of [
  ["worker-isolated", startOwnerHeartbeat],
  ["inline fallback", startInlineHeartbeat],
] as const) {
  describe(`ownerHeartbeat — ${name}`, () => {
    it("refreshes ts while the owner still carries our token", async () => {
      const file = await ownerFile("tok-a");
      track(
        start({ ownerPath: file, token: "tok-a", payload: { token: "tok-a" }, intervalMs: BEAT_MS }),
      );
      expect(await beaten(file)).toBe(true);
    });

    it("preserves the fixed owner payload across beats", async () => {
      const file = await ownerFile("tok-b");
      const payload = { pid: 4242, started_at: 777, token: "tok-b", os_start: "abc" };
      track(start({ ownerPath: file, token: "tok-b", payload, intervalMs: BEAT_MS }));
      expect(await beaten(file)).toBe(true);
      const owner = await readOwner(file);
      expect(owner.pid).toBe(4242);
      expect(owner.started_at).toBe(777);
      expect(owner.os_start).toBe("abc");
    });

    it("never writes when the owner carries a DIFFERENT token (fencing)", async () => {
      // Supersede the owner BEFORE the beat can start, so its very first read
      // already sees a token that isn't ours. Deterministic by construction —
      // no dependence on where a beat happens to land.
      const file = await ownerFile("mine");
      await writeFile(file, JSON.stringify({ pid: 1, token: "theirs", ts: 999 }));
      track(
        start({ ownerPath: file, token: "mine", payload: { token: "mine" }, intervalMs: BEAT_MS }),
      );
      await sleep(BEAT_MS * 10);
      const owner = await readOwner(file);
      expect(owner.token).toBe("theirs"); // never overwritten by us
      expect(owner.ts).toBe(999); // never re-stamped
    });

    it("does not resurrect the owner after the lock DIRECTORY is removed", async () => {
      // `ay notifyd stop` is cooperative: it removes the lock DIRECTORY rather
      // than signalling a possibly-recycled pid. Removing the directory (not just
      // owner.json) is what makes the removal stick — the beat writes via a temp
      // file inside that directory, so a beat already past its token read fails at
      // the rename instead of resurrecting an owner file it no longer owns.
      const file = await ownerFile("tok-c");
      track(
        start({ ownerPath: file, token: "tok-c", payload: { token: "tok-c" }, intervalMs: BEAT_MS }),
      );
      expect(await beaten(file)).toBe(true);
      await rm(path.dirname(file), { recursive: true, force: true });
      await sleep(BEAT_MS * 10);
      await expect(readFile(file, "utf8")).rejects.toThrow(); // stayed gone
    });

    it("stop() halts further refreshes", async () => {
      const file = await ownerFile("tok-d");
      const h = start({
        ownerPath: file,
        token: "tok-d",
        payload: { token: "tok-d" },
        intervalMs: BEAT_MS,
      });
      expect(await beaten(file)).toBe(true);
      await h.stop();
      const frozen = (await readOwner(file)).ts;
      await sleep(BEAT_MS * 10);
      expect((await readOwner(file)).ts).toBe(frozen);
    });
  });
}

describe("ownerHeartbeat — isolation", () => {
  it("runs on its own thread, so a blocked main thread cannot stall it", async () => {
    const file = await ownerFile("tok-e");
    const h = track(
      startOwnerHeartbeat({
        ownerPath: file,
        token: "tok-e",
        payload: { token: "tok-e" },
        intervalMs: BEAT_MS,
      }),
    );
    expect(h.isolated).toBe(true);
    expect(await beaten(file)).toBe(true); // worker is up and beating
    const before = (await readOwner(file)).ts;
    // Block the main thread SYNCHRONOUSLY for many beat intervals — the exact
    // failure mode a single-threaded timer cannot survive. An inline timer would
    // not have fired once in this window; the worker must stamp right through it.
    const until = Date.now() + BEAT_MS * 12;
    while (Date.now() < until) {
      /* deliberate busy-wait */
    }
    expect((await readOwner(file)).ts).toBeGreaterThan(before);
  });

  it("the fallback reports that it is not isolated", async () => {
    const file = await ownerFile("tok-f");
    const h = track(
      startInlineHeartbeat({
        ownerPath: file,
        token: "tok-f",
        payload: { token: "tok-f" },
        intervalMs: BEAT_MS,
      }),
    );
    expect(h.isolated).toBe(false);
  });
});
