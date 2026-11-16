import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { agentYesHome } from "../agentYesHome.ts";
import { appendGlobalPid, updateGlobalPidStatus } from "../globalPidIndex.ts";
import { nativeFlagValue } from "./launch.ts";
import { ClaudeAdapter } from "./claude.ts";
import { renderEvent } from "./transcript.ts";
import { register as registerReaper } from "../reaper.ts";
import { derivePermissions } from "../agentPermissions.ts";
import { stripClaudeSessionPin } from "../sessionEnv.ts";
import type { AyEvent } from "./types.ts";

export interface StreamRunOptions {
  cwd: string;
  cli: string;
  cliArgs: string[];
  prompt?: string;
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

/** A pipe-backed session, with the same discovery/FIFO paths as PTY sessions. */
export async function runStream(options: StreamRunOptions): Promise<number> {
  if (options.cli !== "claude") throw new Error("--stream currently supports claude only");
  if (process.platform === "win32") throw new Error("--stream currently requires a POSIX FIFO");
  const jsonInput = nativeFlagValue(options.cliArgs, "--input-format") === "stream-json";
  const replay = options.cliArgs.includes("--replay-user-messages");
  const args = [...options.cliArgs];
  if (!jsonInput && options.prompt) args.push(options.prompt);
  const adapter = new ClaudeAdapter();
  const child = adapter.spawn({
    cwd: options.cwd,
    args,
    binary: options.binary,
    env: stripClaudeSessionPin({
      ...process.env,
      ...options.env,
      AGENT_YES_PID: String(process.pid),
    }),
  });
  // Attach immediately: ENOENT can arrive before any filesystem setup finishes.
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  void exited.catch(() => {});
  const pid = child.pid;
  if (!pid) return exited;
  const dir = path.join(options.cwd, ".agent-yes");
  const base = path.join(dir, String(pid));
  const fifo = path.join(agentYesHome(), "fifo", `${pid}.stdin`);
  let fd: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const logs: ReturnType<typeof createWriteStream>[] = [];
  const stop = () => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.dirname(fifo), { recursive: true });
    const mkfifo = spawnSync("mkfifo", ["-m", "600", fifo]);
    if (mkfifo.status !== 0)
      throw new Error(`Cannot create stream FIFO: ${mkfifo.stderr?.toString()}`);
    fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    const events = createWriteStream(`${base}.events.jsonl`, { mode: 0o600 });
    const native = createWriteStream(`${base}.native.jsonl`, { mode: 0o600 });
    const raw = createWriteStream(`${base}.raw.log`, { mode: 0o600 });
    logs.push(events, native, raw);
    const writeLog = (log: ReturnType<typeof createWriteStream>, text: string | Buffer) => {
      if (!log.write(text)) {
        child.stdout.pause();
        child.stderr.pause();
      }
    };
    for (const log of logs) {
      log.on("error", stop);
      log.on("drain", () => {
        if (logs.every((stream) => !stream.writableNeedDrain)) {
          child.stdout.resume();
          child.stderr.resume();
        }
      });
    }
    const emit = (event: AyEvent) => {
      writeLog(events, JSON.stringify(event) + "\n");
      const text = renderEvent(event);
      writeLog(raw, text);
      process.stdout.write(text);
    };
    let pending = "";
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        writeLog(native, line + "\n");
        for (const event of adapter.parse(line)) emit(event);
      }
    });
    child.stdout.on("end", () => {
      pending += decoder.end();
      if (pending.trim()) {
        writeLog(native, pending + "\n");
        for (const event of adapter.parse(pending)) emit(event);
      }
      pending = "";
    });
    child.stderr.on("data", (chunk: Buffer) => {
      writeLog(raw, chunk);
      process.stderr.write(chunk);
    });
    child.stdin.on("error", stop);
    let input = "";
    const inputDecoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(65536);
    timer = setInterval(() => {
      try {
        let count: number;
        while ((count = readSync(fd!, buffer, 0, buffer.length, null)) > 0) {
          input += inputDecoder.write(buffer.subarray(0, count));
          let end: number;
          while ((end = input.indexOf("\n")) !== -1) {
            const line = input.slice(0, end);
            input = input.slice(end + 1);
            try {
              const d = JSON.parse(line);
              if (d.type === "user" && typeof d.message?.content === "string")
                adapter.send(d.message.content, d.uuid);
              else if (d.type === "control_request" && d.request?.subtype === "interrupt")
                child.stdin.write(line + "\n");
              else emit({ type: "error", message: "Unsupported stream input", fatal: false });
            } catch {
              emit({ type: "error", message: "Invalid stream input JSON", fatal: false });
            }
          }
          if (input.length > 1024 * 1024) {
            input = "";
            emit({ type: "error", message: "Stream input exceeds limit", fatal: false });
          }
        }
      } catch (error: any) {
        if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") stop();
      }
    }, 20);
    await registerReaper(process.pid, pid);
    await appendGlobalPid({
      pid,
      cli: options.cli,
      mode: "stream",
      permissions: derivePermissions({ cliArgs: options.cliArgs, robust: false }),
      prompt: options.prompt ?? null,
      cwd: options.cwd,
      log_file: `${base}.raw.log`,
      fifo_file: jsonInput && replay ? fifo : null,
      status: "active",
      exit_code: null,
      exit_reason: null,
      started_at: Date.now(),
      wrapper_pid: process.pid,
      parent_pid: Number(process.env.AGENT_YES_PID) || null,
      agent_id: randomUUID().replaceAll("-", "").slice(0, 12),
    });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (jsonInput && options.prompt) adapter.send(options.prompt);
    if (!jsonInput) child.stdin.end();
    const code = await exited;
    if (code) emit({ type: "error", message: `Claude exited (${code})`, fatal: true });
    await updateGlobalPidStatus(pid, {
      status: "exited",
      exit_code: code,
      exit_reason: "stream-exit",
    });
    return code;
  } finally {
    if (timer) clearInterval(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(fifo);
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) stop();
    // Never join stdout: descendants may retain its pipe after the child exits.
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    await Promise.all(
      logs.map(async (log) => {
        log.end();
        if (!log.closed) await once(log, "close").catch(() => {});
      }),
    );
  }
}
