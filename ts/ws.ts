/**
 * `ay ws` — workspace management over the codehost/provision standard layout
 * (`<wsRoot>/<owner>/<repo>/tree/<branch>`, independent clones except forked
 * linked worktrees).
 *
 * v1 surface (read/list/new/fork only — deletion/gc/doctor are deliberately
 * deferred until workspace lifecycle data exists to design them around):
 *
 *   ay ws ls [--status] [--json]
 *   ay ws status [<spec-or-path>] [--path|--spec] [--json]
 *   ay ws new <source> [--create]
 *   ay ws fork <branch> [--from <path>] [--wip]
 *
 * `--json` schema (stable, versioned via `schema`):
 *   ls:     { schema:"ay-ws/v1", wsRoot, workspaces: WsEntry[] }
 *   status: { schema:"ay-ws/v1", workspace: WsEntry }
 *   WsEntry = { owner, repo, branch, path, agents: { live: number },
 *               git?: GitStatus | null, gitError?: string }
 *
 * codehost/provision is a peer package (bun-linked in dev). Like serve.ts's
 * fork path, it is imported lazily so `ay ls` etc. never pay for it and a
 * missing install produces a clear actionable error instead of a module crash.
 */

import path from "path";
import { opendir, lstat } from "fs/promises";
import { existsSync } from "fs";
import { getProvisionRoot } from "./workspaceConfig.ts";
import { listRecords } from "./subcommands.ts";
import type { GlobalPidRecord } from "./globalPidIndex.ts";

// Everything we consume from codehost/provision, typed locally so this module
// compiles without the package present (it is resolved at runtime).
interface RepoSpec {
  owner: string;
  repo: string;
  branch: string;
}
interface GitStatus {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
}
interface ProvisionResult {
  ok: boolean;
  spec: RepoSpec;
  folder: string;
  existed: boolean;
  action: string;
  git?: GitStatus;
  error?: string;
  reason?: "branch-not-found" | "repo-not-found" | "other";
}
interface Provision {
  resolveWsRoot(wsRoot?: string): string;
  parseSource(input: string): RepoSpec | null;
  folderFor(spec: RepoSpec, wsRoot?: string): string;
  readStatus(dir: string): Promise<GitStatus>;
  provision(spec: RepoSpec, opts?: { wsRoot?: string }): Promise<ProvisionResult>;
  createBranch(spec: RepoSpec, opts?: { wsRoot?: string }): Promise<ProvisionResult>;
  forkWorktree(opts: {
    fromCwd: string;
    branch: string;
    wsRoot?: string;
    wip?: boolean;
  }): Promise<ProvisionResult>;
}

async function loadProvision(): Promise<Provision> {
  try {
    return (await import("codehost/provision")) as unknown as Provision;
  } catch (e) {
    throw new Error(
      `'ay ws' needs the 'codehost' package (codehost/provision) — install it ` +
        `(npm i -g codehost) or 'bun link' it for local dev: ${(e as Error).message}`,
    );
  }
}

export const WS_JSON_SCHEMA = "ay-ws/v1";

// A workspace found under the standard layout.
export interface WsEntry {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  agents: { live: number };
  git?: GitStatus | null;
  gitError?: string;
}

// readStatus can block up to git's 120s timeout per workspace, so status joins
// run through a small worker pool instead of one unbounded Promise.all.
const STATUS_CONCURRENCY = 8;
// Branch names may contain `/`, so the walk below `tree/` is recursive; this
// bounds a pathological/looping layout, not a legitimate branch depth.
const MAX_BRANCH_DEPTH = 8;

/**
 * Path containment that matches how the OS actually compares paths: segment
 * boundaries via path.relative (never a raw startsWith), case-insensitive on
 * Windows (and macOS's default case-insensitive FS is fine with this too —
 * false positives there require two dirs differing only by case).
 */
