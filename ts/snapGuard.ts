import { homedir } from "os";
import path from "path";

/**
 * Detects that we're running inside a *strictly confined* snap (snapd's default
 * sandbox), which quietly breaks agent-yes in three ways:
 *
 *  1. snapd remaps `$HOME` to the snap's per-revision data dir
 *     (`~/snap/<name>/<revision>`), so `homedir()` — and therefore
 *     {@link agentYesHome}, the workspace root, the pid index, the FIFO IPC
 *     endpoints and the serve token — all land inside the sandbox.
 *  2. That path is keyed to the snap *revision*: after a `snap refresh` a fresh
 *     CLI invocation resolves to the new revision's dir while an already-running
 *     daemon keeps writing to the old one. Split-brain, with no error either side.
 *  3. Every agent we spawn inherits the snap's AppArmor profile and mount
 *     namespace — fatal for a tool whose whole job is launching agents into
 *     arbitrary worktrees.
 *
 * There is no path rewrite that fixes this: the sandbox HOME is the only
 * reliably writable location (the `home` interface grants *non-hidden* files
 * only, so a "corrected" `~/.agent-yes` would just be denied). The only real fix
 * is to install the runtime natively, so we detect and say so.
 */
export interface SnapConfinement {
  /** Snap package name, e.g. `bun-js`. */
  name: string;
  /** Snap revision — the trailing number of the sandbox HOME. */
  revision?: string;
  /** The remapped HOME (`$SNAP_USER_DATA`), e.g. `/root/snap/bun-js/87`. */
  home: string;
}

/** Matches a snap user-data HOME: `…/snap/<name>/<revision>`. */
const SNAP_HOME_RE = /(?:^|[\\/])snap[\\/]([^\\/]+)[\\/]([^\\/]+)$/;

/**
 * Returns the confinement details when the current process is a strictly
 * confined snap, else null.
 *
 * *Classic* confinement is deliberately NOT reported: classic snaps export the
 * same `SNAP_*` env but are not sandboxed and leave `$HOME` alone, so they need
 * no warning. The remapped HOME is both the symptom and the discriminator.
 */
export function detectSnapConfinement(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): SnapConfinement | null {
  if (!env.SNAP_NAME?.trim() && !env.SNAP?.trim()) return null;
  const abs = path.resolve(home);
  const userData = env.SNAP_USER_DATA?.trim();
  // HOME still pointing at the real home => classic confinement => not our problem.
  const remapped = userData ? path.resolve(userData) === abs : SNAP_HOME_RE.test(abs);
  if (!remapped) return null;
  const m = SNAP_HOME_RE.exec(abs);
  return {
    name: env.SNAP_NAME?.trim() || m?.[1] || "snap",
    revision: env.SNAP_REVISION?.trim() || m?.[2],
    home: abs,
  };
}

/** The native (non-snap) install command for a runtime, when we recognize it. */
function nativeInstall(name: string): string {
  if (/bun/i.test(name)) return `curl -fsSL https://bun.sh/install | bash`;
  if (/^node/i.test(name)) return `curl -fsSL https://fnm.vercel.app/install | bash`;
  return `# reinstall ${name} from its official installer (not snap)`;
}

/** Operator-facing explanation + the exact commands to get out of the sandbox. */
export function snapConfinementMessage(snap: SnapConfinement): string {
  const rev = snap.revision ? ` (revision ${snap.revision})` : "";
  return (
    `\n!  running inside the '${snap.name}' snap sandbox${rev}\n\n` +
    `   snap remapped HOME to ${snap.home}, so agent-yes would keep its fleet\n` +
    `   state — config, pid index, FIFO IPC, serve token — inside the sandbox, and\n` +
    `   every agent it spawns would inherit the snap's AppArmor profile and mount\n` +
    `   namespace. Agents need to reach your real worktrees; confined ones can't.\n\n` +
    `   Install ${snap.name} natively instead:\n\n` +
    `     sudo snap remove ${snap.name}\n` +
    `     ${nativeInstall(snap.name)}\n` +
    `     exec $SHELL -l\n` +
    `     ay setup\n\n`
  );
}
