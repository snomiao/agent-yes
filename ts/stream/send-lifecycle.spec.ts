import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "sends plain JSON with a replay receipt after an older writer erases stream mode",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-send-live-"));
    const home = path.join(cwd, "home");
    const capture = path.join(cwd, "capture.jsonl");
    const cli = path.resolve("ts/cli.ts");
    const children: ChildProcess[] = [];
    let ownedPid: number | undefined;
    const env = {
      ...process.env,
      AGENT_YES_HOME: home,
      AGENT_YES_PID: "1111",
      AGENT_YES_ATTACH: "1",
      AGENT_YES_NO_UPDATE: "1",
      AGENT_YES_NO_CWD_WARN: "1",
      AY_STREAM_TEST_CAPTURE: capture,
    };
    const start = (args: string[]) => {
      const child = spawn("bun", [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "",
        error = "";
      child.stdout!.on("data", (data) => {
        output += data.toString();
      });
      child.stderr!.on("data", (data) => {
        error += data.toString();
      });
      const exit = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      return { exit, output: () => output, error: () => error };
    };
    const records = async () => {
      const text = await readFile(path.join(home, "pids.jsonl"), "utf8").catch(() => "");
      const rows = new Map();
      for (const line of text.trim().split("\n"))
        try {
          const row = JSON.parse(line);
          rows.set(row.pid, row);
        } catch {}
      return [...rows.values()];
    };
    const waitFor = async (status: string) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const record = (await records()).find(
          (record) => record.wrapper_pid !== 1111 && record.status === status,
        );
        if (record) return record;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No stream record reached ${status}`);
    };
    try {
      await mkdir(home);
      const parent = {
        pid: process.pid,
        wrapper_pid: 1111,
        agent_id: "abcdef000001",
        cli: "claude",
        cwd,
        status: "active",
        started_at: Date.now(),
        log_file: null,
        prompt: null,
        exit_code: null,
        exit_reason: null,
      };
      await writeFile(path.join(home, "pids.jsonl"), JSON.stringify(parent) + "\n");
      const mock = path.join(cwd, "mock-claude");
      await copyFile(new URL("./fixtures/strict-claude.cjs", import.meta.url), mock);
      await chmod(mock, 0o755);
      await writeFile(
        path.join(cwd, ".agent-yes.config.json"),
        JSON.stringify({ clis: { claude: { binary: mock } } }),
      );
      const session = start([
        "claude",
        "--",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
        "Initial plain task",
      ]);
      const record = await waitFor("idle");
      ownedPid = record.pid;
      expect(record.mode).toBe("stream");
      // Reproduce an installed legacy wrapper's truncating rewrite, not an artificial send stub.
      await writeFile(
        path.join(home, "pids.jsonl"),
        [parent, { ...record, mode: null, status: "active" }]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      const second = start([
        "send",
        String(record.pid),
        "Second\nplain task",
        "--force",
        "--interrupt",
      ]);
      expect(await second.exit, second.error()).toBe(0);
      expect(second.output()).toContain("replay receipt");
      const updated = await waitFor("idle");
      expect(updated.mode).toBe("stream");
      const messages = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(messages.map((message) => message.message.content)).toEqual([
        "Initial plain task",
        "Second\nplain task",
      ]);
      expect(await readFile(record.log_file, "utf8")).not.toContain("Invalid stream input JSON");
      expect(session.error()).not.toContain("Invalid stream input JSON");
      const finish = start(["send", String(record.pid), "finish", "--force"]);
      expect(await finish.exit, finish.error()).toBe(0);
      await waitFor("exited");
      expect(await session.exit).toBe(0);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
      if (ownedPid)
        try {
          process.kill(-ownedPid, "SIGTERM");
        } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
