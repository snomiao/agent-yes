import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile } from "fs/promises";
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

  it("--root=val and --format=val (equals form, native to yargs) work the same as the space form; an invalid --format value fails clearly", async () => {
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
    ).rejects.toThrow();
  });

  it("--format/--root work regardless of position — NOT just at the end of the command (codex-review round-5 Important: a prior design broke ordinary invocations like this one)", async () => {
    // --format BEFORE --owner (neither is trailing) — a real, entirely
    // ordinary way to type this command.
    await run("new", "a", "--kind", "code", "--owner", "alice");
    const a = await run("ls", "--format", "json", "--owner", "alice");
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out)).toHaveLength(1);
    // --root itself not at the end either (a verb-specific flag follows it)
    const cap = captureStdout();
    try {
      const code = await runTodoSubcommand([
        "ls",
        "--root",
        TEST_ROOT,
        "--owner",
        "alice",
        "--format",
        "json",
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(cap.text())).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  it("--root cannot be the empty string (codex-review round-4 nitpick)", async () => {
    await expect(runTodoSubcommand(["ls", "--root", ""])).rejects.toThrow(
      /--root must not be empty/,
    );
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

  it("dep rejects a malformed invocation (missing blockerId, or a verb that isn't add|rm) via yargs' own positional validation", async () => {
    await run("new", "a", "--kind", "code");
    await run("new", "b", "--kind", "code");
    await expect(run("dep", "add", "T2")).rejects.toThrow(/not enough non-option arguments/i);
    await expect(run("dep", "bogus", "T2", "T1")).rejects.toThrow(/invalid values/i);
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

  it("an unknown verb fails with a clear error from yargs' own command-tree validation", async () => {
    await expect(run("bogus")).rejects.toThrow(/unknown argument: bogus/i);
  });

  it("no verb at all fails naming every expected one, via demandCommand", async () => {
    await expect(run()).rejects.toThrow(
      /unknown "ay todo" verb.*new\/ls\/get\/transition\/approve\/verify\/block\/unblock\/dep\/tree\/digest\/reconcile/,
    );
  });

  it("--help resolves cleanly (exit 0, no throw) — a real yargs command tree auto-generates the verb listing (taku feedback); yargs' own help writer bypasses the stdout mock in this harness, so content is verified manually rather than asserted here", async () => {
    const cap = captureStdout();
    let code: number | undefined;
    try {
      code = await runTodoSubcommand(["--help", "--root", TEST_ROOT]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
  });

  it("a per-verb --help (e.g. `ay todo ls --help`) also resolves cleanly", async () => {
    const cap = captureStdout();
    let code: number | undefined;
    try {
      code = await runTodoSubcommand(["ls", "--help", "--root", TEST_ROOT]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
  });
});

describe("ay todo reconcile", () => {
  const AGENT_HOME = isWindows
    ? path.join(process.env.TEMP || "C:\\Temp", "todocli-agenthome-" + process.pid)
    : "/tmp/todocli-agenthome-" + process.pid;
  let prevHome: string | undefined;

  beforeEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await rm(AGENT_HOME, { recursive: true, force: true });
    prevHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = AGENT_HOME;
    await mkdir(AGENT_HOME, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await rm(AGENT_HOME, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prevHome;
  });

  async function seedGlobalPids(records: object[]): Promise<void> {
    await writeFile(
      path.join(AGENT_HOME, "pids.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  it("orphans a task whose owner is a known, exited agent, and reports the reassignment candidates", async () => {
    await seedGlobalPids([
      {
        pid: 111,
        cli: "claude",
        prompt: null,
        cwd: "/x",
        log_file: null,
        status: "exited",
        exit_code: 0,
        exit_reason: null,
        started_at: 0,
        agent_id: "dead-agent",
      },
      {
        pid: 222,
        cli: "claude",
        prompt: null,
        cwd: "/x",
        log_file: null,
        status: "idle",
        exit_code: null,
        exit_reason: null,
        started_at: 0,
        agent_id: "idle-agent",
      },
    ]);
    await run("new", "do the thing", "--kind", "code", "--owner", "dead-agent");
    const result = await run("reconcile");
    expect(result.code).toBe(0);
    expect(result.out).toContain("orphaned T1");
    expect(result.out).toContain("idle-agent");
    const got = await run("get", "T1");
    expect(got.out).toContain("[orphaned]");
  });

  it("reports notify-unblocked on EVERY reconcile call while the task stays unblocked — there is no real delivery channel yet, so persisting 'already notified' would retire the signal with nobody ever receiving it (codex-review round-7 Important)", async () => {
    await seedGlobalPids([]);
    // `human` kind's decided->done edge is ungated, so it's the simplest way
    // to get a real blocker into `done` without a registered gate.
    await run("new", "human-blocker", "--kind", "human"); // T1
    await run("approve", "T1", "human-replied", "someone");
    await run("transition", "T1", "decided");
    await run("transition", "T1", "done");
    await run("new", "waiter", "--kind", "code", "--owner", "worker", "--dep", "T1"); // T2

    const first = await run("reconcile");
    expect(first.out).toContain("T2 is now unblocked");

    const second = await run("reconcile");
    expect(second.out).toContain("T2 is now unblocked"); // still reported, not silently retired
  });
});
