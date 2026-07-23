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
 */

import yargs from "yargs";
import { openStore, CycleError, type TodoRecord } from "./todoStore.ts";
import { isKnownKind, LIFECYCLES, type LifecycleKind } from "./todoLifecycle.ts";
import { describeBlock, type TodoBlock } from "./todoBlock.ts";
import { renderDigest, renderTree } from "./todoDigest.ts";

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

interface CommonOpts {
  root: string;
  format: "table" | "json";
}

function emit(opts: CommonOpts, obj: unknown, human: string): void {
  process.stdout.write((opts.format === "json" ? JSON.stringify(obj, null, 2) : human) + "\n");
}

/**
 * Pull `--root <dir>` and `--format <table|json>` out of `argv` WITHOUT a
 * full yargs pass — a single yargs parser here would swallow every verb's
 * own flags too (e.g. `--kind`) into the outer parse result, leaving the
 * per-verb sub-parsers below nothing to see in their `args`. Only these two
 * global, cross-verb options are special-cased this way; everything else is
 * declared by each verb's own `yargs(args)` call further down.
 */
function extractCommonOpts(argv: string[]): { opts: CommonOpts; rest: string[] } {
  const rest: string[] = [];
  let root = process.cwd();
  let format: CommonOpts["format"] = "table";
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--root") {
      root = argv[++i] ?? root;
    } else if (tok === "--format") {
      const v = argv[++i];
      if (v === "table" || v === "json") format = v;
    } else {
      rest.push(tok);
    }
  }
  return { opts: { root, format }, rest };
}

