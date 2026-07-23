/**
 * `ay todo <verb>` — CLI surface for the lifecycle engine (`todoStore.ts`),
 * typed blocks (`todoBlock.ts`), and read-side views (`todoDigest.ts`).
 *
 * Registered from `ts/subcommands.ts` the same way larger subsystems like
 * `serve`/`schedule`/`expose` are: a lazy `case "todo":` import into
 * `runTodoSubcommand`, so this file (and everything it pulls in) is only
 * loaded when `ay todo ...` is actually invoked.
 *
 * Store location: `--root <dir>` (default: current working directory) is
 * where `.agent-yes/todos.jsonl` lives, mirroring `PidStore`'s own
 * `<workingDir>/.agent-yes/...` convention. This module has no notion of any
 * particular consuming project's directory-resolution rules (e.g. "find the
 * monorepo root") — a project wanting that behavior supplies it by always
 * invoking with an explicit `--root`, or by calling `openStore()` as a
 * library from its own code instead of through this CLI.
 *
 * Argument parsing: a real yargs COMMAND TREE — one `yargs(argv)` instance
 * with a `CommandModule` per verb registered via `.command()`, `--root`/
 * `--format` declared once as `global: true` options on that same instance —
 * matching the pattern `tools/symval-dev-cli`'s `sv` CLI already uses
 * (`todoCommand`/`lsCmd` etc. in that repo's `commands/todo.ts`), per taku's
 * explicit feedback that this gives better help behavior for free: a real
 * `.command()` tree yields an auto-generated `ay todo --help` listing every
 * verb with its description, and per-verb `--help`/usage, neither of which
 * a hand-rolled switch dispatch provides out of the box.
 *
 * An EARLIER version of this file used a hand-rolled switch with a separate
 * `yargs(args)` parse PER verb (declaring `--root`/`--format` on each one via
 * a shared `commonOptions()` helper) specifically to avoid an even earlier
 * bug where a single outer parse swallowed every verb's own flags. That
 * workaround is no longer needed: the swallowing bug was a property of an
 * outer parse with NO knowledge of subcommand-specific options, not of
 * single-parse command trees in general — a genuine yargs `.command()` tree
 * (this file, now) natively supports `global: true` options that behave
 * correctly regardless of position, which is exactly the position-
 * dependence class of bug the per-verb-parse workaround existed to avoid in
 * the first place.
 */

import yargs, { type Argv, type CommandModule } from "yargs";
import { openStore, CycleError, type TodoRecord } from "./todoStore.ts";
import { isKnownKind, LIFECYCLES, type LifecycleKind } from "./todoLifecycle.ts";
import { describeBlock, type TodoBlock } from "./todoBlock.ts";
import { renderDigest, renderTree, buildTreeJSON, unblockedTasks } from "./todoDigest.ts";
import { reconcileTodos, type LiveAgent } from "./todoAutomation.ts";
import { readGlobalPids } from "./globalPidIndex.ts";

function fail(message: string): never {
  throw new Error(message);
}

function parseKind(raw: string | undefined): LifecycleKind {
  if (!raw) fail(`--kind is required (one of: ${Object.keys(LIFECYCLES).join(", ")})`);
  if (!isKnownKind(raw))
    fail(`unknown kind "${raw}" (one of: ${Object.keys(LIFECYCLES).join(", ")})`);
  return raw;
}

function renderRecord(t: TodoRecord): string {
  const lines = [
    `${t._id} [${t.state}] ${t.summary}`,
    `kind:    ${t.kind}${t.targetTier ? `  tier:${t.targetTier}` : ""}`,
    ...(t.owner ? [`owner:   ${t.owner}`] : []),
    ...(t.block ? [`block:   ${describeBlock(t.block)}`] : []),
    ...(t.blockedBy.length ? [`blockedBy: ${t.blockedBy.join(", ")}`] : []),
    ...(t.tags.length ? [`tags:    ${t.tags.join(", ")}`] : []),
    ...(t.satisfiedGates.length ? [`satisfiedGates: ${t.satisfiedGates.join(", ")}`] : []),
    ...(t.verifyEvidence.length
      ? [
          `evidence: ${t.verifyEvidence.map((e) => `${e.gate} by ${e.validator}${e.link ? ` (${e.link})` : ""}`).join("; ")}`,
        ]
      : []),
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
  ];
  if (t.description) lines.push("", t.description);
  return lines.join("\n");
}

