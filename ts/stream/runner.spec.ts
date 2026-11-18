import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { runStream } from "./runner.ts";

it.skipIf(process.platform === "win32")(
  "runs a pipe-backed child, registers stream mode and persists normalized/native/transcript logs",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-"));
    const previous = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = path.join(cwd, "home");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const mock = path.join(cwd, "mock.cjs");
      await writeFile(
        mock,
        `const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
 const user = JSON.parse(line);
 process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'example'})+'\\n');
 process.stdout.write(JSON.stringify(user)+'\\n');
 process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Hello.'}]}})+'\\n');
 process.stdout.write(JSON.stringify({type:'result',is_error:false,total_cost_usd:0.001})+'\\n');
 setTimeout(() => process.exit(0), 50);
});`,
      );
      expect(
        await runStream({
          cwd,
          cli: "claude",
          binary: process.execPath,
          cliArgs: [mock, "--input-format", "stream-json", "--replay-user-messages"],
          prompt: "Hello",
        }),
      ).toBe(0);
      const record = JSON.parse(
        (await readFile(path.join(cwd, "home", "pids.jsonl"), "utf8")).trim().split("\n").at(-1)!,
      );
      expect(record).toMatchObject({ mode: "stream", status: "exited", exit_code: 0 });
      expect(await readFile(record.log_file, "utf8")).toContain("assistant: Hello.");
      const events = await readFile(record.log_file.replace(".raw.log", ".events.jsonl"), "utf8");
      expect(events).toContain('"type":"turn_end"');
      expect(
        await readFile(record.log_file.replace(".raw.log", ".native.jsonl"), "utf8"),
      ).toContain('"type":"result"');
    } finally {
      stdout.mockRestore();
      if (previous === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "captures output-only native streams without adding CLI flags or advertising JSON input",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-output-"));
    const previous = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = path.join(cwd, "home");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const mock = path.join(cwd, "output.cjs");
      await writeFile(
        mock,
        `const chunks=[];
process.stdin.on('data',chunk=>chunks.push(chunk));
process.stdin.on('end', () => {
 process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:JSON.stringify({args:process.argv.slice(2),input:Buffer.concat(chunks).toString('utf8')})}]}})+'\\n');
 process.stdout.write(JSON.stringify({type:'result',is_error:false})+'\\n');
});`,
      );
      expect(
        await runStream({
          cwd,
          cli: "claude",
          binary: process.execPath,
          cliArgs: [mock, "--output-format", "stream-json"],
          prompt: "hello",
          input: Readable.from(["piped\ntext"]),
        }),
      ).toBe(0);
      const record = JSON.parse(
        (await readFile(path.join(cwd, "home", "pids.jsonl"), "utf8")).trim().split("\n").at(-1)!,
      );
      expect(record.fifo_file).toBeNull();
      expect(await readFile(record.log_file, "utf8")).toContain(
        'assistant: {"args":["--output-format","stream-json","hello"],"input":"piped\\ntext"}',
      );
    } finally {
      stdout.mockRestore();
      if (previous === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it("rejects unsupported adapters before spawning", async () => {
  await expect(runStream({ cwd: process.cwd(), cli: "other", cliArgs: [] })).rejects.toThrow(
    "supports claude only",
  );
});

it.skipIf(process.platform !== "win32")(
  "reports the POSIX transport requirement on Windows",
  async () => {
    await expect(runStream({ cwd: process.cwd(), cli: "claude", cliArgs: [] })).rejects.toThrow(
      "POSIX FIFO",
    );
  },
);
