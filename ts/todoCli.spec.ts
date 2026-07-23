import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { rm } from "fs/promises";
import path from "path";
import { runTodoSubcommand } from "./todoCli";

const isWindows = process.platform === "win32";
const TEST_ROOT = isWindows
  ? path.join(process.env.TEMP || "C:\\Temp", "todocli-test-" + process.pid)
  : "/tmp/todocli-test-" + process.pid;

function captureStdout(): { text: () => string; restore: () => void } {
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  return { text: () => buf, restore: () => spy.mockRestore() };
}

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const cap = captureStdout();
  try {
    const code = await runTodoSubcommand([...args, "--root", TEST_ROOT]);
    return { code, out: cap.text() };
  } finally {
    cap.restore();
  }
}

describe("ay todo CLI", () => {
  beforeEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("new joins ALL positional words into the summary — an unquoted multi-word summary is not silently truncated to its first word (codex-review Important)", async () => {
    const a = await run("new", "write", "the", "spec", "--kind", "doc");
    expect(a.code).toBe(0);
    expect(a.out).toContain("created T1");
    const got = await run("get", "T1");
    expect(got.out).toContain("T1 [drafting] write the spec");
  });

  it("--root=val and --format=val (equals form) work the same as the space form; an invalid --format value fails clearly", async () => {
    const cap = captureStdout();
    try {
      const code = await runTodoSubcommand(["new", "x", "--kind", "code", `--root=${TEST_ROOT}`]);
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
    const cap2 = captureStdout();
    try {
      await runTodoSubcommand(["get", "T1", "--root", TEST_ROOT, "--format=json"]);
      expect(JSON.parse(cap2.text())._id).toBe("T1");
    } finally {
      cap2.restore();
    }
    await expect(
      runTodoSubcommand(["get", "T1", "--root", TEST_ROOT, "--format", "yaml"]),
    ).rejects.toThrow(/--format must be/);
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
    await run("new", "a", "--kind", "code", "--owner", "alice", "--tag", "proj-x");
    await run("new", "b", "--kind", "doc");
    const all = await run("ls");
    expect(all.out).toContain("T1");
    expect(all.out).toContain("T2");
    const filtered = await run("ls", "--owner", "alice");
    expect(filtered.out).toContain("T1");
    expect(filtered.out).not.toContain("T2");

    const got = await run("get", "T1");
    expect(got.code).toBe(0);
    expect(got.out).toContain("T1 [doing] a");
    await expect(run("get", "T99")).rejects.toThrow(/no such task/);
  });

  it("--format json emits parseable JSON for ls/get", async () => {
    await run("new", "a", "--kind", "code");
    const cap = captureStdout();
    await runTodoSubcommand(["get", "T1", "--root", TEST_ROOT, "--format", "json"]);
    cap.restore();
    const parsed = JSON.parse(cap.text());
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
      "taku",
      "--question",
      "canary or beta?",
    );
    expect(human.out).toContain("waiting on taku: canary or beta?");
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

  it("tree --format json emits the actual nested structure, not the human text (codex-review Important)", async () => {
    await run("new", "a", "--kind", "code", "--owner", "cto");
    await run("new", "b", "--kind", "code");
    await run("dep", "add", "T2", "T1");
    const cap = captureStdout();
    await runTodoSubcommand(["tree", "--root", TEST_ROOT, "--format", "json"]);
    cap.restore();
    const parsed = JSON.parse(cap.text());
    expect(parsed).toEqual([
      {
        id: "T2",
        state: "doing",
        summary: "b",
        children: [{ id: "T1", state: "doing", summary: "a", owner: "cto", children: [] }],
      },
    ]);
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
    const cap = captureStdout();
    await runTodoSubcommand(["digest", "--root", TEST_ROOT, "--format", "json"]);
    cap.restore();
    const parsed = JSON.parse(cap.text());
    expect(parsed.unblocked).toEqual(["T3"]);
  });

  it("an unknown verb fails with a clear, enumerated error", async () => {
    await expect(run("bogus")).rejects.toThrow(/unknown "ay todo" verb/);
  });
});
