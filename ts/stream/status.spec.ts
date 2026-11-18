import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { appendGlobalPid, type GlobalPidRecord } from "../globalPidIndex.ts";
import { deriveLiveState, runSubcommand, snapshotStatus } from "../subcommands.ts";
import type { AyEvent } from "./types.ts";

it("uses normalized stream state for status snapshots and CLI status, matching ls", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-status-"));
  const previous = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = cwd;
  const log = path.join(cwd, "1111.raw.log");
  const events = log.replace(".raw.log", ".events.jsonl");
  try {
    await writeFile(log, "Working...\n");
    await utimes(log, new Date(0), new Date(0));
    const record: GlobalPidRecord = {
      pid: process.pid,
      cli: "claude",
      mode: "stream",
      cwd,
      prompt: null,
      log_file: log,
      fifo_file: null,
      status: "active",
      unresponsive: true,
      started_at: Date.now(),
      exit_code: null,
      exit_reason: null,
    };
    await appendGlobalPid(record);
    const cases: [AyEvent, string, string | null][] = [
      [{ type: "turn_start", turn: 1, ts: 0 }, "active", null],
      [
        {
          type: "needs_permission",
          reqId: "permission",
          tool: "Bash",
          input: { command: "printf hello" },
          options: ["allow", "deny"],
        },
        "needs_input",
        'Bash: {"command":"printf hello"}',
      ],
      [
        { type: "needs_input", reqId: "question", question: "Which option?" },
        "needs_input",
        "Which option?",
      ],
      [{ type: "tool_result", id: "tool", ok: true, summary: "done" }, "active", null],
      [{ type: "turn_end", turn: 1 }, "idle", null],
      [{ type: "error", message: "Request failed", fatal: false }, "stuck", "Request failed"],
    ];
    for (const [event, state, question] of cases) {
      await writeFile(events, JSON.stringify(event) + "\n");
      expect(await snapshotStatus(record)).toMatchObject({ state, question });
      expect(await deriveLiveState(record)).toEqual({ state, question });
      if (event.type === "needs_permission") {
        let output = "";
        const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          output += String(chunk);
          return true;
        });
        try {
          expect(await runSubcommand(["bun", "cli", "status", String(process.pid)])).toBe(0);
          expect(JSON.parse(output)).toMatchObject({ state, question });
        } finally {
          out.mockRestore();
        }
      }
    }
    expect(await snapshotStatus({ ...record, status: "exited" })).toMatchObject({
      state: "stopped",
      question: null,
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