export async function runTodoSubcommand(rest0: string[]): Promise<number> {
  const { opts, rest } = extractCommonOpts(rest0);
  const [verb, ...args] = rest;
  const store = await openStore(opts.root);

  switch (verb) {
    case "new": {
      const sub = yargs(args)
        .option("kind", { type: "string" })
        .option("description", { type: "string" })
        .option("tier", { type: "string" })
        .option("owner", { type: "string" })
        .option("tag", { type: "string", array: true })
        .option("dep", { type: "string", array: true })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const summary = String(a._[0] ?? "");
      if (!summary)
        fail(
          "usage: ay todo new <summary> --kind <kind> [--description ...] [--tier ...] [--owner ...] [--tag t]... [--dep id]...",
        );
      const rec = await store.create({
        summary,
        kind: parseKind(a.kind as string | undefined),
        description: a.description as string | undefined,
        targetTier: a.tier as string | undefined,
        owner: a.owner as string | undefined,
        tags: (a.tag as string[] | undefined) ?? [],
        blockedBy: (a.dep as string[] | undefined) ?? [],
      });
      emit(opts, rec, `created ${rec._id}\n${renderRecord(rec)}`);
      return 0;
    }
    case "ls": {
      const sub = yargs(args)
        .option("kind", { type: "string" })
        .option("state", { type: "string" })
        .option("owner", { type: "string" })
        .option("tag", { type: "string" })
        .option("blocked", { type: "boolean", default: false })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const tasks = store.list({
        kind: a.kind ? parseKind(a.kind as string) : undefined,
        state: a.state as string | undefined,
        owner: a.owner as string | undefined,
        tag: a.tag as string | undefined,
        blocked: a.blocked as boolean,
      });
      emit(opts, tasks, renderList(tasks));
      return 0;
    }
    case "get": {
      const id = args[0];
      if (!id) fail("usage: ay todo get <id>");
      const rec = store.get(id);
      if (!rec) fail(`no such task: ${id}`);
      emit(opts, rec, renderRecord(rec));
      return 0;
    }
    case "transition": {
      const [id, toState] = args;
      if (!id || !toState) fail("usage: ay todo transition <id> <toState>");
      const rec = await store.transition(id, toState);
      emit(opts, rec, `transitioned ${rec._id} -> ${rec.state}\n${renderRecord(rec)}`);
      return 0;
    }
    case "approve": {
      const sub = yargs(args)
        .option("note", { type: "string" })
        .option("link", { type: "string" })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const [id, gate, validator] = (a._ as (string | number)[]).map(String);
      if (!id || !gate || !validator)
        fail("usage: ay todo approve <id> <gate> <validatorIdentity> [--note ...] [--link ...]");
      const rec = await store.approve(id, gate, validator, {
        note: a.note as string | undefined,
        link: a.link as string | undefined,
      });
      emit(
        opts,
        rec,
        `approved "${gate}" on ${rec._id} (validator: ${validator})\n${renderRecord(rec)}`,
      );
      return 0;
    }
    case "verify": {
      const [id, gate] = args;
      if (!id) fail("usage: ay todo verify <id> [gateName]");
      const rec = await store.verify(id, gate);
      emit(opts, rec, `verified ${rec._id} -> ${rec.state}\n${renderRecord(rec)}`);
      return 0;
    }
    case "block": {
      const sub = yargs(args)
        .option("type", {
          type: "string",
          choices: [
            "blocked-by-task",
            "blocked-by-human",
            "blocked-by-external",
            "waiting-on-agent",
          ] as const,
        })
        .option("task", { type: "string" })
        .option("who", { type: "string" })
        .option("question", { type: "string" })
        .option("options", { type: "string", array: true })
        .option("signal", { type: "string" })
        .option("agent", { type: "string" })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const id = String(a._[0] ?? "");
      if (!id || !a.type)
        fail(
          "usage: ay todo block <id> --type <blocked-by-task|blocked-by-human|blocked-by-external|waiting-on-agent> ...",
        );
      let block: TodoBlock;
      switch (a.type) {
        case "blocked-by-task":
          if (!a.task) fail("--task <id> is required for --type blocked-by-task");
          block = { type: "blocked-by-task", taskId: a.task as string };
          break;
        case "blocked-by-human":
          if (!a.who) fail("--who <name> is required for --type blocked-by-human");
          block = {
            type: "blocked-by-human",
            who: a.who as string,
            question: a.question as string | undefined,
            options: a.options as string[] | undefined,
          };
          break;
        case "blocked-by-external":
          if (!a.signal) fail("--signal <name> is required for --type blocked-by-external");
          block = { type: "blocked-by-external", signal: a.signal as string };
          break;
        case "waiting-on-agent":
          if (!a.agent) fail("--agent <id> is required for --type waiting-on-agent");
          block = { type: "waiting-on-agent", agentId: a.agent as string };
          break;
        default:
          fail(`unknown block type: ${a.type}`);
      }
      const rec = await store.setBlock(id, block);
      emit(opts, rec, `blocked ${rec._id}: ${describeBlock(block)}\n${renderRecord(rec)}`);
      return 0;
    }
    case "unblock": {
      const id = args[0];
      if (!id) fail("usage: ay todo unblock <id>");
      const rec = await store.setBlock(id, null);
      emit(opts, rec, `unblocked ${rec._id}\n${renderRecord(rec)}`);
      return 0;
    }
    case "dep": {
      const [verb2, id, blockerId] = args;
      if (!verb2 || !id || !blockerId || (verb2 !== "add" && verb2 !== "rm")) {
        fail("usage: ay todo dep add|rm <id> <blockerId>");
      }
      try {
        const rec =
          verb2 === "add" ? await store.addDep(id, blockerId) : await store.rmDep(id, blockerId);
        emit(
          opts,
          rec,
          `${verb2 === "add" ? "added" : "removed"} dep ${blockerId} on ${rec._id}\n${renderRecord(rec)}`,
        );
        return 0;
      } catch (err) {
        if (err instanceof CycleError) fail(err.message);
        throw err;
      }
    }
    case "tree": {
      const rootId = args[0];
      process.stdout.write(renderTree(store.all(), rootId) + "\n");
      return 0;
    }
    case "digest": {
      const tasks = store.all();
      if (opts.format === "json") {
        const { unblockedTasks } = await import("./todoDigest.ts");
        emit(opts, { tasks, unblocked: unblockedTasks(tasks).map((t) => t._id) }, "");
      } else {
        process.stdout.write(renderDigest(tasks) + "\n");
      }
      return 0;
    }
    default:
      fail(
        `unknown "ay todo" verb: "${verb ?? ""}" (expected: new/ls/get/transition/approve/verify/block/unblock/dep/tree/digest)`,
      );
  }
}
