import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/**
 * Snapshot of the CURRENT process.env for child spawns. Bun.spawn without an
 * explicit `env` hands the child the environ captured at PROCESS STARTUP — not
 * the live process.env — so post-startup mutations (ensureNodeRuntime's shim
 * PATH prepend, installAndVerify's global-bin-dir prepend) silently never reach
 * the child. That is exactly how `ay serve install` kept dying with
 * `env: node: No such file or directory` at the `pm2 start` spawn on a bun-only
 * box even though the probe (which passes env explicitly) had just succeeded.
 * Every spawn of a process-manager binary must pass `env: liveEnv()`.
 */
export function liveEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/**
 * Both oxmgr's and pm2's global bins are `#!/usr/bin/env node` JS scripts, so on
 * a bun-only box (setup.sh installs no node) exec dies with "env: node: No such
 * file or directory" — even though pm2 is pure JS and runs perfectly under bun.
 * When node is missing but bun exists, write a node→bun shim into ay's own bin
 * dir and prepend it to PATH so `env node` resolves. NOT solvable with
 * `bun add -g node`: that package (node-bin-gen) lands a broken arch-specific
 * stub and `Bun.which("node")` still finds nothing. POSIX-only — on Windows the
 * npm .cmd shims invoke node.exe directly and an sh script can't stand in.
 * Read-only paths (`ay serve status`) also reach this via the manager probes:
 * an up-to-date shim is left untouched there (a read, not a write), so only the
 * very first run on a node-less box materializes the file.
 * Returns the shim path when the shim is in effect, null when unneeded/impossible.
 */
export async function ensureNodeRuntime(
  which: (cmd: string) => string | null = Bun.which,
): Promise<string | null> {
  if (process.platform === "win32") return null;
  if (which("node")) return null;
  const bun = which("bun");
  if (!bun) return null;
  const binDir = path.join(agentYesHome(), "bin");
  const shim = path.join(binDir, "node");
  // Single-quote the bun path: inside sh double quotes `$`, backtick and `\`
  // would still expand, corrupting the shim for a path containing them.
  const body = `#!/bin/sh\nexec '${bun.replace(/'/g, `'\\''`)}' "$@"\n`;
  try {
    if ((await readFile(shim, "utf-8").catch(() => null)) !== body) {
      await mkdir(binDir, { recursive: true });
      await writeFile(shim, body);
      await chmod(shim, 0o755);
    }
    if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDir)) {
      process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    }
    return shim;
  } catch {
    return null; // best-effort: the exec probe will fail and name the reason
  }
}
