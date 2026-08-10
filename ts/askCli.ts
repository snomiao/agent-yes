/**
 * `ay ask <agent> <question>` and `ay answer <task> <text>` — one agent asking
 * another a question, with the question itself tracked as a task.
 *
 * The problem this solves is not delivery (`ay send` already delivers). It is
 * that a delivered question leaves NO trace: if the asker moves on and the
 * answering agent dies, wedges, or simply never replies, nothing anywhere
 * records that an answer is owed, and the asker discovers it only by noticing
 * that it is still waiting. So every ask also writes a `question` task
 * carrying BOTH parties:
 *
 *   owner  = the asking agent      → covered by reconcile's existing orphan
 *                                    rule: if the asker dies, the task is
 *                                    orphaned and offered to another agent.
 *   block  = waiting-on-answer{answerer}
 *                                  → keeps the answerer on the record, so
 *                                    `ay todo ls` can report whether the party
 *                                    that owes an answer is still alive.
 *
 * With both identities stored, an unfinished question is self-describing:
 * either side going `exited` is visible in one `ay todo ls`, which is exactly
 * the failure mode ("who died holding this?") that a bare send cannot answer.
 *
 * `ask` returns immediately, like `ay send` — it does not wait for the answer.
 * It prints the task id and the two commands worth watching (the task's state,
 * and the answering agent's liveness).
 *
 * Delivery deliberately reuses `ay send` rather than reimplementing it: this
 * module builds the `<ay-ask-msg …>` envelope and hands it over as a
 * pre-built body (`--raw`), inheriting the typing backoff, submit-confirm and
 * retry behaviour that path already has. Both the send function and the
 * agent-resolver are injected by the caller (`ts/subcommands.ts`) so this
 * module has no import cycle with it, and so tests can drive it without live
 * agents.
 */

import { randomBytes } from "crypto";
import yargs, { type CommandModule } from "yargs";
import { formatIdentity } from "./identity.ts";
import { openStore } from "./todoStore.ts";
import { resolveTodoRoot } from "./todoRoot.ts";
import { resolveSelf, type SelfIdentity } from "./todoIdentity.ts";
import type { GlobalPidRecord } from "./globalPidIndex.ts";

/** What the host CLI lends this module, so it needs no import of subcommands.ts. */
export interface AskDeps {
  /** Resolve a user-typed keyword (pid / agent id / cwd fragment) to one live agent. Throws if it is ambiguous or unknown. */
  resolveAgent: (keyword: string) => Promise<GlobalPidRecord>;
  /** `ay send`'s own argv entry point — used with `--raw` so the envelope below is delivered verbatim. */
  send: (argv: string[]) => Promise<number>;
  /** Injected for tests; defaults to the real registry lookup. */
  self?: () => Promise<SelfIdentity | null>;
}

function fail(message: string): never {
  throw new Error(message);
}

const out = (s: string) => process.stdout.write(`${s}\n`);

/** First line / first 72 chars of the question — the list view wants one line, `description` keeps the whole thing. */
function summarize(question: string): string {
  const firstLine = question.split("\n")[0]!.trim();
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine || question.trim();
}

/**
 * How the answering agent should reply.
 *
 * `--root` is NOT optional here even though it usually resolves correctly:
 * `ay answer` looks the task up in the store at ITS OWN cwd, and the two
 * agents can be working in different repositories, where that id does not
 * exist (or, worse, exists and means something else). Naming the asker's
 * resolved store root removes the ambiguity — paths are valid across this
 * exchange because delivery is same-host regardless.
 */
function answerCommand(taskId: string, root: string): string {
  return `ay answer ${taskId} --root ${JSON.stringify(root)} "<your answer>"`;
}

/**
 * `<ay-ask-msg …>` — the same envelope shape `ay send` uses, with the reply
 * route pointing at `ay answer` instead of `ay send`. The nonce on the open
 * and close tags is what makes the block's boundaries trustworthy: it is
 * generated after the body was authored, so text inside the question cannot
 * forge a matching pair and truncate or extend the trusted region.
 */
export function buildAskEnvelope(input: {
  question: string;
  taskId: string;
  root: string;
  asker: { cli: string; cwd: string; pid: number } | null;
  nonce?: string;
}): string {
  const nonce = input.nonce ?? randomBytes(4).toString("hex");
  const from = input.asker
    ? `${input.asker.cli} ${formatIdentity({ cwd: input.asker.cwd, pid: input.asker.pid })}`
    : "a human shell";
  return [
    `<ay-ask-msg ${nonce} from ${from} — task ${input.taskId} — reply: ${answerCommand(input.taskId, input.root)}>`,
    input.question,
    `</ay-ask-msg ${nonce}>`,
  ].join("\n");
}

