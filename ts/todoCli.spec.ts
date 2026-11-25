import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTodoSubcommand } from "./todoCli.ts";

let TEST_ROOT: string;
function captureStdout(): { text: () => string; restore: () => void } {
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  return { text: () => buf, restore: () => spy.mockRestore() };
}
async function invoke(args: string[]): Promise<{ code: number; out: string }> {
  const cap = captureStdout();
  try {
    const code = await runTodoSubcommand(args);
    return { code, out: cap.text() };
  } finally {
    cap.restore();
  }
}
async function run(...args: string[]): Promise<{ code: number; out: string }> {
  return invoke([...args, "--root", TEST_ROOT]);
}
describe("todo CLI contracts", () => {
  beforeEach(async () => {
    TEST_ROOT = await mkdtemp(path.join(tmpdir(), "todo-cli-contract-"));
  });
  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });
  it("new creates a task with kind/tier/owner/tags/deps and rejects a missing summary", async () => {
    const a = await run(
      "new",
      "write the spec",
      "--kind",
      "doc",
      "--owner",
      "writer",
      "--tag",
      "proj-x",
    );
    expect(a.code).toBe(0);
    expect(a.out).toContain("created T1");
    expect(a.out).toContain("kind:    doc");
    expect(a.out).toContain("owner:   writer");

    const b = await run(
      "new",
      "ship it",
      "--kind",
      "code",
      "--tier",
      "shipped-done",
      "--dep",
      "T1",
    );
    expect(b.code).toBe(0);
    expect(b.out).toContain("created T2");
    expect(b.out).toContain("tier:shipped-done");
    expect(b.out).toContain("blockedBy: T1");

    await expect(run("new", "", "--kind", "doc")).rejects.toThrow(/usage: ay todo new/);
    await expect(run("new", "x")).rejects.toThrow(/--kind is required/);
    await expect(run("new", "x", "--kind", "bogus")).rejects.toThrow(/unknown kind/);
  });

  it("ls lists and filters; get shows one task or fails cleanly on an unknown id", async () => {
    await run("new", "a", "--kind", "code", "--owner", "operator", "--tag", "proj-x");
    await run("new", "b", "--kind", "doc");
    const all = await run("ls");
    expect(all.out).toContain("T1");
    expect(all.out).toContain("T2");
    const filtered = await run("ls", "--owner", "operator");
    expect(filtered.out).toContain("T1");
    expect(filtered.out).not.toContain("T2");

    const got = await run("get", "T1");
    expect(got.code).toBe(0);
    expect(got.out).toContain("T1 [doing] a");
    await expect(run("get", "T99")).rejects.toThrow(/no such task/);
  });

  it("--format json emits parseable JSON for ls/get", async () => {
    await run("new", "a", "--kind", "code");
    const result = await run("get", "T1", "--format", "json");
    const parsed = JSON.parse(result.out);
    expect(parsed._id).toBe("T1");
    expect(parsed.kind).toBe("code");
  });

  it("transition moves state directly across an ungated edge and fails naming the missing gate otherwise", async () => {
    await run("new", "a", "--kind", "code", "--owner", "worker");
    const moved = await run("transition", "T1", "merged");
    expect(moved.out).toContain("transitioned T1 -> merged");
    await run("transition", "T1", "shipped");
    await run("transition", "T1", "verifying");
    await expect(run("transition", "T1", "done")).rejects.toThrow(/requires gate "verify-green"/);
  });

  it("approve satisfies a manual gate as a DIFFERENT validator, then transition succeeds; self-approval is refused end-to-end via the CLI", async () => {
    await run("new", "a", "--kind", "doc", "--owner", "worker");
    await run("transition", "T1", "review");
    await expect(run("approve", "T1", "human-approved", "worker")).rejects.toThrow(
      /independent verification required/,
    );
    const approved = await run("approve", "T1", "human-approved", "reviewer", "--note", "lgtm");
    expect(approved.out).toContain('approved "human-approved" on T1 (validator: reviewer)');
    const done = await run("transition", "T1", "done");
    expect(done.out).toContain("transitioned T1 -> done");
  });

  it("verify runs a registered gate end-to-end (only exercisable by a project that calls store.registerGate — the bare CLI has none registered, so it reports that honestly)", async () => {
    await run("new", "a", "--kind", "code", "--owner", "worker");
    await run("transition", "T1", "merged");
    await run("transition", "T1", "shipped");
    await run("transition", "T1", "verifying");
    await expect(run("verify", "T1")).rejects.toThrow(/no registered gate found/);
  });

  it("block/unblock round-trip every typed shape", async () => {
    await run("new", "a", "--kind", "code");
    const human = await run(
      "block",
      "T1",
      "--type",
      "blocked-by-human",
      "--who",
      "operator",
      "--question",
      "canary or beta?",
    );
    expect(human.out).toContain("waiting on operator: canary or beta?");
    const unblocked = await run("unblock", "T1");
    expect(unblocked.out).toContain("unblocked T1");

    await run("new", "b", "--kind", "code");
    await run("block", "T2", "--type", "blocked-by-task", "--task", "T1");
    await run("new", "c", "--kind", "code");
    await run("block", "T3", "--type", "blocked-by-external", "--signal", "release-pipeline");
    await run("new", "d", "--kind", "code");
    const agentBlocked = await run(
      "block",
      "T4",
      "--type",
      "waiting-on-agent",
      "--agent",
      "abc123",
    );
    expect(agentBlocked.out).toContain("waiting on agent abc123");

    await expect(run("block", "T1", "--type", "blocked-by-human")).rejects.toThrow(/--who/);
    await expect(run("block", "T1")).rejects.toThrow(/usage: ay todo block/);
  });

  it("dep add/rm, tree, and digest render real output and surface cycles as a clean error", async () => {
    await run("new", "a", "--kind", "code");
    await run("new", "b", "--kind", "code");
    const added = await run("dep", "add", "T2", "T1");
    expect(added.out).toContain("added dep T1 on T2");
    await expect(run("dep", "add", "T1", "T2")).rejects.toThrow(/cycle/);

    const tree = await run("tree");
    expect(tree.out).toContain("T2");
    expect(tree.out).toContain("└─ T1");

    const digest = await run("digest");
    expect(digest.out).toContain("(untagged)");

    const removed = await run("dep", "rm", "T2", "T1");
    expect(removed.out).toContain("removed dep T1 on T2");
  });

  it("digest --format json includes the unblocked list", async () => {
    await run("new", "a", "--kind", "code");
    await run("transition", "T1", "merged");
    // no gate registered by the bare CLI, but transition to a terminal-ish
    // state isn't required to prove the unblocked computation wires through —
    // create a second task depending on a THIRD, separately-completed one via
    // the human kind (reaches done with no registered gate at all)
    await run("new", "h", "--kind", "human");
    await run("block", "T2", "--type", "blocked-by-human", "--who", "x");
    await run("approve", "T2", "human-replied", "x");
    await run("transition", "T2", "decided");
    await run("transition", "T2", "done");
    await run("new", "waits-on-h", "--kind", "code", "--dep", "T2");
    const result = await run("digest", "--format", "json");
    const parsed = JSON.parse(result.out);
    expect(parsed.unblocked).toEqual(["T3"]);
  });

  it("dep surfaces a non-cycle store error (unknown task id) by rethrowing it, not swallowing it as a cycle", async () => {
    await run("new", "a", "--kind", "code");
    // T99 doesn't exist: store.addDep throws a plain Error, NOT CycleError, so
    // the CLI must rethrow (the catch only special-cases CycleError).
    await expect(run("dep", "add", "T1", "T99")).rejects.toThrow(/T99/);
  });

  it("get renders the free-form description block when a task has one", async () => {
    await run("new", "a", "--kind", "doc", "--description", "the long form details");
    const got = await run("get", "T1");
    expect(got.out).toContain("the long form details");
  });

  it("lists an empty private store without inventing rows", async () => {
    const empty = await run("ls");
    expect(empty.out.trim()).toBe("(no tasks match)");
    const json = await run("ls", "--format", "json");
    expect(JSON.parse(json.out)).toEqual([]);
  });
  it("rejects missing task arguments and unknown dependency actions", async () => {
    for (const args of [
      ["get"],
      ["transition", "T1"],
      ["approve", "T1"],
      ["verify"],
      ["unblock"],
      ["dep", "add", "T1"],
      ["dep", "other", "T1", "T2"],
    ]) {
      await expect(run(...args)).rejects.toThrow(/usage:/);
    }
    await expect(run("unknown")).rejects.toThrow(/unknown.*verb/);
  });
  it("rejects typed blocks missing their required identity or signal", async () => {
    await run("new", "sample", "--kind", "code");
    for (const [type, required] of [
      ["blocked-by-task", "--task"],
      ["blocked-by-human", "--who"],
      ["blocked-by-external", "--signal"],
      ["waiting-on-agent", "--agent"],
    ] as const) {
      await expect(run("block", "T1", "--type", type)).rejects.toThrow(required);
    }
  });
  it("preserves filters and explicit evidence metadata across the common parser", async () => {
    await run("new", "sample document", "--kind", "doc", "--owner", "writer", "--tag", "example");
    await run("transition", "T1", "review");
    await run(
      "approve",
      "T1",
      "human-approved",
      "reviewer",
      "--note",
      "checked",
      "--link",
      "https://example.invalid/proof",
    );
    const got = await run("get", "T1");
    expect(got.out).toContain("satisfiedGates: human-approved");
    expect(got.out).toContain("https://example.invalid/proof");
    const filtered = await run(
      "ls",
      "--kind",
      "doc",
      "--state",
      "review",
      "--owner",
      "writer",
      "--tag",
      "example",
      "--format",
      "json",
    );
    expect(JSON.parse(filtered.out).map((t: { _id: string }) => t._id)).toEqual(["T1"]);
    const blocked = await run("ls", "--blocked", "--format", "json");
    expect(JSON.parse(blocked.out)).toEqual([]);
    await expect(run("ls", "--kind", "unknown")).rejects.toThrow(/unknown kind/);
  });
  it("keeps root and JSON format in the common parser before or after the verb", async () => {
    const first = await invoke([
      "--root",
      TEST_ROOT,
      "--format",
      "json",
      "new",
      "first",
      "--kind",
      "code",
    ]);
    expect(JSON.parse(first.out)).toMatchObject({ _id: "T1", kind: "code", summary: "first" });
    const second = await invoke([
      "new",
      "second",
      "--kind",
      "doc",
      "--root",
      TEST_ROOT,
      "--format",
      "json",
    ]);
    expect(JSON.parse(second.out)).toMatchObject({ _id: "T2", kind: "doc", summary: "second" });
    const loaded = await invoke(["--format", "json", "get", "T1", "--root", TEST_ROOT]);
    expect(JSON.parse(loaded.out)._id).toBe("T1");
  });
  it("still validates a known common format option", async () => {
    await expect(invoke(["ls", "--root", TEST_ROOT, "--format", "yaml"])).rejects.toThrow();
  });
});
