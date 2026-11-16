import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readGlobalPids, updateGlobalPidStatus } from "../globalPidIndex.ts";

it("recovers dropped stream markers, preserves explicit PTY records and persists turn status", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-registry-"));
  const previous = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = cwd;
  try {
    const file = path.join(cwd, "pids.jsonl");
    const base = {
      pid: 1111,
      cli: "claude",
      cwd,
      started_at: Date.now(),
      status: "active",
      log_file: null,
      prompt: null,
      exit_code: null,
      exit_reason: null,
    };
    await mkdir(path.join(cwd, ".agent-yes"));
    await writeFile(
      path.join(cwd, ".agent-yes", "1111.events.jsonl"),
      '{"type":"turn_end","turn":1}\n',
    );
    await writeFile(file, JSON.stringify({ ...base, mode: null }) + "\n");
    expect((await readGlobalPids())[0]?.mode).toBe("stream");
    await updateGlobalPidStatus(1111, { mode: "stream", status: "idle" });
    expect(JSON.parse((await readFile(file, "utf8")).trim().split("\n").at(-1)!)).toMatchObject({
      mode: "stream",
      status: "idle",
    });
    await writeFile(file, JSON.stringify({ ...base, mode: "pty" }) + "\n");
    expect((await readGlobalPids())[0]?.mode).toBe("pty");
    await writeFile(file, JSON.stringify({ ...base, started_at: Date.now() + 10000 }) + "\n");
    expect((await readGlobalPids())[0]?.mode).toBeUndefined();
    // Partial updates without a base row must retain the registry reader's tolerant contract.
    await writeFile(file, '{"pid":1111}\n');
    expect(await readGlobalPids()).toEqual([{ pid: 1111 }]);
  } finally {
    if (previous === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = previous;
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