export function isPathInside(parent: string, child: string): boolean {
  let p = path.resolve(parent);
  let c = path.resolve(child);
  if (process.platform === "win32") {
    p = p.toLowerCase();
    c = c.toLowerCase();
  }
  const rel = path.relative(p, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when `dir` is a git checkout root (`.git` file = linked worktree, dir = clone). */
function isCheckoutRoot(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

// List real subdirectories (no symlinks, no dotdirs), tolerating vanished dirs.
async function subdirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  let d: Awaited<ReturnType<typeof opendir>>;
  try {
    d = await opendir(dir);
  } catch {
    return out;
  }
  for await (const ent of d) {
    if (ent.name.startsWith(".")) continue;
    if (ent.isDirectory()) {
      out.push(ent.name);
    } else if (ent.isSymbolicLink()) {
      // never follow symlinks — a link cycle under tree/ must not loop the walk
      continue;
    }
  }
  return out.sort();
}

/**
 * Walk `<wsRoot>/<owner>/<repo>/tree/**` collecting checkout roots. The branch
 * may contain `/`, so below `tree/` we descend until a `.git` marker is found
 * (a checkout root is never nested inside another checkout in this layout),
 * bounded by MAX_BRANCH_DEPTH.
 */
export async function walkWorkspaces(wsRoot: string): Promise<Omit<WsEntry, "agents">[]> {
  const found: Omit<WsEntry, "agents">[] = [];

  async function walkBranches(dir: string, owner: string, repo: string, segs: string[]) {
    if (segs.length > MAX_BRANCH_DEPTH) return;
    for (const name of await subdirs(dir)) {
      const p = path.join(dir, name);
      const branchSegs = [...segs, name];
      if (isCheckoutRoot(p)) {
        found.push({ owner, repo, branch: branchSegs.join("/"), path: p });
      } else {
        await walkBranches(p, owner, repo, branchSegs);
      }
    }
  }

  for (const owner of await subdirs(wsRoot)) {
    for (const repo of await subdirs(path.join(wsRoot, owner))) {
      const tree = path.join(wsRoot, owner, repo, "tree");
      try {
        if (!(await lstat(tree)).isDirectory()) continue;
      } catch {
        continue;
      }
      await walkBranches(tree, owner, repo, []);
    }
  }
  return found;
}

/** Live (non-exited) agents whose cwd sits inside `wsPath`. */
function liveAgentsIn(records: GlobalPidRecord[], wsPath: string): GlobalPidRecord[] {
  return records.filter((r) => r.cwd && isPathInside(wsPath, r.cwd));
}

// Run `fn` over items with at most `limit` in flight (order preserved).
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Resolve a status/inspect operand deterministically:
 *   1. `--path` forces path, `--spec` forces source-spec parsing
 *   2. an operand that exists on disk is a path
 *   3. otherwise it must parse as a source (owner/repo[@branch|/tree/branch] or URL)
 * Prints the normalized resolution so the user always sees what was addressed.
 */
export async function resolveOperand(
  prov: Provision,
  operand: string,
  mode: "auto" | "path" | "spec",
  wsRoot: string | undefined,
): Promise<{ dir: string; spec: RepoSpec | null }> {
  const asPath = () => {
    const dir = path.resolve(operand);
    if (!existsSync(dir)) throw new Error(`path does not exist: ${dir}`);
    if (!isCheckoutRoot(dir)) throw new Error(`not a git checkout root (no .git): ${dir}`);
    return { dir, spec: null };
  };
  const asSpec = () => {
    const spec = prov.parseSource(operand);
    if (!spec) {
      throw new Error(
        `cannot parse "${operand}" as a source — expected <owner>/<repo>, ` +
          `<owner>/<repo>@<branch>, <owner>/<repo>/tree/<branch>, or a github URL` +
          (existsSync(operand) ? "" : " (and it is not an existing path)"),
      );
    }
    const dir = prov.folderFor(spec, wsRoot);
    if (!existsSync(dir)) throw new Error(`workspace not provisioned: ${dir}  (ay ws new ${operand})`);
    return { dir, spec };
  };
  if (mode === "path") return asPath();
  if (mode === "spec") return asSpec();
  // auto: an existing local path wins; only then try the spec grammar.
  if (existsSync(path.resolve(operand))) return asPath();
  return asSpec();
}

/**
 * Default source for `ws fork`: the calling agent's registered cwd when run
 * inside an agent (AGENT_YES_PID is the wrapper pid of the enclosing agent),
 * else the current directory.
 */
async function defaultForkFrom(): Promise<string> {
  const envPid = Number(process.env.AGENT_YES_PID);
  if (envPid > 0) {
    const recs = await listRecords(undefined, {
      all: true,
      active: false,
      json: false,
      latest: false,
      cwdScope: null,
    });
    const self = recs.find((r) => r.wrapper_pid === envPid) ?? recs.find((r) => r.pid === envPid);
    if (self?.cwd) return self.cwd;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// arg parsing (tiny, flag-only — no positional grammar beyond one operand)
// ---------------------------------------------------------------------------

function parseFlags(
  args: string[],
  known: Record<string, "bool" | "value">,
): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = known[name];
    if (!kind) throw new Error(`unknown flag --${name}`);
    if (kind === "bool") {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      flags[name] = true;
    } else {
      const v = eq !== -1 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) throw new Error(`--${name} requires a value`);
      flags[name] = v;
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdWsLs(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { status: "bool", json: "bool" });
  if (positional.length > 0) throw new Error(`ws ls takes no positional args`);
  const prov = await loadProvision();
  const wsRoot = prov.resolveWsRoot(getProvisionRoot());

  const [bare, records] = await Promise.all([
    walkWorkspaces(wsRoot),
    listRecords(undefined, { all: false, active: false, json: false, latest: false, cwdScope: null }),
  ]);

  let entries: WsEntry[] = bare.map((w) => ({
    ...w,
    agents: { live: liveAgentsIn(records, w.path).length },
  }));

  if (flags.status) {
    entries = await mapBounded(entries, STATUS_CONCURRENCY, async (e) => {
      try {
        return { ...e, git: await prov.readStatus(e.path) };
      } catch (err) {
        return { ...e, git: null, gitError: (err as Error).message.slice(0, 200) };
      }
    });
  }

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ schema: WS_JSON_SCHEMA, wsRoot, workspaces: entries }, null, 2) + "\n",
    );
    return 0;
  }

  if (entries.length === 0) {
    process.stderr.write(`no workspaces under ${wsRoot} (layout <owner>/<repo>/tree/<branch>)\n`);
    return 0;
  }

  const specOf = (e: WsEntry) => `${e.owner}/${e.repo}@${e.branch}`;
  const specW = Math.max(9, ...entries.map((e) => specOf(e).length));
  const agentsW = 6;
  const header = flags.status
    ? `${"WORKSPACE".padEnd(specW)}  ${"AGENTS".padEnd(agentsW)}  GIT\n`
    : `${"WORKSPACE".padEnd(specW)}  ${"AGENTS".padEnd(agentsW)}  PATH\n`;
  process.stdout.write(header);
  for (const e of entries) {
    const agents = e.agents.live > 0 ? String(e.agents.live) : "-";
    const tail = flags.status ? gitSummary(e) : e.path;
    process.stdout.write(`${specOf(e).padEnd(specW)}  ${agents.padEnd(agentsW)}  ${tail}\n`);
  }
  if (entries.some((e) => e.agents.live > 0)) {
    process.stderr.write(`\n  ay ls --cwd <path>    # the agents inside a workspace\n`);
  }
  return 0;
}

