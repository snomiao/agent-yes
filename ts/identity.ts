/**
 * The standardized agent identity string:
 *
 *   <username>@<hostname>:<path>:<branch>#<pid>
 *   e.g.  sno@Mac:~/ws/symval/symval/tree/crm:main#30402
 *
 * One line answers "who is this agent" across every surface that names one —
 * the `ay send` envelope header, `ay whoami`, logs. The branch segment usually
 * carries the lane name for free (worktree checkouts like `crm-yamamoto-wifi`
 * or `fix/t173-tone-core` name their purpose), which is why there is no
 * separate role concept.
 *
 * Parsing (right-to-left, for consumers that need it): `#<pid>` from the end;
 * the branch is after the last `:` (git forbids `:` in ref names); the
 * username is before the first `@`; the hostname is between that `@` and the
 * next `:` (hostnames contain no `:`). The path in the middle may itself
 * contain `@`/`:` (Windows drives), which is why parsing anchors on the ends.
 *
 * Every token is clamped before rendering: the identity is embedded in the
 * `<ay-msg …>` envelope's OPEN tag, which is not nonce-protected — whitespace
 * or `>` in a token could forge header structure.
 */

import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";

/** Replace anything outside a conservative charset so a token can never break
 * out of the envelope header line. Collapses runs to a single `-`.
 * Exported only so the shared cross-runtime case table
 * (tests/fixtures/identity-cases.json) can pin it against the Rust port. */
export function safeToken(raw: string, max: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, max);
}

/** The local username, header-safe ("John Smith" → "John-Smith"). */
export function localUser(): string {
  try {
    return safeToken(userInfo().username, 32) || "unknown";
  } catch {
    return "unknown";
  }
}

/** The local hostname's first label ("Macs-MBP.local" → "Macs-MBP"). */
export function localHost(): string {
  const first = hostname().split(".")[0] ?? "";
  return safeToken(first, 32) || "unknown";
}

/**
 * The checked-out branch of the git repo containing `cwd`, or a short commit
 * id when detached, or null when `cwd` is not inside a git checkout. Pure
 * file reads — never spawns git — so it is cheap enough to run on every send:
 * walk up to the nearest `.git`, follow a worktree's `gitdir:` indirection
 * file, then parse `HEAD`.
 */
export function readGitBranch(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    const dotGit = path.join(dir, ".git");
    let gitDir: string | null = null;
    try {
      const content = readFileSync(dotGit, "utf8");
      // A worktree/submodule checkout: `.git` is a FILE containing
      // `gitdir: <path>` (absolute, or relative to the checkout).
      const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
      gitDir = m ? path.resolve(dir, m[1]!.trim()) : null;
    } catch (err: any) {
      if (err?.code === "EISDIR") gitDir = dotGit;
      // ENOENT/EACCES: no .git here — walk up.
    }
    if (gitDir) {
      try {
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return safeBranch(ref[1]!);
        if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 12); // detached
        return null; // unrecognized HEAD — don't guess
      } catch {
        return null; // .git exists but HEAD unreadable
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Branch names never contain `:`/space/`~`/`^` (git forbids them), but they
 * DO allow `/` and `#` — keep `/` (readable, unambiguous: parsing anchors on
 * `#<pid>` at the end) and clamp everything else defensively.
 * Exported only for the shared cross-runtime case table — see `safeToken`. */
export function safeBranch(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._/#-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64);
}

/** Abbreviate the home directory to `~`, mirroring how `ay ls` prints cwds.
 * `home` is a seam (mirrored by the Rust port's `tildify`) so the shared
 * cross-runtime case table can pin a home that is not the running machine's;
 * omit it in production. */
export function tildify(p: string, home: string = homedir()): string {
  return home !== "" && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface IdentityParts {
  user?: string;
  host?: string;
  cwd: string;
  /** Pass null to omit the branch segment; omit the key to auto-detect. */
  branch?: string | null;
  pid: number;
  /** Seam for `tildify` — see there. Omit in production. */
  home?: string;
}

/**
 * Render the standardized identity for an agent. `user`/`host` default to the
 * local machine (correct for the envelope: the sending wrapper runs on the
 * agent's own host), `branch` auto-detects from `cwd` unless given.
 */
export function formatIdentity(parts: IdentityParts): string {
  const user = parts.user ?? localUser();
  const host = parts.host ?? localHost();
  const branch = parts.branch === undefined ? readGitBranch(parts.cwd) : parts.branch;
  const where = tildify(parts.cwd, parts.home);
  return `${user}@${host}:${where}${branch ? `:${branch}` : ""}#${parts.pid}`;
}
