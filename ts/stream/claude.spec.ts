import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter, userMessage } from "./claude.ts";
import { renderEvent } from "./transcript.ts";

describe("Claude stream protocol", () => {
  it("maps two turns, repeated init, tools, receipts and cumulative cost", () => {
    const adapter = new ClaudeAdapter();
    const lines = readFileSync(new URL("./fixtures/claude.ndjson", import.meta.url), "utf8")
      .trim()
      .split("\n");
    const events = lines.flatMap((line) => adapter.parse(line));
    expect(events.filter((e) => e.type === "turn_start").map((e) => e.turn)).toEqual([1, 2]);
    expect(events.filter((e) => e.type === "turn_end").map((e) => e.costUsd)).toEqual([
      0.004, 0.006,
    ]);
    expect(events).toContainEqual({
      type: "tool_result",
      id: "tool-one",
      ok: true,
      summary: "hello",
    });
    expect(events).toContainEqual({
      type: "needs_permission",
      reqId: "permission-one",
      tool: "Bash",
      input: { command: "printf hello" },
      options: ["allow", "deny"],
    });
    expect(events.map(renderEvent).join("")).toContain("assistant: Goodbye.");
    expect(adapter.parse(lines[8]!)).toEqual([]);
  });
  it("frames multiline messages as one JSON line and preserves the receipt id", () => {
    const line = userMessage("first\nsecond", "receipt-one");
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line)).toMatchObject({
      uuid: "receipt-one",
      message: { content: "first\nsecond" },
    });
  });
  it("recognizes questions and execution failures without throwing on malformed input", () => {
    const adapter = new ClaudeAdapter();
    expect(
      adapter.parse(
        JSON.stringify({
          type: "control_request",
          request_id: "question-one",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            input: { questions: [{ question: "Color?", options: [{ label: "Blue" }] }] },
          },
        }),
      ),
    ).toEqual([
      { type: "needs_input", reqId: "question-one", question: "Color?", options: ["Blue"] },
    ]);
    expect(
      adapter.parse('{"type":"result","is_error":true,"errors":["Interrupted"]}').at(-1),
    ).toEqual({ type: "error", message: "Interrupted", fatal: false });
    expect(adapter.parse("garbled")[0]?.type).toBe("error");
    expect(adapter.parse("null")).toEqual([]);
  });
});
