import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eventFile, readEvents, streamSnapshot } from "./state.ts";

describe("stream state", () => {
  it("uses protocol events rather than quiet time and does not double-count session cost", () => {
    expect(streamSnapshot([{ type: "turn_start", turn: 1, ts: 0 }]).state).toBe("active");
    expect(
      streamSnapshot([
        { type: "turn_end", turn: 1, costUsd: 0.01 },
        { type: "session", sessionId: "example" },
        { type: "turn_end", turn: 2, costUsd: 0.015 },
      ]),
    ).toEqual({ state: "idle", question: null, costUsd: 0.015 });
    expect(
      streamSnapshot([
        {
          type: "needs_permission",
          reqId: "req-one",
          tool: "Bash",
          input: { command: "printf hello" },
          options: [],
        },
      ]),
    ).toMatchObject({ state: "needs_input", question: 'Bash: {"command":"printf hello"}' });
    expect(
      streamSnapshot([
        { type: "needs_input", reqId: "q", question: "Color?" },
        { type: "user", id: "queued", text: "later" },
      ]).state,
    ).toBe("needs_input");
    expect(streamSnapshot([{ type: "error", message: "Interrupted", fatal: false }])).toMatchObject(
      { state: "stuck", question: "Interrupted" },
    );
  });
  it("ignores partial or malformed append records and bounds the read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ay-events-"));
    const file = path.join(dir, "events.jsonl");
    try {
      await writeFile(
        file,
        "garbage\n" + JSON.stringify({ type: "turn_end", turn: 1 }) + '\n{"type":"text"',
      );
      expect(await readEvents(file)).toEqual([{ type: "turn_end", turn: 1 }]);
      expect(await readEvents(file, 10)).toEqual([]);
      expect(await readEvents(path.join(dir, "missing"))).toEqual([]);
      expect(eventFile({ cwd: "/repo/alpha", pid: 1111, log_file: null })).toBe(
        "/repo/alpha/.agent-yes/1111.events.jsonl",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
