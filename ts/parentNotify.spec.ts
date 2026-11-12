import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createParentNotifier, PARENT_HEARTBEAT_MS } from "./parentNotify.ts";
import { startParentPingLoop } from "./parentPingLoop.ts";
import { readInbox, hostId } from "./notifyStore.ts";

describe("child-owned parent inbox notifications", () => {
  let home: string;
  let previous: string | undefined;
  const record = (pid: number, wrapper: number, started: number) => ({
    pid,
    wrapper_pid: wrapper,
    started_at: started,
    cli: "claude",
    cwd: "/repo/alpha",
    status: "active",
    prompt: null,
    log_file: null,
    exit_code: null,
    exit_reason: null,
  });
  beforeEach(async () => {
    previous = process.env.AGENT_YES_HOME;
    home = await mkdtemp(path.join(tmpdir(), "parent-notify-"));
    process.env.AGENT_YES_HOME = home;
    await writeFile(
      path.join(home, "pids.jsonl"),
      [record(1111, 1110, 100), record(2222, 2220, 200)].map((r) => JSON.stringify(r)).join("\n") +
        "\n",
    );
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  it("delivers confirmed idle, periodic heartbeat, and exactly one exit without a watcher", async () => {
    const notifier = (await createParentNotifier(1110, 2220))!;
    await notifier.observe("idle", null, "ready", 1000);
    await notifier.observe("idle", null, "ready", 31000);
    await notifier.observe("idle", null, "ready", 1000 + PARENT_HEARTBEAT_MS);
    await Promise.all([
      notifier.observe("stopped", null, "done", 70000),
      notifier.observe("stopped", null, "done", 70001),
    ]);
    const events = await readInbox(hostId(), 1110);
    expect(events.map((e) => e.edge)).toEqual(["heartbeat", "idle", "heartbeat", "exited"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.every((e) => e.parent_started_at === 100 && e.child_started_at === 200)).toBe(
      true,
    );
    expect(events.at(-1)?.state).toBe("stopped");
  });
  it("the wrapper loop persists events even when injected reports are disabled", async () => {
    let time = 1000;
    let polls = 0;
    const loop = startParentPingLoop({
      parentPid: 1110,
      selfWrapperPid: 2220,
      self: { cli: "claude", pid: 2222, cwd: "/repo/alpha" },
      patterns: { ready: [/^ready$/] },
      screen: () => {
        polls++;
        return ["ready"];
      },
      pollMs: 5,
      mode: "never",
      now: () => time,
    });
    try {
      expect(await loop.ready).toBe(true);
      const waitForPoll = async () => {
        const before = polls;
        for (let i = 0; polls === before && i < 100; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(polls).toBeGreaterThan(before);
      };
      await waitForPoll();
      time = 31000;
      await waitForPoll();
      await loop.pingExit(0);
      expect((await readInbox(hostId(), 1110)).map((e) => e.edge)).toEqual([
        "heartbeat",
        "idle",
        "exited",
      ]);
    } finally {
      loop.stop();
    }
  });
  it("busy heartbeats never announce completion; a new question is delivered", async () => {
    const notifier = (await createParentNotifier(1110, 2220))!;
    await notifier.observe("active", null, null, 1000);
    await notifier.observe("active", null, null, 100000);
    await notifier.observe("needs_input", "Choose an option", "menu", 100001);
    expect((await readInbox(hostId(), 1110)).map((e) => e.edge)).toEqual([
      "heartbeat",
      "heartbeat",
      "needs_input",
    ]);
  });
  it("recovers after an inbox write fails without consuming the lifecycle edge", async () => {
    const notifier = (await createParentNotifier(1110, 2220))!;
    await writeFile(path.join(home, "notify"), "blocked");
    await expect(notifier.observe("idle", null, "ready", 1000)).rejects.toThrow();
    await unlink(path.join(home, "notify"));
    await notifier.observe("idle", null, "ready", 2000);
    await notifier.observe("idle", null, "ready", 32000);
    await notifier.observe("stopped", null, null, 33000);
    expect((await readInbox(hostId(), 1110)).map((e) => e.edge)).toEqual([
      "heartbeat",
      "idle",
      "exited",
    ]);
  });
  it("skips roots, missing parents, self links, and reused parent identities", async () => {
    expect(await createParentNotifier(undefined, 2220)).toBeNull();
    expect(await createParentNotifier(2220, 2220)).toBeNull();
    expect(await createParentNotifier(3330, 2220)).toBeNull();
    await writeFile(
      path.join(home, "pids.jsonl"),
      [record(1111, 1110, 300), record(2222, 2220, 200)].map((r) => JSON.stringify(r)).join("\n") +
        "\n",
    );
    expect(await createParentNotifier(1110, 2220)).toBeNull();
  });
});
