import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "fs/promises";
import path from "path";
import { listAsks, listAsksForProject, answerAsk, hasTodoStore } from "./askApi";
import { openStore } from "./todoStore";

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

  it("answerAsk does not re-approve (and duplicate evidence for) a gate the FRESH record already shows satisfied — the retry-after-a-transition-failure case, since approve()+transition() are two separate persisted writes, not one atomic operation (codex-review round-10 Important)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku", options: ["a", "b"] });
    // Simulate exactly the state a first answerAsk() attempt would leave
    // behind if approve() succeeded but transition() then failed: the gate
    // is already satisfied, the task hasn't advanced yet, still blocked.
    await s.approve(t._id, "human-decided", "taku", { note: "a" });
    const { record: answered } = await answerAsk(ROOT_A, t._id, { choice: "a" });
    expect(answered.state).toBe("decided");
    // Exactly ONE evidence entry — a naive retry would have called
    // approve() again and appended a second one for the same gate.
    expect(answered.verifyEvidence).toHaveLength(1);
    expect(answered.verifyEvidence[0]).toMatchObject({ gate: "human-decided", note: "a" });
  });

  it("answerAsk refuses (as a conflict, not a silent overwrite) when the gate is already satisfied with a DIFFERENT answer than this request — two different answers for one ask must never silently pick one (codex-review round-12 Important)", async () => {
    const s = await openStore(ROOT_A);
    const t = await s.create({ summary: "pick a channel", kind: "decision" });
    await s.setBlock(t._id, { type: "blocked-by-human", who: "taku", options: ["a", "b"] });
    // A prior attempt persisted "a" then (hypothetically) failed before
    // transitioning — a DIFFERENT request now tries to answer "b".
    await s.approve(t._id, "human-decided", "taku", { note: "a" });
    await expect(answerAsk(ROOT_A, t._id, { choice: "b" })).rejects.toThrow(
      /already satisfied with a DIFFERENT answer/,
    );
    // Refused, not silently resolved either way — still blocked, unchanged.
    const stillBlocked = (await openStore(ROOT_A)).get(t._id)!;
    expect(stillBlocked.state).toBe("deciding");
    expect(stillBlocked.block).not.toBeNull();
    expect(stillBlocked.verifyEvidence).toHaveLength(1); // "b" was never recorded
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
});
