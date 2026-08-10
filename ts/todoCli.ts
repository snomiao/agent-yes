/**
 * `ay todo <verb>` — CLI surface for the lifecycle engine (`todoStore.ts`),
 * typed blocks (`todoBlock.ts`), and read-side views (`todoDigest.ts`).
 *
 * Registered from `ts/subcommands.ts` the same way larger subsystems like
 * `serve`/`schedule`/`expose` are: a lazy `case "todo":` import into
 * `runTodoSubcommand`, so this file (and everything it pulls in) is only
 * loaded when `ay todo ...` is actually invoked.
 *
 * Store location: `--root <dir>` is where `.agent-yes/todos.jsonl` lives,
 * mirroring `PidStore`'s own `<workingDir>/.agent-yes/...` convention. Left
 * unset it resolves to the REPO's common root rather than the cwd, so agents
 * in different worktrees share one list — see `todoRoot.ts` for why that
 * matters and where the line is drawn.
 *
 * Cross-agent surface, on top of that shared store: `--owner me` resolves to
 * the calling agent's registry id (`todoIdentity.ts`), `new` assigns to the
 * caller by default, `claim` takes a task over while refusing to steal from a
 * live agent, and `ls`/`get` annotate each owner with whether that agent is
 * still alive. `reconcile` (already present) closes the loop by orphaning
 * tasks whose owner agent exited.
 *
 * Argument parsing: a real yargs COMMAND TREE — one `yargs(argv)` instance
 * with a `CommandModule` per verb registered via `.command()`, `--root`/
 * `--format` declared once as `global: true` options on that same instance —
 * matching the pattern a private sibling repo's CLI already uses
 * (`todoCommand`/`lsCmd` etc. in that repo's `commands/todo.ts`), per the operator's
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
import { openStore, CycleError, type TodoStore, type TodoRecord } from "./todoStore.ts";
import { isKnownKind, LIFECYCLES, type LifecycleKind } from "./todoLifecycle.ts";
import { blockedOnAgent, describeBlock, type TodoBlock } from "./todoBlock.ts";
import { renderDigest, renderTree, buildTreeJSON, unblockedTasks } from "./todoDigest.ts";
import { reconcileTodos, type LiveAgent } from "./todoAutomation.ts";
import { readGlobalPids } from "./globalPidIndex.ts";
import { removeControlCharacters } from "./removeControlCharacters.ts";
import { resolveTodoRoot } from "./todoRoot.ts";
import { NO_OWNER, SELF_OWNER, ownerLiveness, resolveSelf } from "./todoIdentity.ts";

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Same check ask.html's own render-time guard uses — a real URL parse, not
 * just a scheme-prefix regex, which could still let a malformed string
 * through. Returns the parser's own normalized `.href` (not the raw input)
 * on success, `null` otherwise: WHATWG URL parsing tolerates/strips some
 * control characters (e.g. embedded tabs/newlines) from the input while
 * still returning a valid http(s) URL, so validating against `s` but then
 * STORING `s` verbatim could still persist those raw control characters
 * into the store — later rendered as terminal/log text by `describeBlock()`
 * (codex-review Important). Storing `.href` instead guarantees the store
 * only ever holds what the parser actually validated.
 */
function normalizeHttpUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function parseKind(raw: string | undefined): LifecycleKind {
  if (!raw) fail(`--kind is required (one of: ${Object.keys(LIFECYCLES).join(", ")})`);
  if (!isKnownKind(raw))
    fail(`unknown kind "${raw}" (one of: ${Object.keys(LIFECYCLES).join(", ")})`);
  return raw;
}

