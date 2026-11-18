import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { appendGlobalPid } from "../globalPidIndex.ts";
import { runSubcommand } from "../subcommands.ts";

it.skipIf(process.platform === "win32")(
  "never claims an unconfirmed stream send succeeded or writes terminal bytes",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-guard-"));
    const previous = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = cwd;
    let fd: number | undefined;
    let output = "",
      error = "";
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      error += String(chunk);
      return true;
    });
    try {
      const fifo = path.join(cwd, "stdin");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      await appendGlobalPid({
        pid: process.pid,
        cli: "claude",
        mode: "stream",
        cwd,
        prompt: null,
        log_file: null,
        fifo_file: fifo,
        status: "active",
        started_at: Date.now(),
        exit_code: null,
        exit_reason: null,
      });
      expect(
        await runSubcommand([
          "bun",
          "cli",
          "send",
          String(process.pid),
          "task",
          "--force",
          "--no-wait",
        ]),
      ).toBe(1);
      expect(error).toContain("stream");
      expect(output).not.toContain("sent");
      expect(() => readSync(fd!, Buffer.alloc(1024), 0, 1024, null)).toThrow();
    } finally {
      if (fd !== undefined) closeSync(fd);
      out.mockRestore();
      err.mockRestore();
      if (previous === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
