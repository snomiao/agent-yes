import { liveEnv } from "./nodeRuntime.ts";

export type StrayServeProcess = { pid: number; command: string };

const MANAGEMENT_COMMAND_RE = /\b(?:install|uninstall|status|logs|restart)\b/;

function isServeCommand(command: string): boolean {
  return (
    /\bay(?:\.js)?\s+serve\b/.test(command) ||
    /\bagent-yes(?:\.js)?\s+serve\b/.test(command) ||
    /\bagent-yes\.js\s+serve\b/.test(command)
  );
}

export function parseStrayServeProcesses(
  psOutput: string,
  opts: { selfPid: number; parentPid: number },
): StrayServeProcess[] {
  const ignoredPids = new Set([opts.selfPid, opts.parentPid]);
  const processes: StrayServeProcess[] = [];

  for (const line of psOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const pid = Number(match[1]);
    const command = match[2]!;
    if (!Number.isFinite(pid) || ignoredPids.has(pid)) continue;
    if (!isServeCommand(command)) continue;
    if (MANAGEMENT_COMMAND_RE.test(command)) continue;

    processes.push({ pid, command });
  }

  return processes;
}

export async function listStrayServeProcesses(): Promise<StrayServeProcess[]> {
  if (process.platform === "win32") return [];

  try {
    const ps = Bun.spawn(["ps", "-axo", "pid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
      env: liveEnv(),
    });
    const output = await new Response(ps.stdout).text();
    if ((await ps.exited) !== 0) return [];
    return parseStrayServeProcesses(output, {
      selfPid: process.pid,
      parentPid: process.ppid,
    });
  } catch {
    return [];
  }
}
