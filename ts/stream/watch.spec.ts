import { spawn } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("wakes ls --watch on event appends even when raw.log and the pid index stay unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ay-stream-watch-"));
  const log = path.join(dir, "1111.raw.log");
  const events = path.join(dir, "1111.events.jsonl");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writeFile(log, "assistant: working\n");
    await writeFile(events, '{"type":"turn_start","turn":1,"ts":0}\n');
    await writeFile(
      path.join(dir, "pids.jsonl"),
      JSON.stringify({
        pid: process.pid,
        cli: "claude",
        mode: "stream",
        cwd: dir,
        log_file: log,
        status: "active",
        exit_code: null,
        exit_reason: null,
        started_at: Date.now(),
      }) + "\n",
    );
    const cli = path.resolve("ts/cli.ts");
    child = spawn("bun", [cli, "ls", String(process.pid), "--watch", "--interval", "60"], {
      env: { ...process.env, AGENT_YES_HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const states: string[] = [];
    let pending = "";
    child.stdout!.on("data", (chunk) => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          states.push(JSON.parse(line).state);
        } catch {}
      }
    });
    const waitFor = async (state: string) => {
      const deadline = Date.now() + 5000;
      while (!states.includes(state) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(states).toContain(state);
    };
    await waitFor("active");
    // Let the independently spawned tail follower open its file before appending.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await appendFile(events, '{"type":"turn_end","turn":1}\n');
    await waitFor("idle");
  } finally {
    child?.kill("SIGTERM");
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 2000);
        child!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    await rm(dir, { recursive: true, force: true });
  }
});
