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
 * Argument parsing: exactly ONE yargs pass per invocation, at the verb
 * level. `--root`/`--format` are declared as options on EVERY verb's own
 * `yargs(args)` call (via `commonOptions()` below) alongside that verb's own
 * options, rather than pre-scanned out of argv by a separate pass. An
 * earlier design tried a separate outer parse (swallowed every verb's own
 * flags — fixed) and then a "--root/--format only recognized at the very
 * end of argv" scan (broke completely ordinary invocations like
 * `ay todo ls --format json --owner alice`, where --format isn't the last
 * token — codex-review Important). A single parse per verb, with every
 * option — common and verb-specific — declared on the SAME yargs instance,
 * is how yargs is meant to be used and has neither problem: it correctly
 * separates recognized flags from positional text regardless of order.
 */

import yargs, { type Argv } from "yargs";
import { openStore, CycleError, type TodoRecord } from "./todoStore.ts";
import { isKnownKind, LIFECYCLES, type LifecycleKind } from "./todoLifecycle.ts";
import { describeBlock, type TodoBlock } from "./todoBlock.ts";
import { renderDigest, renderTree } from "./todoDigest.ts";
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

interface CommonOpts {
  root: string;
  format: "table" | "json";
}

function emit(opts: CommonOpts, obj: unknown, human: string): void {
  process.stdout.write((opts.format === "json" ? JSON.stringify(obj, null, 2) : human) + "\n");
}

/** Adds `--root`/`--format` to a verb's own yargs builder — see the module doc comment for why every verb declares these itself rather than a separate outer parse. */
function commonOptions<T>(y: Argv<T>) {
  return y
    .option("root", {
      type: "string" as const,
      default: process.cwd(),
      describe: "project root holding .agent-yes/todos.jsonl",
    })
    .option("format", { choices: ["table", "json"] as const, default: "table" as const });
}

function commonOptsOf(a: { root: string; format: "table" | "json" }): CommonOpts {
  if (a.root === "") fail("--root must not be empty");
  return { root: a.root, format: a.format };
}