function gitSummary(e: WsEntry): string {
  if (e.gitError) return `error: ${e.gitError}`;
  const g = e.git;
  if (!g) return "?";
  const parts: string[] = [];
  if (g.dirty) parts.push("dirty");
  if (g.ahead > 0) parts.push(`ahead ${g.ahead}`);
  if (g.behind > 0) parts.push(`behind ${g.behind}`);
  if (!g.hasUpstream) parts.push("no-upstream");
  return parts.length ? parts.join(", ") : "clean";
}

async function cmdWsStatus(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { json: "bool", path: "bool", spec: "bool" });
  if (flags.path && flags.spec) throw new Error("--path and --spec are mutually exclusive");
  if (positional.length > 1) throw new Error("ws status takes at most one target");
  const prov = await loadProvision();
  const wsRoot = getProvisionRoot();
  const operand = positional[0] ?? ".";
  const mode = flags.path ? "path" : flags.spec ? "spec" : "auto";
  const { dir, spec } = await resolveOperand(prov, operand, mode, wsRoot);
  const git = await prov.readStatus(dir);

  // Fill owner/repo/branch from the layout when addressed by path, best-effort.
  const layoutSpec =
    spec ??
    (() => {
      const root = prov.resolveWsRoot(wsRoot);
      if (!isPathInside(root, dir)) return null;
      const segs = path.relative(root, dir).split(path.sep);
      return segs.length >= 4 && segs[2] === "tree"
        ? { owner: segs[0]!, repo: segs[1]!, branch: segs.slice(3).join("/") }
        : null;
    })();

  const entry: WsEntry = {
    owner: layoutSpec?.owner ?? "",
    repo: layoutSpec?.repo ?? "",
    branch: layoutSpec?.branch ?? git.branch,
    path: dir,
    agents: {
      live: liveAgentsIn(
        await listRecords(undefined, {
          all: false,
          active: false,
          json: false,
          latest: false,
          cwdScope: null,
        }),
        dir,
      ).length,
    },
    git,
  };

  if (flags.json) {
    process.stdout.write(JSON.stringify({ schema: WS_JSON_SCHEMA, workspace: entry }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    `${dir}\n` +
      (layoutSpec ? `  spec:     ${layoutSpec.owner}/${layoutSpec.repo}@${layoutSpec.branch}\n` : "") +
      `  branch:   ${git.branch} @ ${git.head}\n` +
      `  state:    ${gitSummary(entry)}\n` +
      `  agents:   ${entry.agents.live} live\n`,
  );
  if (entry.agents.live > 0) process.stderr.write(`\n  ay ls --cwd ${dir}\n`);
  return 0;
}

async function cmdWsNew(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { create: "bool" });
  const source = positional[0];
  if (!source || positional.length > 1)
    throw new Error("usage: ay ws new <owner>/<repo>[@branch] [--create]");
  const prov = await loadProvision();
  const wsRoot = getProvisionRoot();
  const spec = prov.parseSource(source);
  if (!spec) throw new Error(`cannot parse "${source}" as a source (owner/repo[@branch] or URL)`);

  // Echo the normalized target before mutating anything.
  process.stderr.write(`provisioning ${spec.owner}/${spec.repo}@${spec.branch} …\n`);
  let res = await prov.provision(spec, { wsRoot });
  if (!res.ok && res.reason === "branch-not-found" && flags.create) {
    process.stderr.write(`branch not found on remote — creating it locally (--create)\n`);
    res = await prov.createBranch(spec, { wsRoot });
  }
  if (!res.ok) {
    process.stderr.write(
      `provision failed (${res.reason ?? "error"}): ${res.error ?? "unknown"}\n` +
        (res.reason === "branch-not-found" && !flags.create
          ? `  (branch missing on the remote — re-run with --create to branch off the default)\n`
          : ""),
    );
    return 1;
  }
  process.stdout.write(`${res.action}  ${res.folder}\n`);
  return 0;
}