/** The mirror of the above, sent back to the asker when the answer lands. */
export function buildAnswerEnvelope(input: {
  answer: string;
  taskId: string;
  root: string;
  answerer: { cli: string; cwd: string; pid: number } | null;
  nonce?: string;
}): string {
  const nonce = input.nonce ?? randomBytes(4).toString("hex");
  const from = input.answerer
    ? `${input.answerer.cli} ${formatIdentity({ cwd: input.answerer.cwd, pid: input.answerer.pid })}`
    : "a human shell";
  return [
    `<ay-answer-msg ${nonce} from ${from} — answers task ${input.taskId} — close it with: ay todo transition ${input.taskId} done --root ${JSON.stringify(input.root)}>`,
    input.answer,
    `</ay-answer-msg ${nonce}>`,
  ].join("\n");
}

const askCmd = (
  deps: AskDeps,
): CommandModule<
  { root: string | undefined },
  {
    root: string | undefined;
    agent: string;
    question: string[];
    tag: string[] | undefined;
    force: boolean;
  }
> => ({
  command: "$0 <agent> <question..>",
  describe: "ask another agent a question and track it as a task",
  builder: (y) =>
    y
      .positional("agent", {
        type: "string",
        demandOption: true,
        describe:
          "target agent (pid, agent id, or a cwd/prompt fragment — same matching as `ay send`)",
      })
      .positional("question", {
        type: "string",
        array: true,
        demandOption: true,
        describe: "the question (unquoted words are joined)",
      })
      .option("tag", { type: "string", array: true, describe: "tag(s) for the created task" })
      .option("force", {
        type: "boolean",
        default: false,
        describe:
          "skip `ay send`'s recency guard (which otherwise requires you to have tailed the target recently)",
      }),
  handler: async (argv) => {
    const question = argv.question.map(String).join(" ").trim();
    if (!question) fail('usage: ay ask <agent> "<question>"');

    // Resolve the target FIRST: a mistyped keyword should fail before a task
    // exists, not leave a question addressed to nobody sitting in the store.
    const target = await deps.resolveAgent(argv.agent);
    const answerer = target.agent_id;
    if (!answerer) {
      fail(
        `agent ${target.pid} has no stable agent id, so an answer could not be attributed to it ` +
          `(it predates agent-id registration — restart it, or use \`ay send\` instead).`,
      );
    }

    const root = await resolveTodoRoot(argv.root);
    const self = await (deps.self ?? resolveSelf)();
    const store = await openStore(root);
    const task = await store.create({
      summary: summarize(question),
      kind: "question",
      description: question,
      owner: self?.agentId,
      acceptanceCriteria: `${answerer} answers the question (\`ay answer\`), and the asker reads it.`,
      tags: argv.tag ?? [],
    });
    await store.setBlock(task._id, { type: "waiting-on-answer", agentId: answerer, question });

    const body = buildAskEnvelope({
      question,
      taskId: task._id,
      root,
      asker: self ? { cli: self.cli, cwd: self.cwd, pid: self.pid } : null,
    });

    // `--raw`: the envelope above is already complete, and `ay send` would
    // otherwise wrap it in its own `<ay-msg …>` — the recipient would then see
    // two envelopes carrying two different reply routes.
    let delivered = true;
    try {
      // NOT forced by default. `ay send`'s recency guard exists because a
      // fuzzy keyword can resolve to an agent the sender never looked at, and
      // `<agent>` here is exactly such a keyword — asking the wrong agent is
      // the same mistake the guard was built to catch. `--force` is the
      // documented way through, and the failure path below points at it.
      const code = await deps.send([
        String(target.pid),
        body,
        "--raw",
        ...(argv.force ? ["--force"] : []),
      ]);
      delivered = code === 0;
    } catch (err) {
      delivered = false;
      process.stderr.write(
        `warning: could not deliver the question to ${answerer}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // The task is kept either way. A question that was recorded but not
    // delivered is a state someone can see and act on (re-send it, reassign
    // it); deleting it would leave the failure invisible.
    if (!delivered) {
      process.stderr.write(
        `warning: ${task._id} was recorded but NOT delivered. If this was the recency guard, ` +
          `confirm the target first (\`ay tail ${target.pid}\`) then re-ask, or re-run with --force.\n`,
      );
    }

    out(`asked ${answerer} → ${task._id}${delivered ? "" : "  (NOT DELIVERED)"}`);
    out(`  question: ${summarize(question)}`);
    out(`  monitor the answer:   ay todo get ${task._id} --root ${JSON.stringify(root)}`);
    out(`  monitor the answerer: ay status ${answerer}`);
    out(`  both at once:         ay todo ls --blocked --root ${JSON.stringify(root)}`);
  },
});

const answerCmd = (
  deps: AskDeps,
): CommandModule<
  { root: string | undefined },
  { root: string | undefined; task: string; answer: string[] }
> => ({
  command: "$0 <task> <answer..>",
  describe: "answer a question asked via `ay ask`",
  builder: (y) =>
    y
      .positional("task", { type: "string", demandOption: true, describe: "task id from the ask" })
      .positional("answer", {
        type: "string",
        array: true,
        demandOption: true,
        describe: "the answer (unquoted words are joined)",
      }),
  handler: async (argv) => {
    const answer = argv.answer.map(String).join(" ").trim();
    if (!answer) fail('usage: ay answer <task> "<answer>"');

    const root = await resolveTodoRoot(argv.root);
    const store = await openStore(root);
    const task = store.get(argv.task);
    if (!task) fail(`no such task in ${root}: ${argv.task}`);
    if (task.kind !== "question") {
      fail(`task ${argv.task} is a "${task.kind}" task, not a question from \`ay ask\``);
    }

    const self = await (deps.self ?? resolveSelf)();
    // A human at a shell can answer too; they are simply not an agent, and
    // "human" is a validator identity that can never collide with the asker's
    // agent id — so the independence rule below still means something.
    const validator = self?.agentId ?? "human";

    // `approve` enforces validator !== owner, which is exactly the rule that
    // matters here: an asker must not be able to close its own question. That
    // check lives in the store, so it holds however this is invoked.
    await store.approve(task._id, "answer-received", validator, { note: answer });
    const answered = await store.transition(task._id, "answered");
    // Clear the block: the wait is genuinely over, and leaving it set means an
    // ANSWERED question keeps advertising that an answer is owed — `ay todo ls`
    // shows it as still waiting, and reconcile reports "exited without
    // answering" if the (now finished) answerer has since gone. The answerer's
    // identity is not lost: `approve` recorded it as the gate's validator, so
    // it stays visible in `verifyEvidence` for good.
    await store.setBlock(task._id, null);

    // Tell the asker, if it is an agent that is still around. Best-effort:
    // the answer is already durably recorded on the task either way, so a
    // failed delivery must not fail the command and lose it.
    let notified = false;
    if (answered.owner) {
      const body = buildAnswerEnvelope({
        answer,
        taskId: task._id,
        root,
        answerer: self ? { cli: self.cli, cwd: self.cwd, pid: self.pid } : null,
      });
      try {
        const asker = await deps.resolveAgent(answered.owner);
        // `--force` here, unlike in `ask`: the recipient is not a keyword
        // someone typed, it is the asker recorded ON THE TASK — the record is
        // the confirmation the recency guard would be asking for, and the
        // answerer has no reason to have tailed whoever asked it something.
        notified = (await deps.send([String(asker.pid), body, "--raw", "--force"])) === 0;
      } catch {
        notified = false;
      }
    }

    out(`answered ${task._id} (validator: ${validator}) → ${answered.state}`);
    if (answered.owner) {
      out(
        notified
          ? `  told the asker: ${answered.owner}`
          : `  could NOT reach the asker (${answered.owner}) — the answer is recorded on the task: ay todo get ${task._id} --root ${JSON.stringify(root)}`,
      );
    }
    out(
      `  the asker closes it with: ay todo transition ${task._id} done --root ${JSON.stringify(root)}`,
    );
  },
});

/** Shared by both verbs: `--root` mirrors `ay todo`'s, resolved the same way. */
function withGlobals(y: ReturnType<typeof yargs>, scriptName: string) {
  return y
    .scriptName(scriptName)
    .option("root", {
      type: "string",
      defaultDescription: "the repo's common root (shared across worktrees), else cwd",
      describe: "project root holding .agent-yes/todos.jsonl",
      global: true,
    })
    .check((argv) => {
      if ((argv.root as string) === "") fail("--root must not be empty");
      return true;
    })
    .strict()
    .help()
    .version(false)
    .exitProcess(false)
    .fail((msg, err) => {
      throw err ?? new Error(msg);
    });
}

export async function runAskSubcommand(rest: string[], deps: AskDeps): Promise<number> {
  if (rest.length === 0) {
    withGlobals(yargs([]), "ay ask")
      .command(askCmd(deps))
      .showHelp((s) => out(s));
    return 0;
  }
  await withGlobals(yargs(rest), "ay ask").command(askCmd(deps)).parseAsync();
  return 0;
}

export async function runAnswerSubcommand(rest: string[], deps: AskDeps): Promise<number> {
  if (rest.length === 0) {
    withGlobals(yargs([]), "ay answer")
      .command(answerCmd(deps))
      .showHelp((s) => out(s));
    return 0;
  }
  await withGlobals(yargs(rest), "ay answer").command(answerCmd(deps)).parseAsync();
  return 0;
}
