import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { expect, it, vi } from "vitest";
import { ClaudeAdapter } from "./claude.ts";
import { captureOutput, readNativeLines } from "./output.ts";

it("drains a burst through slow log writers without dropping the final result", async () => {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const native: string[] = [],
    events: string[] = [],
    errors: string[] = [];
  const slowLog = (chunks: string[]) =>
    new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        setImmediate(done);
      },
    });
  const logs = [slowLog(native), slowLog(events), slowLog(errors)];
  const error = vi.fn();
  const capture = captureOutput(stdout, stderr, logs, error);
  const adapter = new ClaudeAdapter();
  readNativeLines(stdout, (line) => {
    capture.write(logs[0]!, line + "\n");
    for (const event of adapter.parse(line)) capture.write(logs[1]!, JSON.stringify(event) + "\n");
  });
  stderr.on("data", (chunk) => capture.write(logs[2]!, chunk));
  const records = Array.from({ length: 512 }, (_, i) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `${i}:` + "x".repeat(8192) }] },
    }),
  );
  records.push(JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.125 }));
  const bytes = Buffer.from(records.join("\n"));
  // Separate pipe chunks exercise pause/resume; the last record has no newline.
  for (let offset = 0; offset < bytes.length; offset += 32768)
    stdout.write(bytes.subarray(offset, offset + 32768));
  stdout.end();
  stderr.end("diagnostic");
  expect(await capture.drain(false, 5000)).toBeUndefined();
  await Promise.all(
    logs.map((log) => {
      log.end();
      return finished(log);
    }),
  );
  expect(native.join("").trim().split("\n")).toEqual(records);
  const normalized = events
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(normalized.filter((event) => event.type === "text")).toHaveLength(512);
  expect(normalized.at(-1)).toMatchObject({ type: "turn_end", costUsd: 0.125 });
  expect(errors.join("")).toBe("diagnostic");
  expect(error).not.toHaveBeenCalled();
});

it("decodes split UTF-8, skips blank lines and flushes only a nonblank EOF record", async () => {
  for (const suffix of ["final", " \n\n"]) {
    const source = new PassThrough(),
      lines: string[] = [];
    readNativeLines(source, (line) => lines.push(line));
    const done = finished(source);
    const bytes = Buffer.from("\n\u2603\n" + suffix);
    source.write(bytes.subarray(0, 2));
    source.end(bytes.subarray(2));
    await done;
    expect(lines).toEqual(suffix === "final" ? ["\u2603", "final"] : ["\u2603"]);
  }
});

it("reports reader/writer failures and bounds inherited pipes without joining killed readers", async () => {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    log = new PassThrough();
  const onError = vi.fn();
  const capture = captureOutput(stdout, stderr, [log], onError);
  expect(await capture.drain(true, 5000)).toBeUndefined();
  expect((await capture.drain(false, 5))?.message).toContain("Timed out draining");
  const failure = new Error("reader failure");
  stdout.destroy(failure);
  expect(await capture.drain(false, 5000)).toBe(failure);
  const writerFailure = new Error("writer failure");
  log.destroy(writerFailure);
  await new Promise((resolve) => setImmediate(resolve));
  expect(onError).toHaveBeenCalledWith(writerFailure);
  stderr.destroy();
});