async function cmdWsFork(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { from: "value", wip: "bool" });
  const branch = positional[0];
  if (!branch || positional.length > 1)
    throw new Error("usage: ay ws fork <new-branch> [--from <path>] [--wip]");
  const prov = await loadProvision();
  const fromCwd = path.resolve(
    typeof flags.from === "string" ? flags.from : await defaultForkFrom(),
  );

  process.stderr.write(`forking ${fromCwd} → branch ${branch}${flags.wip ? " (with WIP)" : ""} …\n`);
  const res = await prov.forkWorktree({
    fromCwd,
    branch,
    wsRoot: getProvisionRoot(),
    wip: !!flags.wip,
  });
  if (!res.ok) {
    process.stderr.write(`fork failed: ${res.error ?? "unknown"}\n`);
    return 1;
  }
  process.stdout.write(`${res.action}  ${res.folder}\n`);
  process.stderr.write(`\n  ay claude --cwd ${res.folder} -- "<prompt>"   # work there\n`);
  return 0;
}

function wsHelp(): number {
  process.stdout.write(
    `ay ws - workspaces under <wsRoot>/<owner>/<repo>/tree/<branch>\n` +
      `\n` +
      `  ay ws ls [--status] [--json]           list workspaces (+git state, +live agent count)\n` +
      `  ay ws status [<spec|path>] [--json]    one workspace's git state (default: cwd)\n` +
      `  ay ws new <owner>/<repo>[@branch]      clone/refresh a workspace  (--create: new branch)\n` +
      `  ay ws fork <branch> [--from <path>]    sibling worktree off HEAD  (--wip: carry changes)\n` +
      `\n` +
      `  targets: owner/repo, owner/repo@branch, owner/repo/tree/branch, github URL, or a path\n` +
      `  wsRoot:  CODEHOST_WS_ROOT > config provisionRoot > ~/ws\n`,
  );
  return 0;
}

/** `ay ws <sub> …` dispatcher (called from runSubcommand). */
export async function cmdWs(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "ls":
    case "list":
      return cmdWsLs(rest);
    case "status":
      return cmdWsStatus(rest);
    case "new":
      return cmdWsNew(rest);
    case "fork":
      return cmdWsFork(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return wsHelp();
    default:
      process.stderr.write(`ay ws: unknown subcommand "${sub}"\n\n`);
      wsHelp();
      return 1;
  }
}