function renderRecord(t: TodoRecord, agents: LiveAgent[] = []): string {
  // The party a task is WAITING ON is the other half of "who is holding this?"
  // — `ay ask` records the answering agent there, so a question whose answerer
  // died reads as such here instead of looking merely unanswered.
  const waitingOn = blockedOnAgent(t.block);
  const waitStatus = waitingOn ? ownerLiveness(waitingOn, agents) : "unknown";
  const lines = [
    `${t._id} [${t.state}] ${t.summary}`,
    `kind:    ${t.kind}${t.targetTier ? `  tier:${t.targetTier}` : ""}`,
    ...(t.owner ? [`owner:   ${t.owner}`] : []),
    ...(t.acceptanceCriteria ? [`acceptanceCriteria: ${t.acceptanceCriteria}`] : []),
    ...(t.block
      ? [
          `block:   ${describeBlock(t.block)}${waitingOn && waitStatus !== "unknown" ? ` [${waitingOn} is ${waitStatus}]` : ""}`,
        ]
      : []),
    ...(t.blockedBy.length ? [`blockedBy: ${t.blockedBy.join(", ")}`] : []),
    ...(t.tags.length ? [`tags:    ${t.tags.join(", ")}`] : []),
    ...(t.satisfiedGates.length ? [`satisfiedGates: ${t.satisfiedGates.join(", ")}`] : []),
    ...(t.verifyEvidence.length
      ? [
          `evidence: ${t.verifyEvidence.map((e) => `${e.gate} by ${e.validator}${e.link ? ` (${e.link})` : ""}${e.acceptanceCriteriaAtApproval ? ` [criteria: ${e.acceptanceCriteriaAtApproval}]` : ""}`).join("; ")}`,
        ]
      : []),
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
  ];
  if (t.description) lines.push("", t.description);
  return lines.join("\n");
}

/**
 * `owner` as displayed: the stored string plus, when it names an agent the
 * registry knows, that agent's current status — `agt-7(exited)`. An owner with
 * no registry entry (a human, or an agent that never registered) prints bare,
 * because "unknown" there means "not an agent", not "possibly dead".
 *
 * This is the whole point of the shared store being readable across agents:
 * the interesting question about a task someone else owns is almost always
 * "is that someone still running?", and answering it by cross-referencing
 * `ay ls` by hand is exactly the step that gets skipped.
 */
function ownerCell(t: TodoRecord, agents: LiveAgent[]): string {
  if (!t.owner) return "";
  const status = ownerLiveness(t.owner, agents);
  return status === "unknown" ? t.owner : `${t.owner}(${status})`;
}

/** Same treatment for the agent a task is WAITING ON — `ay ask`'s answerer. */
function waitingOnCell(t: TodoRecord, agents: LiveAgent[]): string {
  const who = blockedOnAgent(t.block);
  if (!who) return "";
  const status = ownerLiveness(who, agents);
  return status === "unknown" ? who : `${who}(${status})`;
}