function renderList(tasks: TodoRecord[]): string {
  if (tasks.length === 0) return "(no tasks match)";
  const rows = tasks.map((t) => [t._id, t.state, t.kind, t.owner ?? "", t.summary]);
  const header = ["ID", "STATE", "KIND", "OWNER", "SUMMARY"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (xs: string[]) =>
    xs
      .map((x, i) => x.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

interface GlobalOpts {
  root: string;
  format: "table" | "json";
}

function emit(opts: GlobalOpts, obj: unknown, human: string): void {
  process.stdout.write((opts.format === "json" ? JSON.stringify(obj, null, 2) : human) + "\n");
}

const newCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & {
    summary: string[];
    kind: string | undefined;
    description: string | undefined;
    tier: string | undefined;
    owner: string | undefined;
    tag: string[] | undefined;
    dep: string[] | undefined;
  }
> = {
  command: "new <summary..>",
  describe: "create a new task",
  builder: (y) =>
    y
      .positional("summary", {
        type: "string",
        array: true,
        demandOption: true,
        describe:
          "task summary (unquoted words are joined — quote if it must contain a literal --flag)",
      })
      .option("kind", { type: "string", describe: `one of: ${Object.keys(LIFECYCLES).join(", ")}` })
      .option("description", { type: "string" })
      .option("tier", { type: "string", describe: "targetTier, e.g. canary-done / shipped-done" })
      .option("owner", { type: "string" })
      .option("tag", { type: "string", array: true })
      .option("dep", { type: "string", array: true, describe: "blocker task id(s)" }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    // Join ALL summary words: an unquoted summary like
    // `ay todo new write the spec --kind doc` arrives as multiple array
    // entries under yargs' `<summary..>` variadic positional — using only
    // the first would silently truncate it (codex-review Important, from
    // the previous hand-rolled-positional design; the variadic positional
    // here still needs the same join, it just collects the array for us).
    const summary = argv.summary.map(String).join(" ");
    if (!summary) {
      fail(
        "usage: ay todo new <summary> --kind <kind> [--description ...] [--tier ...] [--owner ...] [--tag t]... [--dep id]...",
      );
    }
    const rec = await store.create({
      summary,
      kind: parseKind(argv.kind),
      description: argv.description,
      targetTier: argv.tier,
      owner: argv.owner,
      tags: argv.tag ?? [],
      blockedBy: argv.dep ?? [],
    });
    emit(argv, rec, `created ${rec._id}\n${renderRecord(rec)}`);
  },
};

const lsCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & {
    kind: string | undefined;
    state: string | undefined;
    owner: string | undefined;
    tag: string | undefined;
    blocked: boolean;
  }
> = {
  command: "ls",
  describe: "list tasks (filter by --kind, --state, --owner, --tag, --blocked)",
  builder: (y) =>
    y
      .option("kind", { type: "string" })
      .option("state", { type: "string" })
      .option("owner", { type: "string" })
      .option("tag", { type: "string" })
      .option("blocked", { type: "boolean", default: false }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const tasks = store.list({
      kind: argv.kind ? parseKind(argv.kind) : undefined,
      state: argv.state,
      owner: argv.owner,
      tag: argv.tag,
      blocked: argv.blocked,
    });
    emit(argv, tasks, renderList(tasks));
  },
};

const getCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string }> = {
  command: "get <id>",
  describe: "show one task",
  builder: (y) => y.positional("id", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const rec = store.get(argv.id);
    if (!rec) fail(`no such task: ${argv.id}`);
    emit(argv, rec, renderRecord(rec));
  },
};

const transitionCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string; toState: string }> = {
  command: "transition <id> <toState>",
  describe: "move a task to a new state (fails naming the missing gate if one is required)",
  builder: (y) =>
    y
      .positional("id", { type: "string", demandOption: true })
      .positional("toState", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const rec = await store.transition(argv.id, argv.toState);
    emit(argv, rec, `transitioned ${rec._id} -> ${rec.state}\n${renderRecord(rec)}`);
  },
};

const approveCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & {
    id: string;
    gate: string;
    validatorIdentity: string;
    note: string | undefined;
    link: string | undefined;
  }
> = {
  command: "approve <id> <gate> <validatorIdentity>",
  describe: "manually satisfy a non-registered gate as a DIFFERENT identity from the task's owner",
  builder: (y) =>
    y
      .positional("id", { type: "string", demandOption: true })
      .positional("gate", { type: "string", demandOption: true })
      .positional("validatorIdentity", { type: "string", demandOption: true })
      .option("note", { type: "string" })
      .option("link", { type: "string" }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const rec = await store.approve(argv.id, argv.gate, argv.validatorIdentity, {
      note: argv.note,
      link: argv.link,
    });
    emit(
      argv,
      rec,
      `approved "${argv.gate}" on ${rec._id} (validator: ${argv.validatorIdentity})\n${renderRecord(rec)}`,
    );
  },
};

const verifyCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string; gate: string | undefined }> =
  {
    command: "verify <id> [gate]",
    describe: "re-run a registered gate for a task and apply its result",
    builder: (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .positional("gate", { type: "string" }),
    handler: async (argv) => {
      const store = await openStore(argv.root);
      const rec = await store.verify(argv.id, argv.gate || undefined);
      emit(argv, rec, `verified ${rec._id} -> ${rec.state}\n${renderRecord(rec)}`);
    },
  };

const BLOCK_TYPES = [
  "blocked-by-task",
  "blocked-by-human",
  "blocked-by-external",
  "waiting-on-agent",
] as const;

const blockCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & {
    id: string;
    type: (typeof BLOCK_TYPES)[number] | undefined;
    task: string | undefined;
    who: string | undefined;
    question: string | undefined;
    options: string[] | undefined;
    "action-link": string | undefined;
    signal: string | undefined;
    agent: string | undefined;
  }
> = {
  command: "block <id>",
  describe:
    "mark a task blocked (--type blocked-by-task|blocked-by-human|blocked-by-external|waiting-on-agent)",
  builder: (y) =>
    y
      .positional("id", { type: "string", demandOption: true })
      .option("type", { type: "string", choices: BLOCK_TYPES })
      .option("task", { type: "string", describe: "required for --type blocked-by-task" })
      .option("who", { type: "string", describe: "required for --type blocked-by-human" })
      .option("question", { type: "string" })
      .option("options", {
        type: "string",
        array: true,
        describe: "choice-shape ask (/ask renders buttons)",
      })
      .option("action-link", {
        type: "string",
        describe:
          "action-shape ask (/ask renders an 'open link, then confirm' button) — e.g. an OAuth/CAPTCHA URL",
      })
      .option("signal", { type: "string", describe: "required for --type blocked-by-external" })
      .option("agent", { type: "string", describe: "required for --type waiting-on-agent" }),
  handler: async (argv) => {
    if (!argv.type) {
      fail(
        "usage: ay todo block <id> --type <blocked-by-task|blocked-by-human|blocked-by-external|waiting-on-agent> ...",
      );
    }
    let block: TodoBlock;
    switch (argv.type) {
      case "blocked-by-task":
        if (!argv.task) fail("--task <id> is required for --type blocked-by-task");
        block = { type: "blocked-by-task", taskId: argv.task };
        break;
      case "blocked-by-human":
        if (!argv.who) fail("--who <name> is required for --type blocked-by-human");
        block = {
          type: "blocked-by-human",
          who: argv.who,
          question: argv.question,
          options: argv.options,
          actionLink: argv["action-link"],
        };
        break;
      case "blocked-by-external":
        if (!argv.signal) fail("--signal <name> is required for --type blocked-by-external");
        block = { type: "blocked-by-external", signal: argv.signal };
        break;
      case "waiting-on-agent":
        if (!argv.agent) fail("--agent <id> is required for --type waiting-on-agent");
        block = { type: "waiting-on-agent", agentId: argv.agent };
        break;
    }
    const store = await openStore(argv.root);
    const rec = await store.setBlock(argv.id, block);
    emit(argv, rec, `blocked ${rec._id}: ${describeBlock(block)}\n${renderRecord(rec)}`);
  },
};

const unblockCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string }> = {
  command: "unblock <id>",
  describe: "clear a task's block (does not touch blockedBy — see `dep`)",
  builder: (y) => y.positional("id", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const rec = await store.setBlock(argv.id, null);
    emit(argv, rec, `unblocked ${rec._id}\n${renderRecord(rec)}`);
  },
};

const depCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & { verb: "add" | "rm"; id: string; blockerId: string }
> = {
  command: "dep <verb> <id> <blockerId>",
  describe:
    "manage task dependencies: dep add T2 T1 (T2 waits for T1) / dep rm T2 T1. Cycles are rejected",
  builder: (y) =>
    y
      .positional("verb", { type: "string", choices: ["add", "rm"] as const, demandOption: true })
      .positional("id", {
        type: "string",
        demandOption: true,
        describe: "the task that is blocked",
      })
      .positional("blockerId", {
        type: "string",
        demandOption: true,
        describe: "task id it waits for",
      }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    try {
      const rec =
        argv.verb === "add"
          ? await store.addDep(argv.id, argv.blockerId)
          : await store.rmDep(argv.id, argv.blockerId);
      emit(
        argv,
        rec,
        `${argv.verb === "add" ? "added" : "removed"} dep ${argv.blockerId} on ${rec._id}\n${renderRecord(rec)}`,
      );
    } catch (err) {
      if (err instanceof CycleError) fail(err.message);
      throw err;
    }
  },
};

const treeCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string | undefined }> = {
  command: "tree [id]",
  describe: "dependency tree (children = what a task waits for). Default: all dependency roots",
  builder: (y) =>
    y.positional("id", { type: "string", describe: "root task id (default: all roots)" }),
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const tasks = store.all();
    if (argv.format === "json") {
      emit(argv, buildTreeJSON(tasks, argv.id), "");
    } else {
      process.stdout.write(renderTree(tasks, argv.id) + "\n");
    }
  },
};

