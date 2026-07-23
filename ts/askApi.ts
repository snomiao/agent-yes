/**
 * `/ask` decision panel (A7): aggregates every `blocked-by-human` task across
 * every project this host's agents have registered onto one human-facing
 * view, and closes the loop when a human answers.
 *
 * Pure store logic only — no HTTP, no live-agent notification. `ts/serve.ts`
 * wires this into `GET /api/asks` / `POST /api/asks/answer` and, as a
 * best-effort follow-up after `answerAsk()` resolves, writes the answer into
 * the owning agent's terminal via the same FIFO mechanism `/api/send`
 * already uses (see that route) — kept out of this module so it stays
 * testable without a live server or live agent processes.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { LIFECYCLES } from "./todoLifecycle.ts";
import { openStore, type TodoRecord } from "./todoStore.ts";

export interface AskItem {
  projectRoot: string;
  taskId: string;
  summary: string;
  who: string;
  question?: string;
  /** `action`: the human must personally complete something at `actionLink` (e.g. OAuth/CAPTCHA), then confirm. `choice`: pick one of `options`. `acknowledge`: a bare question with neither — just needs an acknowledgement. */
  shape: "choice" | "action" | "acknowledge";
  options?: string[];
  actionLink?: string;
}

/** Whether `projectRoot` has ever had an `ay todo` store created — used to skip candidate project roots (e.g. from a live-agent scan) that never called `ay todo` at all. */
export function hasTodoStore(projectRoot: string): boolean {
  return existsSync(path.join(projectRoot, ".agent-yes", "todos.jsonl"));
}

export async function listAsksForProject(projectRoot: string): Promise<AskItem[]> {
  const store = await openStore(projectRoot);
  const asks: AskItem[] = [];
  for (const t of store.all()) {
    if (t.block?.type !== "blocked-by-human") continue;
    const block = t.block;
    asks.push({
      projectRoot,
      taskId: t._id,
      summary: t.summary,
      who: block.who,
      question: block.question,
      options: block.options,
      actionLink: block.actionLink,
      shape: block.actionLink ? "action" : block.options?.length ? "choice" : "acknowledge",
    });
  }
  return asks;
}

/** Aggregates asks across every project root that actually has a store — candidates are supplied by the caller (`ts/serve.ts` derives them from the live-agent registry's distinct `cwd`s), keeping this module itself agent-registry-agnostic. */
export async function listAsks(projectRoots: string[]): Promise<AskItem[]> {
  const withStore = [...new Set(projectRoots)].filter(hasTodoStore);
  const perProject = await Promise.all(withStore.map((root) => listAsksForProject(root)));
  return perProject.flat();
}

export interface AnswerInput {
  choice?: string;
  acknowledged?: boolean;
}

/**
 * Applies a human's answer to a `blocked-by-human` task in ONE call: clears
 * the block, and — for the `human`/`decision` kinds ONLY — satisfies that
 * kind's gated outgoing edge as the asked human (`block.who`, always a
 * different identity from the task's `owner` by construction, satisfying
 * independent verification) and advances the transition. This atomicity is
 * the closed loop's core property for those two kinds: there is no
 * intermediate state where the block is cleared but the gate/transition
 * hasn't happened, and no separate step a human or orchestrator has to
 * remember to run afterward.
 *
 * Restricted to `human`/`decision` deliberately: this function opens its own
 * fresh `TodoStore` (via `openStore`), which has NO registered gates of its
 * own — `registerGate()` is an in-memory, per-process registration a
 * consuming project makes on ITS OWN store instance (e.g. Part B registering
 * `sym003-canary-green`), invisible to a store opened here. For `code`/
 * `doc`/`investigation` kinds, a `blocked-by-human` block can sit on a task
 * whose CURRENT state's gated edge is actually a registered, automated gate
 * in the real deployment (verifying->done via a CI/QA check) — blindly
 * checking `isRegisteredGate()` on a throwaway instance would ALWAYS see it
 * as unregistered and incorrectly let a human's mere acknowledgement drive
 * straight past an automated verification step. `human`/`decision` don't
 * have this ambiguity: their gated edges (`human-replied`, `human-decided`)
 * exist SPECIFICALLY to be satisfied by a human answering — there is no
 * automated-gate competition to accidentally bypass. For every other kind,
 * this function only clears the block; whatever actually owns that kind's
 * transition (an agent, `ay todo verify`, etc.) still drives it.
 */
export async function answerAsk(
  projectRoot: string,
  taskId: string,
  answer: AnswerInput,
): Promise<TodoRecord> {
  const store = await openStore(projectRoot);
  const rec = store.get(taskId);
  if (!rec) throw new Error(`no such task: ${taskId}`);
  if (rec.block?.type !== "blocked-by-human") {
    throw new Error(
      `task ${taskId} is not currently blocked-by-human (already answered, or blocked on something else)`,
    );
  }
  const block = rec.block;
  // actionLink checked FIRST, matching listAsksForProject's own shape
  // precedence exactly — if a block somehow has both `options` and
  // `actionLink` set (the CLI's `ay todo block` rejects that combination,
  // but a direct library caller could still construct one), both functions
  // must agree on which shape it is, or an ask could be listed as
  // action-shape yet still demand a choice here, making it unanswerable via
  // the /ask UI (codex-review Important).
  if (block.actionLink) {
    if (!answer.acknowledged) {
      throw new Error(
        `task ${taskId}: this ask requires { acknowledged: true } after completing ${block.actionLink}`,
      );
    }
  } else if (block.options?.length) {
    if (!answer.choice) {
      throw new Error(
        `task ${taskId}: this ask requires a choice (one of: ${block.options.join(", ")})`,
      );
    }
    if (!block.options.includes(answer.choice)) {
      throw new Error(
        `task ${taskId}: "${answer.choice}" is not one of the offered options (${block.options.join(", ")})`,
      );
    }
  } else if (!answer.acknowledged && !answer.choice) {
    throw new Error(`task ${taskId}: this ask requires { acknowledged: true } or a choice`);
  }
  const answerText = answer.choice ?? "acknowledged";

  // Satisfy the gate/transition (human/decision kinds only) BEFORE clearing
  // the block: if either call throws (e.g. a concurrent write raced this
  // one), the task is left correctly STILL blocked, not silently unblocked
  // with nothing having advanced — the previous order cleared the block
  // first, which could strand a task in an inconsistent, no-longer-visible
  // state on a mid-sequence failure (codex-review Important).
  //
  // `approve()` and `transition()` are two separately-persisted writes, not
  // one atomic operation the underlying store supports — if `approve()`
  // succeeds but `transition()` then throws (e.g. the state changed
  // concurrently), a naive retry of this whole function would call
  // `approve()` again and append a SECOND, duplicate evidence entry for the
  // same gate (codex-review Important). Skipping `approve()` when the gate
  // is already in the FRESH record's `satisfiedGates` makes a retry after
  // exactly that failure idempotent — it lands on `transition()` directly
  // instead of re-approving — without needing a full transactional rewrite
  // of the store.
  if (rec.kind === "human" || rec.kind === "decision") {
    const primary = LIFECYCLES[rec.kind].transitions.find((tr) => tr.from === rec.state && tr.gate);
    if (primary?.gate) {
      if (!rec.satisfiedGates.includes(primary.gate)) {
        await store.approve(taskId, primary.gate, block.who, { note: answerText });
      }
      await store.transition(taskId, primary.to);
    }
  }
  return store.setBlock(taskId, null);
}
