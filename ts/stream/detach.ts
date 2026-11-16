import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readGlobalPids, type GlobalPidRecord } from "../globalPidIndex.ts";

/** Start a TS wrapper and return only once its canonical CLI pid is discoverable. */
export async function detachStream(options: {
  entry: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<GlobalPidRecord> {
  const dir = path.join(options.cwd, ".agent-yes");
  mkdirSync(dir, { recursive: true });
  const errorFile = path.join(dir, `stream-start-${randomUUID()}.log`);
  const errorFd = openSync(errorFile, "wx", 0o600);
  const child = spawn(process.execPath, [options.entry, ...options.args], {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "ignore", errorFd],
    env: { ...process.env, AGENT_YES_ATTACH: "1", AGENT_YES_NO_CWD_WARN: "1" },
  });
  closeSync(errorFd);
  let failure: string | undefined;
  child.on("error", (error) => {
    failure = error.message;
  });
  child.on("exit", (code, signal) => {
    failure = `wrapper exited (${signal ?? code})`;
  });
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  try {
    while (Date.now() < deadline) {
      const record = (await readGlobalPids()).find((record) => record.wrapper_pid === child.pid);
      if (record && (record.status !== "exited" || record.exit_code === 0)) return record;
      if (record?.status === "exited") failure = `CLI exited (${record.exit_code})`;
      if (failure) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const detail = (await readFile(errorFile, "utf8").catch(() => "")).trim().slice(-1500);
    // This wrapper was started here; a timeout must not leave a hidden startup running.
    child.kill("SIGTERM");
    throw new Error(
      `Stream launch failed: ${failure ?? "no agent registered within the startup timeout"}${detail ? `\n${detail}` : ""}`,
    );
  } finally {
    child.unref();
  }
}