function renderList(tasks: TodoRecord[], agents: LiveAgent[] = []): string {
  if (tasks.length === 0) return "(no tasks match)";
  // The WAITING-ON column appears only when something is actually waiting on an
  // agent, so an ordinary task list is not padded with an empty column — but
  // when `ay ask` questions are in the list, both parties and both liveness
  // states are on one line, which is the entire point of recording them.
  const waiting = tasks.map((t) => waitingOnCell(t, agents));
  const showWaiting = waiting.some(Boolean);
  const rows = tasks.map((t, i) => [
    t._id,
    t.state,
    t.kind,
    ownerCell(t, agents),
    ...(showWaiting ? [waiting[i]!] : []),
    t.summary,
  ]);
  const header = [
    "ID",
    "STATE",
    "KIND",
    "OWNER",
    ...(showWaiting ? ["WAITING-ON"] : []),
    "SUMMARY",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (xs: string[]) =>
    xs
      .map((x, i) => x.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

interface GlobalOpts {
  /** Undefined means "not specified" — resolved per call by `resolveTodoRoot` (repo root, not cwd). See `todoRoot.ts`. */
  root: string | undefined;
  format: "table" | "json";
}

function emit(opts: GlobalOpts, obj: unknown, human: string): void {
  process.stdout.write((opts.format === "json" ? JSON.stringify(obj, null, 2) : human) + "\n");
}

/**
 * Open the store every verb works against. Resolution is deferred to call
 * time (rather than baked into a yargs `default:`) because the default is
 * DERIVED — it shells out to git — and a yargs default is evaluated eagerly at
 * parse time, on every invocation including `--help`.
 */
async function storeFor(opts: GlobalOpts): Promise<TodoStore> {
  return openStore(await resolveTodoRoot(opts.root));
}

/**
 * Turn an `--owner` value into what gets stored: `me` → this agent's
 * `agent_id`, `none` → explicitly unowned, anything else verbatim.
 *
 * `me` is an ERROR outside an agent, never a silent fallback to a hostname or
 * pid: those look like an agent assignment to a reader but match nothing in
 * the agent index, so the task would sit permanently outside orphan recovery
 * (see `todoIdentity.ts`).
 */
/**
 * The agent snapshot every cross-agent view is read against.
 *
 * `liveOnly: false` deliberately: the interesting answer for an owner is often
 * "that agent EXITED", which a live-only read cannot express — it would drop
 * the record and make a dead owner indistinguishable from a human one. Same
 * reasoning (and same call) as `reconcile`, which needs exited records to
 * orphan against.
 */
async function liveAgents(): Promise<LiveAgent[]> {
  return readGlobalPids({ liveOnly: false });
}

async function resolveOwnerArg(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  if (raw === NO_OWNER || raw === "") return undefined;
  if (raw !== SELF_OWNER) return raw;
  const self = await resolveSelf();
  if (!self)
    fail(
      `--owner ${SELF_OWNER} needs an agent context: this process has no registered agent id ` +
        `(run it inside an \`ay\`-managed agent, or pass an explicit --owner).`,
    );
  return self.agentId;
}

const newCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & {
    summary: string[];
    kind: string | undefined;
    description: string | undefined;
    tier: string | undefined;
    "acceptance-criteria": string | undefined;
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
      .option("acceptance-criteria", {
        type: "string",
        describe:
          "definition of done for this task — what an independent validator should check before approving/verifying it",
      })
      .option("owner", {
        type: "string",
        describe: `"me" (this agent), "${NO_OWNER}" to leave unowned, or any handle. Default: this agent when run inside one, else unowned`,
      })
      .option("tag", { type: "string", array: true })
      .option("dep", { type: "string", array: true, describe: "blocker task id(s)" }),
  handler: async (argv) => {
    const store = await storeFor(argv);
    // Join ALL summary words: an unquoted summary like
    // `ay todo new write the spec --kind doc` arrives as multiple array
    // entries under yargs' `<summary..>` variadic positional — using only
    // the first would silently truncate it (codex-review Important, from
    // the previous hand-rolled-positional design; the variadic positional
    // here still needs the same join, it just collects the array for us).
    const summary = argv.summary.map(String).join(" ");
    if (!summary) {
      fail(
        "usage: ay todo new <summary> --kind <kind> [--description ...] [--tier ...] [--acceptance-criteria ...] [--owner ...] [--tag t]... [--dep id]...",
      );
    }
    // No `--owner` at all means "mine" when an agent is running this, so a
    // task an agent creates for itself is visible as ITS work to every other
    // agent (and eligible for orphan recovery) without a second command. A
    // human shell has no agent id, so it falls through to unowned — the
    // previous behavior for everyone. `--owner none` opts out explicitly.
    const owner =
      argv.owner === undefined ? (await resolveSelf())?.agentId : await resolveOwnerArg(argv.owner);
    const rec = await store.create({
      summary,
      kind: parseKind(argv.kind),
      description: argv.description,
      targetTier: argv.tier,
      acceptanceCriteria: argv["acceptance-criteria"],
      owner,
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
      .option("owner", {
        type: "string",
        describe: `owner handle, or "${SELF_OWNER}" for this agent`,
      })
      .option("tag", { type: "string" })
      .option("blocked", { type: "boolean", default: false }),
  handler: async (argv) => {
    const store = await storeFor(argv);
    const tasks = store.list({
      kind: argv.kind ? parseKind(argv.kind) : undefined,
      state: argv.state,
      owner: await resolveOwnerArg(argv.owner),
      tag: argv.tag,
      blocked: argv.blocked,
    });
    const agents = await liveAgents();
    // JSON keeps the record shape untouched and adds ONE derived field, rather
    // than folding the status into `owner` the way the table does: a consumer
    // filtering on `owner` must still see the same string that was stored.
    emit(
      argv,
      tasks.map((t) => ({
        ...t,
        ownerLiveness: ownerLiveness(t.owner, agents),
        // Present (as "unknown") only when the task actually waits on an
        // agent, so a consumer can tell "not waiting on anyone" apart from
        // "waiting on someone we cannot find in the registry".
        ...(blockedOnAgent(t.block)
          ? { waitingOnLiveness: ownerLiveness(blockedOnAgent(t.block)!, agents) }
          : {}),
      })),
      renderList(tasks, agents),
    );
  },
};

/**
 * `ay todo claim <id>` — take ownership of a task.
 *
 * Refuses when the current owner is an agent the registry still reports as
 * `active`/`idle`, because in a shared store the overwhelmingly likely reading
 * of "task X is owned by a running agent" is that the agent is working on it
 * right now; silently reassigning would put two agents on one task, each
 * believing it is theirs. A dead owner (`exited`) or a non-agent owner is
 * taken over without ceremony — that is the recovery path this verb exists
 * for. `--force` covers the rest ("it's wedged, I'm taking it").
 */
const claimCmd: CommandModule<
  GlobalOpts,
  GlobalOpts & { id: string; owner: string | undefined; force: boolean }
> = {
  command: "claim <id>",
  describe: "take ownership of a task (refuses to steal from a live agent)",
  builder: (y) =>
    y
      .positional("id", { type: "string", demandOption: true })
      .option("owner", {
        type: "string",
        describe: `who to assign to (default: "${SELF_OWNER}", this agent)`,
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "claim even if the current owner agent is still running",
      }),
  handler: async (argv) => {
    const store = await storeFor(argv);
    const before = store.get(argv.id);
    if (!before) fail(`no such task: ${argv.id}`);
    const next = await resolveOwnerArg(argv.owner ?? SELF_OWNER);
    if (!next)
      fail(`--owner ${NO_OWNER} is not a claim — use \`ay todo claim <id> --owner <who>\``);

    const held = ownerLiveness(before.owner, await liveAgents());
    if (
      before.owner &&
      before.owner !== next &&
      !argv.force &&
      (held === "active" || held === "idle")
    ) {
      fail(
        `task ${argv.id} is owned by ${before.owner}, an agent that is still ${held}. ` +
          `Re-run with --force to take it anyway.`,
      );
    }
    // Pass the owner this decision was made against: the store re-checks it
    // inside the write lock, so a second claimer that slipped in between the
    // read above and this write loses loudly instead of silently overwriting.
    const rec = await store.setOwner(argv.id, next, before.owner ?? null);
    emit(argv, rec, `claimed ${rec._id} → ${next}\n${renderRecord(rec)}`);
  },
};

const getCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string }> = {
  command: "get <id>",
  describe: "show one task",
  builder: (y) => y.positional("id", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const store = await storeFor(argv);
    const rec = store.get(argv.id);
    if (!rec) fail(`no such task: ${argv.id}`);
    emit(argv, rec, renderRecord(rec, await liveAgents()));
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
    const store = await storeFor(argv);
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
    const store = await storeFor(argv);
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
      const store = await storeFor(argv);
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
        // choice-shape (--options) and action-shape (--action-link) are
        // mutually exclusive — reject the combination outright here rather
        // than let it depend on askApi.ts's own tie-breaking precedence
        // (which, as of codex-review round-9, checks actionLink first in
        // BOTH listAsksForProject() and answerAsk(), so the two now agree
        // with each other even if this guard were bypassed by a direct
        // library caller — but a block should simply never be created with
        // both set in the first place).
        if (argv.options?.length && argv["action-link"]) {
          fail(
            "--options and --action-link are mutually exclusive (choice-shape vs action-shape ask)",
          );
        }
        let normalizedActionLink: string | undefined;
        if (argv["action-link"]) {
          const normalized = normalizeHttpUrl(argv["action-link"]);
          if (!normalized) {
            // The /ask page renders this straight into an <a href>. HTML-
            // escaping the text does NOT block dangerous URL schemes
            // (`javascript:`, `data:`) — only the scheme itself does. Reject
            // at write time so a non-http(s) link can never reach the store
            // at all (codex-review Important). Uses the same `URL` parser
            // ask.html's own render-time check uses (codex-review nitpick: a
            // regex prefix match alone would still store a malformed string
            // like "https:/notreallyaurl" that happens to match the prefix).
            // The rejected input is echoed for the operator's benefit, but
            // never verbatim — an invalid value can still contain control
            // characters/newlines, and this string reaches a terminal
            // (codex-review round-18 nitpick).
            fail(
              `--action-link must be a valid http:// or https:// URL (got "${removeControlCharacters(argv["action-link"]).replace(/[\r\n]+/g, " ")}")`,
            );
          }
          normalizedActionLink = normalized;
        }
        block = {
          type: "blocked-by-human",
          who: argv.who,
          question: argv.question,
          options: argv.options,
          actionLink: normalizedActionLink,
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
    const store = await storeFor(argv);
    const rec = await store.setBlock(argv.id, block);
    emit(argv, rec, `blocked ${rec._id}: ${describeBlock(block)}\n${renderRecord(rec)}`);
  },
};

const unblockCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string }> = {
  command: "unblock <id>",
  describe: "clear a task's block (does not touch blockedBy — see `dep`)",
  builder: (y) => y.positional("id", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const store = await storeFor(argv);
    const rec = await store.setBlock(argv.id, null);
    emit(argv, rec, `unblocked ${rec._id}\n${renderRecord(rec)}`);
  },
};

const setCriteriaCmd: CommandModule<GlobalOpts, GlobalOpts & { id: string; text: string[] }> = {
  command: "set-criteria <id> <text..>",
  describe: "set or update a task's acceptance criteria (definition of done)",
  builder: (y) =>
    y
      .positional("id", { type: "string", demandOption: true })
      .positional("text", { type: "string", array: true, demandOption: true }),
  handler: async (argv) => {
    const store = await storeFor(argv);
    const text = argv.text.map(String).join(" ");
    const rec = await store.setAcceptanceCriteria(argv.id, text);
    emit(argv, rec, `set acceptance criteria on ${rec._id}\n${renderRecord(rec)}`);
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
    const store = await storeFor(argv);
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
    const store = await storeFor(argv);
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
    const store = await storeFor(argv);
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
    const store = await storeFor(argv);
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
          case "answerer-gone": {
            // Report-only by design (see the action's doc comment): the answer
            // is still owed, so nothing about the task is changed here.
            applied.push(
              `${action.taskId}: ${action.agentId} exited without answering` +
                (action.owner ? ` (asked by ${action.owner})` : ""),
            );
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
  const y = yargs(rest0)
    .scriptName("ay todo")
    .option("root", {
      type: "string",
      // No `default:`. The default is derived (a git call) and yargs evaluates
      // defaults eagerly on every parse — including `--help` — so it is
      // resolved per verb in `storeFor` instead. `defaultDescription` keeps
      // `--help` honest about what happens when the flag is omitted.
      defaultDescription: "the repo's common root (shared across worktrees), else cwd",
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
    .command(setCriteriaCmd)
    .command(blockCmd)
    .command(unblockCmd)
    .command(depCmd)
    .command(claimCmd)
    .command(treeCmd)
    .command(digestCmd)
    .command(reconcileCmd)
    // No `.demandCommand()`: "you typed no verb" is handled after the parse by
    // printing help (see below), which lists every verb and its description —
    // strictly more informative than the sentence demandCommand threw, and not
    // an error condition in the first place. Unknown verbs and bad flags are
    // still rejected, by `.strict()`.
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
    });

  const argv = await y.parseAsync();

  // `ay todo` with no verb is a person asking what this thing does, not a
  // malformed command. It used to answer with a thrown Error — and, since the
  // launcher prints uncaught errors with their stack, a wall of yargs
  // internals ahead of the one useful line. A bare `ay` already prints help;
  // this makes `ay todo` behave the same.
  //
  // Keyed on the parsed positionals, not on `rest0.length`: `ay todo --root
  // /x` is equally verb-less and equally deserves help, and yargs has already
  // sorted flags from commands by this point. Unknown verbs still fail via
  // `.strict()` — this branch only fires when NOTHING was asked for.
  if (argv._.length === 0) {
    y.showHelp((s) => process.stdout.write(`${s}\n`));
  }
  return 0;
}