const digestCmd: CommandModule<GlobalOpts, GlobalOpts> = {
  command: "digest",
  describe: "per-tag board: state counts, blockers, unblocked tasks",
  handler: async (argv) => {
    const store = await openStore(argv.root);
    const tasks = store.all();
    if (argv.format === "json") {
      emit(argv, { tasks, unblocked: unblockedTasks(tasks).map((t) => t._id) }, "");
    } else {
      process.stdout.write(renderDigest(tasks) + "\n");
    }
  },
};

const reconcileCmd: CommandModule<GlobalOpts, GlobalOpts> = {
  command: "reconcile",
  describe:
    "apply automation: orphan dead-owned tasks, clear stale waiting-on-agent blocks, auto-verify, report unblocked tasks",
  handler: async (argv) => {
    const store = await openStore(argv.root);
    // `liveOnly: false`: a task's owner needs to be checked against a KNOWN
    // agent whose latest record says `exited`, not just the currently-live
    // set — an exited-but-recorded agent is exactly the orphan signal (see
    // todoAutomation.ts's `deadOwnerAgent`).
    const agents: LiveAgent[] = await readGlobalPids({ liveOnly: false });
    const registeredGates = new Set(store.registeredGateNames());
    const actions = reconcileTodos(store.all(), agents, registeredGates);

    // Every action is applied against a FRESH record inside the store (see
    // `markOrphaned`/`clearWaitingOnAgentBlock`), since the snapshot
    // `reconcileTodos` decided from can be stale by the time we get here
    // (another process may have reassigned the task, changed its block,
    // etc. — codex-review Important). A per-action failure is reported as a
    // skip, not an aborted reconcile: the remaining actions still apply.
    const applied: string[] = [];
    for (const action of actions) {
      try {
        switch (action.type) {
          case "orphan": {
            await store.markOrphaned(action.taskId, action.expectedOwner, action.candidates);
            applied.push(
              `orphaned ${action.taskId} (was ${action.from}) — reassign candidates: ${action.candidates.join(", ") || "(none idle)"}`,
            );
            break;
          }
          case "clear-waiting-on-agent": {
            await store.clearWaitingOnAgentBlock(action.taskId, action.expectedAgentId);
            applied.push(
              `cleared waiting-on-agent block on ${action.taskId} (agent ${action.expectedAgentId})`,
            );
            break;
          }
          case "auto-verify": {
            // A registered gate reporting not-passed (or throwing for any
            // other reason, e.g. a concurrent state change) is a real "not
            // verified yet" outcome, reported as such rather than silently
            // claimed as success — reconcile just tries again next call
            // (codex-review Important: an earlier version swallowed every
            // failure and still reported "auto-verified").
            const result = await store.verify(action.taskId);
            applied.push(`auto-verified ${action.taskId} -> ${result.state}`);
            break;
          }
          case "notify-unblocked": {
            // Delivery to the owning agent's own inbox is not wired yet (the
            // notify system addresses parent<->child pid trees, a different
            // relationship than an arbitrary task owner) — surfaced here, on
            // every call (see todoAutomation.ts), so it is visible rather
            // than silently dropped or falsely retired.
            applied.push(`${action.taskId} is now unblocked (owner: ${action.owner})`);
            break;
          }
        }
      } catch (err) {
        applied.push(
          `skipped ${action.type} on ${action.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    emit(
      argv,
      { actions, applied },
      applied.length ? applied.join("\n") : "(nothing to reconcile)",
    );
  },
};

export async function runTodoSubcommand(rest0: string[]): Promise<number> {
  await yargs(rest0)
    .scriptName("ay todo")
    .option("root", {
      type: "string",
      default: process.cwd(),
      describe: "project root holding .agent-yes/todos.jsonl",
      global: true,
    })
    .option("format", {
      choices: ["table", "json"] as const,
      default: "table" as const,
      describe: "output format",
      global: true,
    })
    .check((argv) => {
      if ((argv.root as string) === "") fail("--root must not be empty");
      return true;
    })
    .command(newCmd)
    .command(lsCmd)
    .command(getCmd)
    .command(transitionCmd)
    .command(approveCmd)
    .command(verifyCmd)
    .command(blockCmd)
    .command(unblockCmd)
    .command(depCmd)
    .command(treeCmd)
    .command(digestCmd)
    .command(reconcileCmd)
    .demandCommand(
      1,
      'unknown "ay todo" verb (expected: new/ls/get/transition/approve/verify/block/unblock/dep/tree/digest/reconcile)',
    )
    .strict()
    .help()
    .version(false)
    .exitProcess(false)
    .fail((msg, err) => {
      // Default yargs behavior on a validation failure (unknown/missing
      // command, failed .check()) is to print usage and, with
      // exitProcess(false), silently resolve rather than reject — the exact
      // opposite of every existing caller's expectation (they `await` this
      // function and `.rejects.toThrow(...)` in tests, matching the rest of
      // this codebase's convention of surfacing errors as thrown Errors, not
      // silent exit codes). Re-throwing here is what makes that true for
      // yargs' own validation errors, not just for `fail()` calls inside a
      // handler body.
      throw err ?? new Error(msg);
    })
    .parseAsync();
  return 0;
}
