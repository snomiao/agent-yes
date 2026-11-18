import { open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";

interface Witness {
  start: number;
  length: number;
}
interface CostIndex {
  version: 1;
  dev: number;
  ino: number;
  startedAt: number;
  offset: number;
  anchor: string;
  witness: Witness | null;
}
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function anchorAt(file: FileHandle, offset: number): Promise<string> {
  const length = Math.min(128, offset);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset - length);
  return buffer.subarray(0, bytesRead).toString("base64");
}
function costOf(line: Buffer): number | undefined {
  try {
    const event = JSON.parse(line.toString("utf8"));
    if (
      event?.type === "turn_end" &&
      typeof event.costUsd === "number" &&
      Number.isFinite(event.costUsd)
    )
      return event.costUsd;
  } catch {}
  return undefined;
}

/** A rebuildable byte checkpoint; the cost itself is always read from its event witness. */
export async function readCumulativeCost(
  fileName: string,
  startedAt: number,
): Promise<number | undefined> {
  const file = await open(fileName, "r").catch(() => null);
  if (!file) return undefined;
  const indexFile = fileName + ".cost-index.json";
  try {
    const info = await file.stat();
    let cached: CostIndex | null = await readFile(indexFile, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    let cursor = 0,
      cost: number | undefined,
      witness: Witness | null = null;
    if (
      cached?.version === 1 &&
      cached.dev === info.dev &&
      cached.ino === info.ino &&
      cached.startedAt === startedAt &&
      integer(cached.offset) &&
      cached.offset <= info.size &&
      cached.anchor === (await anchorAt(file, cached.offset))
    ) {
      const candidate = cached.witness;
      if (candidate === null) cursor = cached.offset;
      else if (
        candidate &&
        integer(candidate.start) &&
        integer(candidate.length) &&
        candidate.length <= 1024 * 1024 &&
        candidate.start + candidate.length <= cached.offset
      ) {
        const buffer = Buffer.alloc(candidate.length);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, candidate.start);
        cost = costOf(buffer.subarray(0, bytesRead));
        if (cost !== undefined) {
          cursor = cached.offset;
          witness = candidate;
        } else cached = null;
      } else cached = null;
    } else cached = null;
    const initialCursor = cursor;
    let readOffset = cursor;
    let parts: Buffer[] = [],
      partBytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (readOffset < info.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - readOffset),
        readOffset,
      );
      if (!bytesRead) break;
      let start = 0;
      for (
        let end = buffer.indexOf(10, start);
        end !== -1 && end < bytesRead;
        end = buffer.indexOf(10, start)
      ) {
        const tail = buffer.subarray(start, end);
        const line = parts.length ? Buffer.concat([...parts, tail], partBytes + tail.length) : tail;
        const value = costOf(line);
        if (value !== undefined) {
          cost = value;
          witness = { start: cursor, length: line.length };
        }
        cursor = readOffset + end + 1;
        parts = [];
        partBytes = 0;
        start = end + 1;
      }
      if (start < bytesRead) {
        const part = Buffer.from(buffer.subarray(start, bytesRead));
        parts.push(part);
        partBytes += part.length;
      }
      readOffset += bytesRead;
    }
    if (!cached || cursor !== initialCursor) {
      const index: CostIndex = {
        version: 1,
        dev: info.dev,
        ino: info.ino,
        startedAt,
        offset: cursor,
        anchor: await anchorAt(file, cursor),
        witness,
      };
      const temporary = `${indexFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(index), { mode: 0o600, flag: "wx" });
        await rename(temporary, indexFile);
      } catch {
        /* A read-only directory must not make status or cost unavailable. */
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    return cost;
  } finally {
    await file.close();
  }
}
