// Make bun-global CLIs (ay, cy, the *-yes family, qq, rech, …) resolvable from
// EVERY shell context, including the hard case: non-interactive non-login shells
// and Claude Code's Bash tool.
//
// Why this is needed: Claude Code's Bash tool sources a per-session shell
// *snapshot* that statically `export`s a PATH captured at session start. If that
// PATH didn't include `~/.bun/bin` (e.g. the session was spawned from a context
// whose PATH lacked it), every bun-global CLI is "command not found" — even
// though an interactive login shell would have them. There is no bash file that
// reliably augments PATH for non-interactive non-login shells.
//
// The robust fix: symlink the bun-global bins into `/usr/local/bin`, which is on
// PATH in EVERY context — the bare non-login default
// (`/usr/local/bin:/usr/local/sbin:/usr/bin:…`), every snapshot, and login
// shells. Non-clobbering (never overwrites an existing entry) and best-effort
// (a scheduling/permission hiccup must never break setup). POSIX only — Windows
// uses a different PATH model and isn't the reported failure surface.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Did a (now-dangling) symlink at `linkPath` point into `dir`? Used to adopt
 * only stale links we previously created, never a foreign broken link. */
function danglingPointsInto(linkPath: string, dir: string): boolean {
  try {
    const oldTarget = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
    return path.resolve(path.dirname(oldTarget)) === path.resolve(dir);
  } catch {
    return false;
  }
}

/** The directory bun installs global binaries into, or null if absent. */
export function bunBinDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const install = env.BUN_INSTALL || path.join(homedir(), ".bun");
  const dir = path.join(install, "bin");
  return existsSync(dir) ? dir : null;
}

export interface LinkResult {
  target: string;
  linked: string[]; // names newly symlinked
  skipped: string[]; // names already present (not ours to touch)
  refreshed: string[]; // our own dangling/stale symlinks repointed
}

/**
 * Symlink each entry of the bun-global bin dir into `target` (default
 * /usr/local/bin). Skips a name that already exists UNLESS it's a symlink we
 * previously created into the same bun dir (those we refresh, so a rebuilt/moved
 * bun bin stays valid). Returns null on an unsupported platform or when neither
 * the bun dir nor the target is usable. Never throws.
 */
export function linkBunBinsToSystemPath(opts?: {
  bunDir?: string | null;
  target?: string;
  env?: NodeJS.ProcessEnv;
}): LinkResult | null {
  if (process.platform === "win32") return null;
  const env = opts?.env ?? process.env;
  const bunDir = opts?.bunDir ?? bunBinDir(env);
  if (!bunDir) return null;
  const target = opts?.target ?? "/usr/local/bin";

  try {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  } catch {
    return null; // can't create the target dir (permissions) — best-effort give up
  }

  const result: LinkResult = { target, linked: [], skipped: [], refreshed: [] };
  let entries: string[];
  try {
    entries = readdirSync(bunDir);
  } catch {
    return null;
  }

  for (const name of entries) {
    const src = path.join(bunDir, name);
    const dest = path.join(target, name);
    let existing: ReturnType<typeof lstatSync> | null = null;
    try {
      existing = lstatSync(dest);
    } catch {
      existing = null; // dest absent
    }
    if (existing) {
      // Only touch a symlink WE own (points back into this bun dir). Anything
      // else (a real binary, or a link elsewhere) is not ours to replace.
      let ours = false;
      if (existing.isSymbolicLink()) {
        try {
          ours = path.resolve(target, readlinkSync(dest)) === src;
        } catch {
          ours = false;
        }
      }
      if (ours) {
        result.skipped.push(name); // already correctly linked — nothing to do
      } else if (
        existing.isSymbolicLink() &&
        !existsSync(dest) &&
        danglingPointsInto(dest, bunDir)
      ) {
        // A dangling symlink that USED to point into our bun dir (a bin that
        // moved/rebuilt) — repoint it. We check the old target dir so we never
        // hijack an unrelated broken link that merely shares a name.
        try {
          unlinkSync(dest);
          symlinkSync(src, dest);
          result.refreshed.push(name);
        } catch {
          result.skipped.push(name);
        }
      } else {
        result.skipped.push(name); // a real/foreign entry — never clobber
      }
      continue;
    }
    try {
      symlinkSync(src, dest);
      result.linked.push(name);
    } catch {
      result.skipped.push(name); // permission/race — best effort
    }
  }
  return result;
}
