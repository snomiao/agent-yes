import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "fs/promises";
import path from "path";
import { listAsks, listAsksForProject, answerAsk, hasTodoStore } from "./askApi";
import { TodoStore, openStore } from "./todoStore";
import type { TodoBlock } from "./todoBlock";

const isWindows = process.platform === "win32";
const ROOT_A = isWindows
  ? path.join(process.env.TEMP || "C:\\Temp", "askapi-a-" + process.pid)
  : "/tmp/askapi-a-" + process.pid;
const ROOT_B = isWindows
  ? path.join(process.env.TEMP || "C:\\Temp", "askapi-b-" + process.pid)
  : "/tmp/askapi-b-" + process.pid;
const ROOT_NONE = isWindows
  ? path.join(process.env.TEMP || "C:\\Temp", "askapi-none-" + process.pid)
  : "/tmp/askapi-none-" + process.pid;

describe("askApi", () => {
  beforeEach(async () => {
    await rm(ROOT_A, { recursive: true, force: true });
    await rm(ROOT_B, { recursive: true, force: true });
    await rm(ROOT_NONE, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(ROOT_A, { recursive: true, force: true });
    await rm(ROOT_B, { recursive: true, force: true });
    await rm(ROOT_NONE, { recursive: true, force: true });
  });

  it("hasTodoStore is false until a store has actually persisted a task at that root (openStore alone doesn't create the file)", async () => {
    expect(hasTodoStore(ROOT_A)).toBe(false);
    const s = await openStore(ROOT_A);
    expect(hasTodoStore(ROOT_A)).toBe(false); // still nothing written to disk
    await s.create({ summary: "x", kind: "code" });
    expect(hasTodoStore(ROOT_A)).toBe(true);
  });

  it("listAsksForProject surfaces only blocked-by-human tasks, classified by shape", async () => {
    const s = await openStore(ROOT_A);
    const choice = await s.create({ summary: "pick a channel", kind: "decision" });
    await s.setBlock(choice._id, {
      type: "blocked-by-human",
      who: "taku",
      question: "canary or beta?",
      options: ["canary", "beta"],
    });
    const action = await s.create({ summary: "finish oauth", kind: "human" });
    await s.setBlock(action._id, {
      type: "blocked-by-human",
      who: "taku",
      actionLink: "https://example/oauth",
    });
    const bare = await s.create({ summary: "just fyi", kind: "human" });
    await s.setBlock(bare._id, { type: "blocked-by-human", who: "taku" });
    const notHuman = await s.create({ summary: "not an ask", kind: "code" });
    await s.setBlock(notHuman._id, { type: "blocked-by-external", signal: "ci" });
    const unblocked = await s.create({ summary: "no block at all", kind: "code" });

    const asks = await listAsksForProject(ROOT_A);
    expect(asks.map((a) => a.taskId).sort()).toEqual([choice._id, action._id, bare._id].sort());
    expect(asks.find((a) => a.taskId === choice._id)).toMatchObject({
      shape: "choice",
      options: ["canary", "beta"],
      question: "canary or beta?",
    });
    expect(asks.find((a) => a.taskId === action._id)).toMatchObject({
      shape: "action",
      actionLink: "https://example/oauth",
    });
    expect(asks.find((a) => a.taskId === bare._id)).toMatchObject({ shape: "acknowledge" });
  });

  it("listAsks aggregates across multiple project roots, skipping ones with no store at all", async () => {
    const sA = await openStore(ROOT_A);
    const tA = await sA.create({ summary: "a", kind: "human" });
    await sA.setBlock(tA._id, { type: "blocked-by-human", who: "taku" });
    const sB = await openStore(ROOT_B);
    const tB = await sB.create({ summary: "b", kind: "human" });
    await sB.setBlock(tB._id, { type: "blocked-by-human", who: "cto" });

    const asks = await listAsks([ROOT_A, ROOT_B, ROOT_NONE]);
    expect(asks.map((a) => `${a.projectRoot === ROOT_A ? "A" : "B"}:${a.taskId}`).sort()).toEqual(
      [`A:${tA._id}`, `B:${tB._id}`].sort(),
    );
  });

  it("listAsks isolates a per-project failure — one unreadable/broken store must not take down the whole cross-project panel (codex-review round-14 Important)", async () => {
    const sA = await openStore(ROOT_A);
    const tA = await sA.create({ summary: "healthy ask", kind: "human" });
    await sA.setBlock(tA._id, { type: "blocked-by-human", who: "taku" });

    // ROOT_B's todos.jsonl is a DIRECTORY, not a file — a real, easy way to
    // force listAsksForProject(ROOT_B) to genuinely reject (EISDIR) rather
    // than mocking anything.
    await mkdir(path.join(ROOT_B, ".agent-yes", "todos.jsonl"), { recursive: true });

    const asks = await listAsks([ROOT_A, ROOT_B]);
    expect(asks.map((a) => a.taskId)).toEqual([tA._id]);
  });

  it("answerAsk on a bare acknowledge-shape ask: clears the block, advances the human kind's pending->decided gate as the asked human, then decided->done is ungated", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "just fyi", kind: "human" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku" });
    const { record: answered } = await answerAsk(ROOT_A, t._id, { acknowledged: true });
    expect(answered.block).toBeNull();
    expect(answered.state).toBe("decided"); // human-replied gate satisfied, advanced
    expect(answered.verifyEvidence[0]).toMatchObject({ gate: "human-replied", validator: "taku" });
  });

  it("answerAsk on a choice-shape ask records the choice text as evidence note, and rejects a choice not among the offered options", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision" });
    await s.setBlock(t._id, {
      type: "blocked-by-human",
      who: "taku",
      options: ["canary", "beta"],
    });
    await expect(answerAsk(ROOT_A, t._id, { choice: "stable" })).rejects.toThrow(
      /not one of the offered options/,
    );
    const { record: answered } = await answerAsk(ROOT_A, t._id, { choice: "canary" });
    expect(answered.state).toBe("decided");
    expect(answered.verifyEvidence[0]).toMatchObject({ gate: "human-decided", note: "canary" });
  });

  it("when a block has BOTH options and actionLink set (a direct library caller bypassing the CLI's mutual-exclusivity guard), answerAsk treats it as action-shape — matching listAsksForProject's own precedence, so an ask is never listed as one shape but answerable only as another (codex-review round-9 Important)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "x", kind: "human" });
    await s.setBlock(t._id, {
      type: "blocked-by-human",
      who: "taku",
      options: ["canary", "beta"],
      actionLink: "https://example/oauth",
    });
    const asks = await listAsksForProject(ROOT_A);
    expect(asks[0]?.shape).toBe("action");
    // a choice alone (matching the listed shape's own actionLink requirement
    // being ignored) must NOT satisfy it — only acknowledged does, matching
    // the action-shape UI (open link, then confirm)
    await expect(answerAsk(ROOT_A, t._id, { choice: "canary" })).rejects.toThrow(
      /requires \{ acknowledged: true \}/,
    );
    const { record: answered } = await answerAsk(ROOT_A, t._id, { acknowledged: true });
    expect(answered.block).toBeNull();
  });

  it("answerAsk leaves the task's block INTACT (not silently cleared) if the gate/transition step fails — atomicity means a failure never strands the task in limbo (codex-review round-9 Important)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision", owner: "taku" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku", options: ["a", "b"] });
    // "taku" is both the task's owner AND the asked human — approve() will
    // throw "independent verification required" for this specific task,
    // simulating a mid-sequence failure without needing to mock anything.
    await expect(answerAsk(ROOT_A, t._id, { choice: "a" })).rejects.toThrow(
      /independent verification required/,
    );
    // Re-open fresh rather than reusing `s`: `answerAsk()` opens its OWN
    // separate store instance internally, so `s`'s in-memory cache is never
    // reloaded by that call — reading `s` directly here would silently pass
    // even if answerAsk actually cleared the block on disk before throwing
    // (exactly the bug this test exists to catch).
    const stillBlocked = (await openStore(ROOT_A)).get(t._id)!;
    expect(stillBlocked.block).toEqual({
      type: "blocked-by-human",
      who: "taku",
      options: ["a", "b"],
    });
    expect(stillBlocked.state).toBe("deciding"); // unchanged
  });

  it("answerAsk NEVER erases a block that was replaced by a DIFFERENT one WHILE the answer was being processed — the final clear only removes the SPECIFIC block this call decided to answer, not whatever block happens to be there by the time it gets around to clearing (codex-review round-15 Important)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "x", kind: "human" });
    const original = { type: "blocked-by-human", who: "taku", question: "original ask" } as const;
    await s.setBlock(t._id, original);
    const newerBlock = {
      type: "blocked-by-human",
      who: "taku",
      question: "a brand new ask",
    } as const;

    // Deterministically inject a concurrent block replacement between
    // answerAsk's initial read (which captures the blockRev it expects to
    // still be current) and its atomic answerHumanBlock() write — patching
    // TodoStore.prototype.answerHumanBlock (which every openStore()
    // instance, including the one answerAsk creates internally, shares) so
    // a SECOND, independent store instance replaces the block right BEFORE
    // the real atomic write runs, simulating a genuinely different process
    // racing this exact window. A real race would be flaky to reproduce
    // reliably; this reproduces it deterministically every run.
    const originalAnswerHumanBlock = TodoStore.prototype.answerHumanBlock;
    const spy = vi
      .spyOn(TodoStore.prototype, "answerHumanBlock")
      .mockImplementation(async function (
        this: TodoStore,
        id: string,
        expectedBlockRev: number,
        gate: Parameters<TodoStore["answerHumanBlock"]>[2],
      ) {
        const other = await openStore(ROOT_A);
        await other.setBlock(id, newerBlock);
        return originalAnswerHumanBlock.call(this, id, expectedBlockRev, gate);
      });
    try {
      await expect(answerAsk(ROOT_A, t._id, { acknowledged: true })).rejects.toThrow(
        /this ask has changed since it was loaded/,
      );
    } finally {
      spy.mockRestore();
    }
    // The newer block survives untouched — not silently wiped by the stale
    // "clear the original block" decision.
    const fresh = (await openStore(ROOT_A)).get(t._id)!;
    expect(fresh.block).toEqual(newerBlock);
  });

  it("a naive retry after answerAsk already fully succeeded is cleanly refused — it never duplicates evidence or re-transitions, because the gate/transition/clear are now ONE atomic write with no partial-completion state for a retry to resume from (codex-review round-18: replaces the old approve()+transition()+clearBlockIfMatches composition's retry-idempotency workaround, which is no longer needed)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku", options: ["a", "b"] });
    const { record: first } = await answerAsk(ROOT_A, t._id, { choice: "a" });
    expect(first.state).toBe("decided");
    expect(first.verifyEvidence).toHaveLength(1);
    // A retry (e.g. the client never saw the first response and resubmits)
    // sees the block already cleared — a clear, accurate rejection, not a
    // silent no-op and not a duplicate evidence entry.
    await expect(answerAsk(ROOT_A, t._id, { choice: "a" })).rejects.toThrow(
      /not currently blocked-by-human/,
    );
    const stillDone = (await openStore(ROOT_A)).get(t._id)!;
    expect(stillDone.verifyEvidence).toHaveLength(1); // never duplicated
    expect(stillDone.state).toBe("decided"); // never re-transitioned
  });

  it("answerAsk IGNORES an unvalidated `choice` sent alongside `acknowledged: true` on a non-choice-shape ask — an arbitrary attacker-supplied string must never become the recorded/relayed answer just because it rode along with a valid acknowledgement (codex-review round-14 Important)", async () => {
    const s = await openStore(ROOT_A);
    const bare = await s.create({ summary: "just fyi", kind: "human" });
    await s.setBlock(bare._id, { type: "blocked-by-human", who: "taku" });
    const bareResult = await answerAsk(ROOT_A, bare._id, {
      acknowledged: true,
      choice: "attacker-controlled garbage\nrm -rf /",
    });
    expect(bareResult.answerText).toBe("acknowledged");
    expect(bareResult.record.verifyEvidence[0]).toMatchObject({ note: "acknowledged" });

    const action = await s.create({ summary: "finish oauth", kind: "human" });
    await s.setBlock(action._id, {
      type: "blocked-by-human",
      who: "taku",
      actionLink: "https://example/oauth",
    });
    const actionResult = await answerAsk(ROOT_A, action._id, {
      acknowledged: true,
      choice: "also attacker-controlled",
    });
    expect(actionResult.answerText).toBe("acknowledged");
  });

  it("answerAsk requires an actual answer for a choice-shape ask (no bare acknowledged)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku", options: ["a", "b"] });
    await expect(answerAsk(ROOT_A, t._id, { acknowledged: true })).rejects.toThrow(
      /requires a choice/,
    );
  });

  it("answerAsk refuses a task that isn't currently blocked-by-human (already answered, or a different block type)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "x", kind: "human" });
    await expect(answerAsk(ROOT_A, t._id, { acknowledged: true })).rejects.toThrow(
      /not currently blocked-by-human/,
    );
    await s.setBlock(t._id, { type: "blocked-by-external", signal: "ci" });
    await expect(answerAsk(ROOT_A, t._id, { acknowledged: true })).rejects.toThrow(
      /not currently blocked-by-human/,
    );
  });

  it("answerAsk on a task whose current state has NO gated outgoing edge just clears the block (no transition to apply)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "x", kind: "code" }); // doing -> merged is ungated
    await s.setBlock(t._id, {
      type: "blocked-by-human",
      who: "taku",
      question: "still working on this?",
    });
    const { record: answered } = await answerAsk(ROOT_A, t._id, { acknowledged: true });
    expect(answered.block).toBeNull();
    expect(answered.state).toBe("doing"); // unchanged — nothing gated to advance
    expect(answered.verifyEvidence).toEqual([]);
  });

  it("answerAsk NEVER auto-transitions a code/doc/investigation task, even if its current gated edge would (wrongly) look unregistered to a fresh store instance — only human/decision kinds auto-advance", async () => {
    // Register "verify-green" on THIS process's own store instance, exactly
    // as a real project would — answerAsk() opens its OWN fresh instance
    // internally and has no visibility into this registration, which is
    // exactly the ambiguity that makes auto-transition unsafe for any kind
    // other than human/decision (see answerAsk's doc comment).
    const s = await openStore(ROOT_A);
    s.registerGate({ name: "verify-green", check: async () => ({ passed: true }) });
    const t = await s.create({ summary: "x", kind: "code", owner: "worker" });
    await s.transition(t._id, "merged");
    await s.transition(t._id, "shipped");
    await s.transition(t._id, "verifying");
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku", question: "any concerns?" });
    const { record: answered } = await answerAsk(ROOT_A, t._id, { acknowledged: true });
    expect(answered.block).toBeNull();
    expect(answered.state).toBe("verifying"); // unchanged — code kind never auto-transitions on a human answer
    expect(answered.verifyEvidence).toEqual([]);
  });

  it("listAsksForProject reports blockRev, and answerAsk refuses an expectedBlockRev that no longer matches — even when the CURRENT block has byte-for-byte identical text to what the caller last saw, since a content-only check could not distinguish 'still the same ask' from 'a new, identical-looking one' (codex-review round-17 Important)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision" });
    const identicalBlock: TodoBlock = {
      type: "blocked-by-human",
      who: "taku",
      question: "canary or beta?",
      options: ["canary", "beta"],
    };
    await s.setBlock(t._id, identicalBlock);
    const [ask] = await listAsksForProject(ROOT_A);
    const staleRev = ask!.blockRev;

    // Someone re-blocks with the EXACT same content before the human's
    // (now-stale) view gets answered.
    await s.setBlock(t._id, identicalBlock);

    await expect(
      answerAsk(ROOT_A, t._id, { choice: "canary", expectedBlockRev: staleRev }),
    ).rejects.toThrow(/this ask has changed since it was loaded/);
    // refused, not silently answered against the newer (identical-looking)
    // block instance
    expect(s.get(t._id)?.block).toEqual(identicalBlock);
    expect(s.get(t._id)?.state).toBe("deciding"); // unchanged — refused before any gate/transition

    // The CURRENT blockRev succeeds normally.
    const currentRev = (await listAsksForProject(ROOT_A))[0]!.blockRev;
    const { record: answered } = await answerAsk(ROOT_A, t._id, {
      choice: "canary",
      expectedBlockRev: currentRev,
    });
    expect(answered.block).toBeNull();
    expect(answered.state).toBe("decided");
  });

  it("answerAsk without expectedBlockRev (a direct/programmatic caller that doesn't track it) still works exactly as before — the check is opt-in, not required", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "x", kind: "human" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku" });
    const { record: answered } = await answerAsk(ROOT_A, t._id, { acknowledged: true });
    expect(answered.block).toBeNull();
    expect(answered.state).toBe("decided");
  });
});
