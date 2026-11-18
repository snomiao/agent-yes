import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runStream } from "./runner.ts";

it.skipIf(process.platform === "win32")(
  "drains every burst record and the final result before closing logs",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-burst-"));
    const previous = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = cwd;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const entry = path.join(cwd, "burst.cjs");
      await writeFile(
        entry,
        `const fs=require('node:fs');for(let i=0;i<512;i++)fs.writeSync(1,JSON.stringify({type:'assistant',message:{content:[{type:'text',text:String(i)+':'+ 'x'.repeat(8192)}]}})+'\\n');fs.writeSync(1,JSON.stringify({type:'result',is_error:false,total_cost_usd:0.125})+'\\n');process.exit(0);`,
      );
      expect(
        await runStream({ cwd, cli: "claude", binary: process.execPath, cliArgs: [entry] }),
      ).toBe(0);
      const record = JSON.parse(
        (await readFile(path.join(cwd, "pids.jsonl"), "utf8")).trim().split("\n").at(-1)!,
      );
      const native = (await readFile(record.log_file.replace(".raw.log", ".native.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(native).toHaveLength(513);
      expect(native.at(-1)).toMatchObject({ type: "result", total_cost_usd: 0.125 });
      const events = (await readFile(record.log_file.replace(".raw.log", ".events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === "text")).toHaveLength(512);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", costUsd: 0.125 });
      expect(await readFile(record.log_file, "utf8")).toContain(
        "assistant: 511:" + "x".repeat(8192),
      );
    } finally {
      out.mockRestore();
      if (previous === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
