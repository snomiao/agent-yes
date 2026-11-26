import { realpathSync, statSync } from "fs";
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

/**
 * The oxmgr binary to exec. `bun add -g oxmgr` puts a `#!/usr/bin/env node`
 * JS launcher on PATH whose only job is to spawn the native binary it vendors
 * at `<pkg>/vendor/oxmgr`. On a bun-only host that launcher dies with
 * "env: 'node': No such file or directory" unless the node→bun shim is on PATH
 * (see ensureNodeRuntime) — and a supervisor/health probe or the user's own
 * shell does not have it. Exec the vendored native binary directly instead
 * whenever the launcher resolves to one: no JS runtime is involved at all.
 * Falls back to the PATH entry (a cargo-installed native oxmgr, the Windows
 * .exe shim, or a launcher whose vendor binary is missing). Pure apart from the
 * injected fs probes, so it is unit-testable.
 */
export function resolveOxmgrBin(
  which: (cmd: string) => string | null = Bun.which,
  fs: { realpath: (p: string) => string; isFile: (p: string) => boolean } = {
    realpath: (p) => realpathSync(p),
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  },
  platform: NodeJS.Platform = process.platform,
): string | null {
  const bin = which("oxmgr");
  if (!bin) return null;
  let real = bin;
  try {
    real = fs.realpath(bin);
  } catch {
    return bin;
  }
  const vendored = path.join(
    path.dirname(real),
    "..",
    "vendor",
    platform === "win32" ? "oxmgr.exe" : "oxmgr",
  );
  return /\.[cm]?js$/.test(real) && fs.isFile(vendored) ? path.normalize(vendored) : bin;
}

/**
 * Env names forwarded to the `ay serve` daemon when it is registered with
 * oxmgr. oxmgr runs managed processes with the env its long-lived daemon was
 * started with plus the per-process map given via `--env` — NOT the env of the
 * shell that ran `ay serve install` — so settings like AGENT_YES_ICE_PUBLIC_IPS
 * set in that shell never reached the daemon. Forward ay's own settings
 * (AGENT_YES_* / AY_*, plus the CF_TURN_* relay credentials the share host
 * reads), minus names that describe ONE agent session or ONE command rather
 * than the host: forwarding AGENT_YES_PID from an install run inside an agent
 * would make the daemon think it is that agent, and a room join secret belongs
 * to one `--join` run. oxmgr keeps the values in its user-only (0600) state file.
 */
const DAEMON_ENV_EXTRA = new Set(["CF_TURN_KEY_ID", "CF_TURN_API_TOKEN"]);
const DAEMON_ENV_EXCLUDE = new Set([
  "AGENT_YES_PID",
  "AGENT_YES_AGENT_ID",
  "AGENT_YES_CWD",
  "AGENT_YES_CLI",
  "AGENT_YES_ATTACH",
  "AGENT_YES_UPDATED",
  "AGENT_YES_PORTLESS_CHILD",
  "AGENT_YES_REPORT_PARENT",
  "AGENT_YES_DAEMON_MANAGER",
  "AGENT_YES_NO_PM_BOOTSTRAP",
  "AGENT_YES_FORCE_SEND",
  "AGENT_YES_SEND_RAW",
  "AGENT_YES_SEND_NO_WAIT",
  "AY_TERM_TOKEN",
  "AY_CH_NAME",
  "AY_CH_LINK",
  "AY_ROOM",
  "AY_JOIN_SECRET",
]);

export function isDaemonEnvName(name: string): boolean {
  if (DAEMON_ENV_EXTRA.has(name)) return true;
  return /^(AGENT_YES|AY)_[A-Z0-9_]+$/.test(name) && !DAEMON_ENV_EXCLUDE.has(name);
}

/**
 * The env map to register the daemon with: the previous registration's
 * forwarded settings, overlaid by the ones in the current env. A re-run of
 * `ay share` / `ay serve install` from a shell without them (an upgrade, a
 * reconfigure) keeps them; setting a name to the empty string removes it.
 * Sorted, so comparing two results tells whether the config changed.
 */
export function daemonEnv(
  current: Record<string, string | undefined>,
  prior: Record<string, string> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(prior)) if (isDaemonEnvName(k)) merged[k] = v;
  for (const [k, v] of Object.entries(current)) {
    if (!isDaemonEnvName(k) || v === undefined) continue;
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}
