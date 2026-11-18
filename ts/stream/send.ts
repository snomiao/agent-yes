import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { GlobalPidRecord } from "../globalPidIndex.ts";
import { userMessage } from "./claude.ts";
import { eventFile } from "./state.ts";

export interface StreamSendOptions {
  interrupt?: boolean;
  timeoutMs?: number;
  /** The writer must hold the per-target IPC lock for its complete payload. */
  write: (payload: string) => Promise<void>;
}

/** Never retry a submitted message: a receipt timeout has an uncertain outcome. */
export async function sendStream(
  record: GlobalPidRecord,
  text: string,
  options: StreamSendOptions,
): Promise<string> {
  const id = randomUUID();
  const file = eventFile(record);
  const handle = await open(file, "r");
  try {
    let offset = (await handle.stat()).size;
    let pending = "";
    const interruptId = randomUUID();
    const payload =
      (options.interrupt
        ? JSON.stringify({
            type: "control_request",
            request_id: interruptId,
            request: { subtype: "interrupt" },
          }) + "\n"
        : "") + userMessage(text, id);
    if (Buffer.byteLength(payload) > 1024 * 1024)
      throw new Error("ay send: stream message exceeds 1 MiB");
    await options.write(payload);
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const size = (await handle.stat()).size;
      if (size < offset)
        throw new Error(
          "ay send: stream event log was truncated; delivery is unknown, do not resend automatically",
        );
      if (size > offset) {
        const buffer = Buffer.alloc(Math.min(size - offset, 256 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        pending += buffer.subarray(0, bytesRead).toString("utf8");
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "user" && event.id === id) return id;
          } catch {}
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `ay send: no replay receipt for ${id}; delivery is unknown, do not resend automatically`,
    );
  } finally {
    await handle.close();
  }
}
