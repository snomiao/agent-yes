import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { GlobalPidRecord } from "../globalPidIndex.ts";
import { readStreamSnapshot, eventFile } from "./state.ts";
import { readCumulativeCost } from "./cost.ts";

it("reads cost without a writable checkpoint and skips malformed and unfinished records", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-cost-checkpoint-"));
  const file = path.join(cwd, "events.jsonl");
  try {
    expect(await readCumulativeCost(file, 1)).toBeUndefined();
    // A directory at the checkpoint path prevents replacement on every platform.
    await mkdir(file + ".cost-index.json");
    await writeFile(file, '\ninvalid\n{"type":"turn_end","costUsd":"wrong"}\n');
    expect(await readCumulativeCost(file, 1)).toBeUndefined();
    await appendFile(
      file,
      JSON.stringify({ type: "text", text: "x".repeat(128 * 1024) }) +
        '\n{"type":"turn_end","costUsd":0.125}\n{"type":"turn_end","costUsd":1e999}\npartial',
    );
    expect(await readCumulativeCost(file, 1)).toBe(0.125);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("retains the latest cumulative result across long turns, fresh readers and cache rebuilds", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-cost-"));
  const record = {
    cwd,
    pid: 1111,
    started_at: 1,
    log_file: path.join(cwd, "1111.raw.log"),
  } as GlobalPidRecord;
  const file = eventFile(record),
    index = file + ".cost-index.json";
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const freshReader = () => {
    const module = pathToFileURL(path.resolve("ts/stream/state.ts")).href;
    const child = spawnSync(
      "bun",
      [
        "-e",
        `import {readStreamSnapshot} from ${JSON.stringify(module)};console.log(JSON.stringify(await readStreamSnapshot(${JSON.stringify(record)})));`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  };
  try {
    await writeFile(file, line({ type: "turn_end", turn: 1, costUsd: 0.125 }));
    expect(await readStreamSnapshot(record)).toMatchObject({ state: "idle", costUsd: 0.125 });
    await appendFile(
      file,
      line({ type: "turn_start", turn: 2, ts: 0 }) +
        Array.from({ length: 72 }, () => line({ type: "text", text: "x".repeat(4096) })).join(""),
    );
    expect(await readStreamSnapshot(record)).toMatchObject({ state: "active", costUsd: 0.125 });
    expect(freshReader()).toMatchObject({ state: "active", costUsd: 0.125 });
    await unlink(index);
    expect(freshReader()).toMatchObject({ state: "active", costUsd: 0.125 });
    await appendFile(file, line({ type: "turn_end", turn: 2, costUsd: 0.25 }));
    expect(await readStreamSnapshot(record)).toMatchObject({ state: "idle", costUsd: 0.25 });
    await appendFile(file, '{"type":"turn_end","turn":3,"costUsd":0.5');
    expect((await readStreamSnapshot(record)).costUsd).toBe(0.25);
    await appendFile(file, "}\n");
    expect((await readStreamSnapshot(record)).costUsd).toBe(0.5);
    await writeFile(index, '{"broken":true}');
    expect((await readStreamSnapshot(record)).costUsd).toBe(0.5);
    await writeFile(file, line({ type: "turn_start", turn: 1, ts: 0 }));
    expect((await readStreamSnapshot(record)).costUsd).toBeUndefined();
    const replacement = path.join(cwd, "replacement");
    await writeFile(replacement, line({ type: "turn_end", turn: 1, costUsd: 0.75 }));
    await rename(replacement, file);
    expect((await readStreamSnapshot(record)).costUsd).toBe(0.75);
    // A corrupted witness pointer cannot manufacture a cost from the checkpoint.
    const checkpoint = JSON.parse(await readFile(index, "utf8"));
    await writeFile(index, JSON.stringify({ ...checkpoint, witness: { start: 0, length: 1 } }));
    expect((await readStreamSnapshot(record)).costUsd).toBe(0.75);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
