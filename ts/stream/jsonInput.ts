import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Keep caller records atomic with FIFO writes, without changing the native JSON payload. */
export function forwardJsonInput(
  source: Readable,
  target: Writable,
  keepOpen: boolean,
  onError: () => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    ended = false,
    blocked = false,
    released = false,
    closed = false;
  const pump = () => {
    if (released) return;
    while (!blocked) {
      const end = pending.indexOf("\n");
      if (end === -1 && (!ended || !pending)) break;
      const line = end === -1 ? pending : pending.slice(0, end);
      pending = end === -1 ? "" : pending.slice(end + 1);
      if (line.trim() && !target.write(line + "\n")) {
        blocked = true;
        source.pause();
      }
    }
    if (ended && !blocked && !pending && !keepOpen && !closed) {
      closed = true;
      target.end();
    }
  };
  const data = (chunk: Buffer | string) => {
    pending += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    pump();
  };
  const end = () => {
    ended = true;
    pending += decoder.end();
    pump();
  };
  const drain = () => {
    blocked = false;
    pump();
    if (!blocked && !ended && !released) source.resume();
  };
  source.on("data", data);
  source.on("end", end);
  source.on("error", onError);
  target.on("drain", drain);
  return () => {
    released = true;
    source.off("data", data);
    source.off("end", end);
    source.off("error", onError);
    target.off("drain", drain);
    source.pause();
  };
}
