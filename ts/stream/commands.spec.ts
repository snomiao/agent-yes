import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { appendGlobalPid, type GlobalPidRecord } from "../globalPidIndex.ts";
import { deriveLiveState, deriveLiveStatus, runSubcommand } from "../subcommands.ts";

it("drives stream status, tail, ls cost and send through the existing commands", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-commands-"));
  const oldHome = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = path.join(cwd, "home");
  let fd: number | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;
  const stdout: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const fifo = path.join(cwd, "stdin");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    const log = path.join(cwd, `${process.pid}.raw.log`);
    const events = log.replace(".raw.log", ".events.jsonl");
    const longLine = "assistant: " + "word ".repeat(90);
    await writeFile(log, `user: hello\n${longLine}\n`);
    await writeFile(events, JSON.stringify({ type: "turn_end", turn: 1, costUsd: 0.0123 }) + "\n");
    const record: GlobalPidRecord = {
      pid: process.pid,
      cli: "claude",
      mode: "stream",
      cwd,
      prompt: "hello",
      log_file: log,
      fifo_file: fifo,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
    };
    await appendGlobalPid(record);
    expect(await deriveLiveStatus(record)).toBe("idle");
    expect(await deriveLiveState(record)).toEqual({ state: "idle", question: null });
    await appendFile(events, JSON.stringify({ type: "turn_start", turn: 2, ts: 0 }) + "\n");
    expect(await deriveLiveState(record)).toEqual({ state: "active", question: null });
    await runSubcommand(["bun", "cli", "tail", String(process.pid)]);
    expect(stdout.join("")).toContain(longLine.trimEnd());
    stdout.length = 0;
    await runSubcommand(["bun", "cli", "ls", String(process.pid), "--json"]);
    expect(JSON.parse(stdout.join(""))[0]).toMatchObject({
      mode: "stream",
      cost_usd: 0.0123,
      state: "active",
    });
    stdout.length = 0;
    await runSubcommand(["bun", "cli", "ls", String(process.pid)]);
    expect(stdout.join("")).toContain("COST");
    expect(stdout.join("")).toContain("$0.0123");
    const received: any[] = [];
    let pending = "";
    polling = setInterval(() => {
      try {
        const buffer = Buffer.alloc(8192);
        const count = readSync(fd!, buffer, 0, buffer.length, null);
        pending += buffer.subarray(0, count).toString();
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          const message = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          received.push(message);
          if (message.type === "user")
            void appendFile(
              events,
              JSON.stringify({ type: "user", id: message.uuid, text: message.message.content }) +
                "\n",
            );
        }
      } catch (e: any) {
        if (e.code !== "EAGAIN") throw e;
      }
    }, 10);
    stdout.length = 0;
    expect(
      await runSubcommand([
        "bun",
        "cli",
        "send",
        String(process.pid),
        "hello\nworld",
        "--force",
        "--raw",
        "--interrupt",
      ]),
    ).toBe(0);
    expect(received[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(received[1]).toMatchObject({ type: "user", message: { content: "hello\nworld" } });
    expect(stdout.join("")).toContain("replay receipt");
    stdout.length = 0;
    const doneLine = "assistant: " + "long ".repeat(100) + "DONE";
    const append = setTimeout(() => void appendFile(log, doneLine + "\n"), 40);
    try {
      expect(
        await runSubcommand([
          "bun",
          "cli",
          "tail",
          String(process.pid),
          "--until",
          "DONE",
          "--timeout",
          "2s",
          "-q",
        ]),
      ).toBe(0);
      expect(stdout.join("")).toBe(doneLine + "\n");
    } finally {
      clearTimeout(append);
    }
  } finally {
    if (polling) clearInterval(polling);
    if (fd !== undefined) closeSync(fd);
    out.mockRestore();
    err.mockRestore();
    if (oldHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = oldHome;
    await rm(cwd, { recursive: true, force: true });
  }
});
