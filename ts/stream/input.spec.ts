import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { forwardInput } from "./input.ts";

it("preserves native stdin bytes and EOF, including the empty-input case", async () => {
  for (const source of [
    Readable.from([Buffer.from("first\n"), Buffer.from("second \u2603\n")]),
    undefined,
  ]) {
    const target = new PassThrough({ highWaterMark: 1 });
    const chunks: Buffer[] = [];
    target.on("data", (chunk) => chunks.push(chunk));
    const ended = once(target, "finish");
    const onError = vi.fn();
    const release = forwardInput(source, target, onError);
    await ended;
    expect(Buffer.concat(chunks).toString("utf8")).toBe(source ? "first\nsecond \u2603\n" : "");
    release();
    expect(onError).not.toHaveBeenCalled();
  }
});

it("reports source errors and detaches without destroying the caller's stdin", () => {
  const source = new PassThrough();
  const target = new PassThrough();
  const onError = vi.fn();
  const release = forwardInput(source, target, onError);
  source.emit("error", new Error("input failed"));
  expect(onError).toHaveBeenCalledOnce();
  release();
  source.write("remaining input");
  expect(source.destroyed).toBe(false);
  expect(source.isPaused()).toBe(true);
  expect(target.read()).toBeNull();
  expect(source.listenerCount("error")).toBe(0);
  source.destroy();
  target.destroy();
});
