// `ay trust [dir]` — pre-accept Claude Code's folder-trust dialog for one dir.
//
// A fresh, untrusted cwd makes claude open its "Do you trust the files in this
// folder?" dialog before anything else. agent-yes answers it automatically, but
// that answer races the dialog's own re-render; marking the folder trusted up
// front removes the dialog entirely. It is the same flag claude itself writes
// when you pick "Yes": `projects[<dir>].hasTrustDialogAccepted = true` in
// ~/.claude.json.
//
// ~/.claude.json is shared, live state that running claude sessions rewrite, so
// the write is careful: exactly one path is touched, a backup is kept, the new
// file is written next to the real one and renamed over it only if the original
// did not change meanwhile (else retried), and the result is re-read to prove
// the flag landed.

import { copyFile, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

/** ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when that is set. */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(dir || homedir(), ".claude.json");
}

/** The key claude uses for a folder: its real (symlink-free) absolute path. */
export async function trustKey(dir: string): Promise<string> {
  const abs = await realpath(path.resolve(dir));
  if (!(await stat(abs)).isDirectory()) throw new Error(`not a directory: ${abs}`);
  return abs;
}

type ClaudeConfig = { projects?: Record<string, Record<string, unknown>> };

function parseConfig(raw: string, file: string): ClaudeConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}) — not touching it`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${file} is not a JSON object — not touching it`);
  }
  return doc as ClaudeConfig;
}

/** Is exactly `key` marked trusted? (Claude may also honour a parent; not checked.) */
export function isTrusted(doc: ClaudeConfig, key: string): boolean {
  return doc.projects?.[key]?.hasTrustDialogAccepted === true;
}

export type TrustResult = "already-trusted" | "trusted";

/**
 * Mark `key` trusted in `file`. Throws (leaving `file` as it was) when the file
 * is missing or not a JSON object, when it keeps changing under us, or when the
 * re-read does not show the flag.
 */
export async function markTrusted(
  key: string,
  file: string,
  opts: { attempts?: number; beforeRename?: () => Promise<void> } = {},
): Promise<TrustResult> {
  const real = await realpath(file).catch(() => {
    throw new Error(`${file} not found — run claude once first, or pass --config <file>`);
  });
  for (let attempt = 0; attempt < (opts.attempts ?? 3); attempt++) {
    const before = await stat(real);
    const raw = await readFile(real, "utf8");
    const doc = parseConfig(raw, real);
    if (isTrusted(doc, key)) return "already-trusted";

    const projects = (doc.projects ??= {});
    projects[key] = { ...projects[key], hasTrustDialogAccepted: true };
    const tmp = `${real}.ay-trust-${process.pid}.tmp`;
    // claude writes this file as 2-space JSON; keep that so diffs stay readable.
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: before.mode & 0o777 });
    try {
      await opts.beforeRename?.(); // test hook: simulate a concurrent writer
      const now = await stat(real);
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue; // changed: retry
      await copyFile(real, `${real}.ay-trust.bak`);
      await rename(tmp, real);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    if (!isTrusted(parseConfig(await readFile(real, "utf8"), real), key)) {
      throw new Error(
        `wrote ${real}, but a concurrent writer replaced it before the flag could be read back ` +
          `— re-run ay trust`,
      );
    }
    return "trusted";
  }
  throw new Error(`${real} kept changing while being updated — re-run ay trust`);
}

export async function cmdTrust(rest: string[]): Promise<number> {
  const usage =
    "usage: ay trust [dir] [--check] [--config <file>]\n" +
    "  Mark <dir> (default: .) as trusted for Claude Code, so it starts without the\n" +
    "  folder-trust dialog. --check only reports. --config defaults to ~/.claude.json\n" +
    "  ($CLAUDE_CONFIG_DIR/.claude.json when set).\n";
  let check = false;
  let file: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(usage);
      return 0;
    } else if (a === "--check") check = true;
    else if (a === "--config") file = rest[++i];
    else if (a.startsWith("--config=")) file = a.slice("--config=".length);
    else if (a.startsWith("-")) {
      process.stderr.write(`ay trust: unknown option '${a}'\n${usage}`);
      return 1;
    } else positional.push(a);
  }
  if (positional.length > 1 || file === "") {
    process.stderr.write(usage);
    return 1;
  }
  try {
    const key = await trustKey(positional[0] ?? ".");
    const target = file ?? claudeConfigPath();
    if (check) {
      const doc = parseConfig(await readFile(target, "utf8"), target);
      const ok = isTrusted(doc, key);
      process.stdout.write(`${key}: ${ok ? "trusted" : "not marked trusted"} (${target})\n`);
      return ok ? 0 : 1;
    }
    const result = await markTrusted(key, target);
    const real = await realpath(target);
    process.stdout.write(
      result === "trusted"
        ? `trusted ${key} (${real}; previous version saved as ${real}.ay-trust.bak)\n`
        : `${key} is already trusted (${target})\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`ay trust: ${(e as Error).message}\n`);
    return 1;
  }
}
