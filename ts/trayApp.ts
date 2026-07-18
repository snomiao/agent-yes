// `ay tray` — control the native agent-yes system-tray companion (the Rust
// `agent-yes-tray` binary). This supersedes the legacy systray2 tray in tray.ts
// (which busy-loops under Bun and is disabled by default).
//
// The tray auto-shows on desktop sessions when `ay serve` is installed (launched
// by `ay serve install`). Users can hide it — from its own menu or `ay tray hide`
// — which persists a marker and quits the process until `ay tray show`.
//
// Persistence: `~/.agent-yes/tray.hidden` (present = user hid it). The Rust tray
// reads the SAME marker (via AGENT_YES_HOME / homedir) to gate whether it shows.

import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentYesHome } from "./agentYesHome.ts";
import { findTrayLauncher } from "./rustBinary.ts";

/** Marker whose PRESENCE means the user has hidden the tray. */
export function trayHiddenMarker(): string {
  return path.join(agentYesHome(), "tray.hidden");
}

export function isTrayHidden(): boolean {
  return existsSync(trayHiddenMarker());
}

/** A desktop session we can show a tray on. Windows/macOS always; Linux needs a
 *  display server. Headless servers → no tray. */
export function hasDesktop(): boolean {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Launch the native tray (detached, window-less) if it makes sense to: a desktop
 * session, the tray binary exists, and the user hasn't hidden it. No-op otherwise.
 * The tray also self-gates on `ay serve status`, so this is best-effort. Returns
 * true if a process was spawned.
 */
export function launchTray(): boolean {
  if (!hasDesktop() || isTrayHidden()) return false;
  const bin = findTrayLauncher();
  if (!bin) return false;
  try {
    // The tray is a GUI-subsystem binary → no console window even when detached,
    // so no ay-spawn-hidden wrapper is needed here.
    const child = Bun.spawn([bin], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Stop any running native tray process(es). */
async function stopTray(): Promise<void> {
  const argv =
    process.platform === "win32"
      ? ["taskkill", "/IM", "agent-yes-tray.exe", "/F"]
      : ["pkill", "-f", "agent-yes-tray"];
  try {
    await Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).exited;
  } catch {
    /* nothing running */
  }
}

export async function cmdTray(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  const w = (s = "") => process.stdout.write(s + "\n");

  if (sub === "show") {
    await unlink(trayHiddenMarker()).catch(() => {});
    if (!hasDesktop()) {
      process.stderr.write(
        "ay tray show: no desktop session detected (headless) — nothing to show\n",
      );
      return 1;
    }
    if (!findTrayLauncher()) {
      process.stderr.write(
        "ay tray show: tray binary not found — build it with\n" +
          "  cargo build --release --manifest-path rs-tray/Cargo.toml\n",
      );
      return 1;
    }
    const ok = launchTray();
    w(ok ? "tray shown." : "tray not launched (already running, or serve not installed).");
    w("hint: the tray auto-shows on desktop sessions whenever `ay serve` is installed.");
    return 0;
  }

  if (sub === "hide") {
    await writeFile(trayHiddenMarker(), "hidden by `ay tray hide`\n").catch(() => {});
    await stopTray();
    w("tray hidden — it will stay hidden until `ay tray show`.");
    return 0;
  }

  if (sub === "status") {
    w(`hidden:   ${isTrayHidden() ? "yes (run `ay tray show` to re-enable)" : "no"}`);
    w(`desktop:  ${hasDesktop() ? "yes" : "no (headless)"}`);
    w(`binary:   ${findTrayLauncher() ?? "(not found — not built for this platform)"}`);
    return 0;
  }

  process.stderr.write(`ay tray: unknown subcommand '${sub}' (use show | hide | status)\n`);
  return 1;
}
