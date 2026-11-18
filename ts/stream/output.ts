import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

/** Observe EOF immediately, while allowing file backpressure to resume the readers. */
export function captureOutput(
  stdout: Readable,
  stderr: Readable,
  logs: Writable[],
  onError: (error: Error) => void,
) {
  const outputDone = Promise.all([
    finished(stdout, { cleanup: true }),
    finished(stderr, { cleanup: true }),
  ]).then(
    () => undefined,
    (error: Error) => error,
  );
  for (const log of logs) {
    log.on("error", onError);
    log.on("drain", () => {
      if (logs.every((stream) => !stream.writableNeedDrain)) {
        stdout.resume();
        stderr.resume();
      }
    });
  }
  return {
    write(log: Writable, text: string | Buffer) {
      if (!log.write(text)) {
        stdout.pause();
        stderr.pause();
      }
    },
    async drain(killed: boolean, timeoutMs: number): Promise<Error | undefined> {
      // A killed-child path abandons readers held open by inherited writers.
      if (killed) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const error = await Promise.race([
        outputDone,
        new Promise<Error>((resolve) => {
          timeout = setTimeout(
            () =>
              resolve(new Error("Timed out draining stream output after process-group cleanup")),
            timeoutMs,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      return error;
    },
  };
}

/** Decode complete native records, including UTF-8 split across chunks and a final EOF record. */
export function readNativeLines(source: Readable, onLine: (line: string) => void): void {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  source.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  });
  source.on("end", () => {
    pending += decoder.end();
    if (pending.trim()) onLine(pending);
    pending = "";
  });
}
