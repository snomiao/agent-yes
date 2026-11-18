import { once } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { forwardJsonInput } from "./jsonInput.ts";

it("frames split caller records with backpressure and preserves metadata and final EOF", async () => {
  const records = [
    { type: "user", uuid: "one", message: { content: "snowman \u2603" }, parent_tool_use_id: null },
    { type: "control_response", response: { request_id: "two" } },
  ];
  const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n"));
  const source = Readable.from([bytes.subarray(0, 57), bytes.subarray(57, 61), bytes.subarray(61)]);
  let output = "";
  const target = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      output += chunk.toString();
      setImmediate(done);
    },
  });
  const done = once(target, "finish");
  const error = vi.fn();
  const release = forwardJsonInput(source, target, false, error);
  await done;
  release();
  expect(
    output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(records);
  expect(error).not.toHaveBeenCalled();
});

it("keeps the FIFO channel open after caller EOF and never splices a partial caller frame", async () => {
  const source = new PassThrough();
  const target = new PassThrough();
  let output = "";
  target.on("data", (chunk) => {
    output += chunk.toString();
  });
  const error = vi.fn();
  const release = forwardJsonInput(source, target, true, error);
  source.write('{"type":"user","message":');
  target.write('{"type":"user","message":"fifo"}\n');
  const ended = once(source, "end");
  source.end('"caller"}\n\n');
  await ended;
  expect(target.writableEnded).toBe(false);
  expect(
    output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { type: "user", message: "fifo" },
    { type: "user", message: "caller" },
  ]);
  source.emit("error", new Error("source failure"));
  expect(error).toHaveBeenCalledOnce();
  release();
  expect(source.listenerCount("error")).toBe(0);
  target.end();
});