export async function runTodoSubcommand(rest0: string[]): Promise<number> {
  const [verb, ...args] = rest0;

  switch (verb) {
    case "new": {
      const sub = commonOptions(yargs(args))
        .option("kind", { type: "string" })
        .option("description", { type: "string" })
        .option("tier", { type: "string" })
        .option("owner", { type: "string" })
        .option("tag", { type: "string", array: true })
        .option("dep", { type: "string", array: true })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      // Join ALL positional args, not just a._[0]: an unquoted summary like
      // `ay todo new write the spec --kind doc` splits into three separate
      // positionals under yargs, and using only the first silently stored
      // "write" as the entire summary (codex-review Important). A summary
      // that must itself contain a literal "--flag"-shaped word is a narrow,
      // separate edge case (yargs will consume it as a flag regardless of
      // which parser sees it) — quote the whole summary in that case.
      const summary = (a._ as (string | number)[]).map(String).join(" ");
      if (!summary) {
        fail(
          "usage: ay todo new <summary> --kind <kind> [--description ...] [--tier ...] [--owner ...] [--tag t]... [--dep id]...",
        );
      }
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
      const sub = commonOptions(yargs(args))
        .option("kind", { type: "string" })
        .option("state", { type: "string" })
        .option("owner", { type: "string" })
        .option("tag", { type: "string" })
        .option("blocked", { type: "boolean", default: false })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
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
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const id = String(a._[0] ?? "");
      if (!id) fail("usage: ay todo get <id>");
      const rec = store.get(id);
      if (!rec) fail(`no such task: ${id}`);
      emit(opts, rec, renderRecord(rec));
      return 0;
    }
    case "transition": {
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const [id, toState] = (a._ as (string | number)[]).map(String);
      if (!id || !toState) fail("usage: ay todo transition <id> <toState>");
      const rec = await store.transition(id, toState);
      emit(opts, rec, `transitioned ${rec._id} -> ${rec.state}\n${renderRecord(rec)}`);
      return 0;
    }
    case "approve": {
      const sub = commonOptions(yargs(args))
        .option("note", { type: "string" })
        .option("link", { type: "string" })
        .help(false)
        .exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const [id, gate, validator] = (a._ as (string | number)[]).map(String);
      if (!id || !gate || !validator) {
        fail("usage: ay todo approve <id> <gate> <validatorIdentity> [--note ...] [--link ...]");
      }
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
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const [id, gate] = (a._ as (string | number)[]).map(String);
      if (!id) fail("usage: ay todo verify <id> [gateName]");
      const rec = await store.verify(id, gate || undefined);
      emit(opts, rec, `verified ${rec._id} -> ${rec.state}\n${renderRecord(rec)}`);
      return 0;
    }
    case "block": {
      const sub = commonOptions(yargs(args))
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
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const id = String(a._[0] ?? "");
      if (!id || !a.type) {
        fail(
          "usage: ay todo block <id> --type <blocked-by-task|blocked-by-human|blocked-by-external|waiting-on-agent> ...",
        );
      }
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
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const id = String(a._[0] ?? "");
      if (!id) fail("usage: ay todo unblock <id>");
      const rec = await store.setBlock(id, null);
      emit(opts, rec, `unblocked ${rec._id}\n${renderRecord(rec)}`);
      return 0;
    }
    case "dep": {
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const [verb2, id, blockerId] = (a._ as (string | number)[]).map(String);
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
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const rootId = a._[0] !== undefined ? String(a._[0]) : undefined;
      const tasks = store.all();
      if (opts.format === "json") {
        const { buildTreeJSON } = await import("./todoDigest.ts");
        emit(opts, buildTreeJSON(tasks, rootId), "");
      } else {
        process.stdout.write(renderTree(tasks, rootId) + "\n");
      }
      return 0;
    }
    case "digest": {
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      const tasks = store.all();
      if (opts.format === "json") {
        const { unblockedTasks } = await import("./todoDigest.ts");
        emit(opts, { tasks, unblocked: unblockedTasks(tasks).map((t) => t._id) }, "");
      } else {
        process.stdout.write(renderDigest(tasks) + "\n");
      }
      return 0;
    }
    case "reconcile": {
      const sub = commonOptions(yargs(args)).help(false).exitProcess(false);
      const a = await sub.parseAsync();
      const opts = commonOptsOf(a);
      const store = await openStore(opts.root);
      // `liveOnly: false`: a task's owner needs to be checked against a KNOWN
      // agent whose latest record says `exited`, not just the currently-live
      // set — an exited-but-recorded agent is exactly the orphan signal (see
      // todoAutomation.ts's `deadOwnerAgent`).
      const agents: LiveAgent[] = await readGlobalPids({ liveOnly: false });
      const registeredGates = new Set(store.registeredGateNames());
      const actions = reconcileTodos(store.all(), agents, registeredGates);

      // Every action is applied against a FRESH record inside the store
      // (see `markOrphaned`/`clearWaitingOnAgentBlock`), since the snapshot
      // `reconcileTodos` decided from can be stale by the time we get here
      // (another process may have reassigned the task, changed its block,
      // etc. — codex-review Important). A per-action failure is reported as
      // a skip, not an aborted reconcile: the remaining actions still apply.
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
              // other reason, e.g. a concurrent state change) is a real
              // "not verified yet" outcome, reported as such rather than
              // silently claimed as success — reconcile just tries again
              // next call (codex-review Important: the previous version
              // swallowed every failure and still reported "auto-verified").
              const result = await store.verify(action.taskId);
              applied.push(`auto-verified ${action.taskId} -> ${result.state}`);
              break;
            }
            case "notify-unblocked": {
              // Delivery to the owning agent's own inbox is not wired yet
              // (the notify system addresses parent<->child pid trees, a
              // different relationship than an arbitrary task owner) —
              // surfaced here, on every call (see todoAutomation.ts), so it
              // is visible rather than silently dropped or falsely retired.
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
        opts,
        { actions, applied },
        applied.length ? applied.join("\n") : "(nothing to reconcile)",
      );
      return 0;
    }
    default:
      fail(
        `unknown "ay todo" verb: "${verb ?? ""}" (expected: new/ls/get/transition/approve/verify/block/unblock/dep/tree/digest/reconcile)`,
      );
  }
}
