import { open } from "node:fs/promises";
import path from "node:path";
import type { GlobalPidRecord } from "../globalPidIndex.ts";
import type { LiveState } from "../lsWatch.ts";
import type { AyEvent } from "./types.ts";
import { readCumulativeCost } from "./cost.ts";

export function eventFile(record: Pick<GlobalPidRecord, "cwd" | "pid" | "log_file">): string {
  return (
    record.log_file?.replace(/\.(?:raw\.)?log$/, ".events.jsonl") ??
    path.join(record.cwd, ".agent-yes", `${record.pid}.events.jsonl`)
  );
}

/** Ignore partial append records. Bound status reads independently of session length. */
export async function readEvents(file: string, maxBytes = 256 * 1024): Promise<AyEvent[]> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return [];
  try {
    const size = (await handle.stat()).size;
    const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    lines.pop(); // A record is committed only once its newline is written.
    const events: AyEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event.type === "string") events.push(event);
      } catch {}
    }
    return events;
  } finally {
    await handle.close();
  }
}

export function streamSnapshot(events: AyEvent[]): {
  state: LiveState;
  question: string | null;
  costUsd?: number;
} {
  let state: LiveState = "active";
  let question: string | null = null;
  let costUsd: number | undefined;
  for (const event of events) {
    switch (event.type) {
      case "turn_start":
      case "text":
      case "tool_call":
      case "tool_result":
        state = "active";
        question = null;
        break;
      case "needs_input":
        state = "needs_input";
        question = event.question;
        break;
      case "needs_permission":
        state = "needs_input";
        question = `${event.tool}: ${JSON.stringify(event.input)}`;
        break;
      case "turn_end":
        state = "idle";
        question = null;
        // Claude reports cumulative session cost, so adding result costs would double-count.
        if (event.costUsd !== undefined) costUsd = event.costUsd;
        break;
      case "error":
        state = "stuck";
        question = event.message;
        break;
      // A session notification or queued user receipt does not change live state.
    }
  }
  return { state, question, costUsd };
}

export async function readStreamSnapshot(record: GlobalPidRecord) {
  const file = eventFile(record);
  const [events, costUsd] = await Promise.all([
    readEvents(file),
    readCumulativeCost(file, record.started_at),
  ]);
  return { ...streamSnapshot(events), costUsd };
}
