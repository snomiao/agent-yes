import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { detachStream } from "./detach.ts";

it("confirms detached registration and reports early exits and startup timeouts", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-detach-"));
  const previous = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = cwd;
  let pid: number | undefined;
  try {
    const entry = path.join(cwd, "worker.cjs");
    await writeFile(
      entry,
      `const fs = require('node:fs');
if (process.argv[2] === 'fail') { console.error('fixture startup failure'); process.exit(2); }
if (process.argv[2] !== 'wait') fs.appendFileSync(process.env.AGENT_YES_HOME + '/pids.jsonl', JSON.stringify({pid:process.pid,wrapper_pid:process.pid,cli:'claude',cwd:process.cwd(),started_at:Date.now(),status:'active',mode:'stream'})+'\\n');
setInterval(() => {}, 1000);`,
    );
    const record = await detachStream({ entry, args: [], cwd });
    pid = record.pid;
    expect(record.mode).toBe("stream");
    expect(() => process.kill(pid!, 0)).not.toThrow();
    await expect(detachStream({ entry, args: ["fail"], cwd })).rejects.toThrow(
      "fixture startup failure",
    );
    await expect(detachStream({ entry, args: ["wait"], cwd, timeoutMs: 150 })).rejects.toThrow(
      "no agent registered",
    );
  } finally {
    if (pid)
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    if (previous === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = previous;
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
