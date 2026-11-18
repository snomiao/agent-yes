import { Readable, type Writable } from "node:stream";

/** Forward native text stdin with backpressure; release the caller-owned source on exit. */
export function forwardInput(
  source: Readable | undefined,
  target: Writable,
  onError: () => void,
): () => void {
  const input = source ?? Readable.from([]);
  input.on("error", onError);
  input.pipe(target);
  return () => {
    input.unpipe(target);
    input.pause();
    input.off("error", onError);
  };
}
