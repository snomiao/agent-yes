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
  /**
   * Identifies THIS block instance (see `TodoRecord.blockRev`'s doc
   * comment), not just its content. A client SHOULD echo this back as
   * `AnswerInput.expectedBlockRev` when answering — `answerAsk()` then
   * refuses (rather than silently answering) if the block has since changed,
   * even to another block with byte-for-byte identical text (codex-review
   * round-17 Important: without this, a UI showing a stale/failed card for
   * this task could submit an old answer against a genuinely NEW ask on the
   * same task, e.g. if the new question happens to offer an identically-
   * named option).
   */
  blockRev: number;
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
      blockRev: t.blockRev ?? 0,
    });
  }
  return asks;
}

/**
 * Aggregates asks across every project root that actually has a store —
 * candidates are supplied by the caller (`ts/serve.ts` derives them from the
 * live-agent registry's distinct `cwd`s), keeping this module itself
 * agent-registry-agnostic.
 *
 * Uses `Promise.allSettled`, not `Promise.all`: this is a cross-project
 * aggregation by design, and `Promise.all`'s fail-fast behavior meant ONE
 * project with an unreadable/corrupt store made the ENTIRE decision panel
 * return nothing (a 500 at the route level) — hiding every other project's
 * perfectly healthy asks too (codex-review Important). A failed project is
 * logged and skipped; the healthy ones are still returned.
 */
export async function listAsks(projectRoots: string[]): Promise<AskItem[]> {
  const withStore = [...new Set(projectRoots)].filter(hasTodoStore);
  const results = await Promise.allSettled(withStore.map((root) => listAsksForProject(root)));
  const asks: AskItem[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      asks.push(...result.value);
    } else {
      // No silent caps without a trace: at least log which project failed
      // and why, so a persistently-broken store is discoverable rather than
      // just quietly absent from the panel forever.
      console.error(`[askApi] listAsksForProject(${withStore[i]}) failed:`, result.reason);
    }
  }
  return asks;
}

export interface AnswerInput {
  choice?: string;
  acknowledged?: boolean;
  /** See `AskItem.blockRev`'s doc comment. Optional so direct/programmatic callers that don't track it can still call this — but a UI-driven caller (`ts/serve.ts`'s route, `ask.html`) SHOULD always supply it. */
  expectedBlockRev?: number;
}

/**
 * Applies a human's answer to a `blocked-by-human` task in ONE call: clears
 * the block, and — for the `human`/`decision` kinds ONLY — satisfies that
 * kind's gated outgoing edge as the asked human (`block.who`, always a
 * different identity from the task's `owner` by construction, satisfying
 * independent verification) and advances the transition. This atomicity is
 * the closed loop's core property for those two kinds, and it is about the
 * TASK'S STORED STATE specifically: there is no intermediate state where the
 * block is cleared but the gate/transition hasn't happened, and no separate
 * step a human or orchestrator has to remember to run afterward. (Real-time
 * delivery of the answer to a currently-live agent is a SEPARATE, best-effort
 * concern handled by the caller — see `ts/serve.ts`'s `/api/asks/answer`
 * route — and deliberately not part of this guarantee: if that delivery
 * fails, the task's state is still correctly updated and durable here, and
 * the agent finds out on its own next normal check, e.g. `ay todo get` or a
 * reconcile pass, rather than through a guaranteed push.)
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
export interface AnswerResult {
  record: TodoRecord;
  /**
   * The validated, shape-derived answer text ("acknowledged" for action/bare
   * asks, the matched option for choice-shape ones) — returned alongside the
   * record (whose `block` is already `null` by the time the caller sees it)
   * specifically so a caller wanting to relay this to a live agent (see
   * `ts/serve.ts`'s `/api/asks/answer`) never has to re-derive it from the
   * raw request body itself. Re-deriving it separately from `answer.choice`
   * would reopen exactly the validation gap this field exists to close: an
   * arbitrary, never-checked `choice` string accepted alongside
   * `acknowledged: true` on a non-choice-shape ask (codex-review Important).
   */
  answerText: string;
}

export async function answerAsk(
  projectRoot: string,
  taskId: string,
  answer: AnswerInput,
): Promise<AnswerResult> {
  const store = await openStore(projectRoot);
  const rec = store.get(taskId);
  if (!rec) throw new Error(`no such task: ${taskId}`);
  if (rec.block?.type !== "blocked-by-human") {
    throw new Error(
      `task ${taskId} is not currently blocked-by-human (already answered, or blocked on something else)`,
    );
  }
  if (answer.expectedBlockRev !== undefined && answer.expectedBlockRev !== (rec.blockRev ?? 0)) {
    // The caller's view of this ask is stale — the CURRENT block may even
    // have byte-for-byte identical text to what the caller last saw (e.g.
    // the same question asked again), so a content comparison alone
    // couldn't catch this. Refusing here, rather than answering whatever
    // is currently blocking, is what prevents an answer meant for an
    // earlier ask from being silently applied to a different, later one
    // that happens to share a taskId (codex-review round-17 Important).
    throw new Error(
      `task ${taskId}: this ask has changed since it was loaded (expected blockRev ${answer.expectedBlockRev}, current ${rec.blockRev ?? 0}) — refresh and try again`,
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
  //
  // `answerText` is derived from the SHAPE'S OWN branch, never from a bare
  // `answer.choice ?? "acknowledged"` fallback — the earlier version only
  // checked `answer.acknowledged` for action/acknowledge-shape asks, so a
  // caller could ALSO send an arbitrary, unvalidated `choice` string
  // alongside `acknowledged: true` and have it accepted as the recorded
  // answer (durable evidence, AND written verbatim to a live agent's
  // terminal via IPC) even though it was never checked against anything —
  // a real injection vector on a non-choice-shape ask (codex-review
  // Important).
  let answerText: string;
  if (block.actionLink) {
    if (!answer.acknowledged) {
      throw new Error(
        `task ${taskId}: this ask requires { acknowledged: true } after completing ${block.actionLink}`,
      );
    }
    answerText = "acknowledged";
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
    answerText = answer.choice;
  } else {
    // A bare acknowledge-shape ask requires `acknowledged: true` SPECIFICALLY
    // — a `choice` alone used to also satisfy it (nothing to validate a
    // choice against here, so accepting one was a looser, less clear
    // contract than necessary — codex-review nitpick). `answerText` was
    // already always forced to "acknowledged" regardless, so this doesn't
    // change what gets recorded, only what the caller is required to send.
    if (!answer.acknowledged) {
      throw new Error(`task ${taskId}: this ask requires { acknowledged: true }`);
    }
    answerText = "acknowledged";
  }

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
  //
  // But a retry is only safe to treat as "the same answer resuming" if it
  // ACTUALLY is the same answer: if a first attempt persisted evidence for
  // "a" (then failed before transitioning) and a DIFFERENT request answers
  // "b", silently skipping approve() and transitioning would durably keep
  // "a" as the recorded answer while the human who just successfully
  // submitted "b" has no idea their answer wasn't what got recorded
  // (codex-review Important). Require the existing evidence to match the
  // current answer before treating this as a resumable retry; otherwise
  // this is a genuine conflict (two different answers for one ask), which
  // this function refuses rather than silently picking one.
  if (rec.kind === "human" || rec.kind === "decision") {
    const primary = LIFECYCLES[rec.kind].transitions.find((tr) => tr.from === rec.state && tr.gate);
    if (primary?.gate) {
      if (rec.satisfiedGates.includes(primary.gate)) {
        const existing = [...rec.verifyEvidence].reverse().find((e) => e.gate === primary.gate);
        if (existing?.note !== answerText) {
          throw new Error(
            `task ${taskId}: gate "${primary.gate}" was already satisfied with a DIFFERENT answer ("${existing?.note}") than this request ("${answerText}") — refusing to silently overwrite; resolve the conflict manually`,
          );
        }
      } else {
        await store.approve(taskId, primary.gate, block.who, { note: answerText });
      }
      await store.transition(taskId, primary.to);
    }
  }
  // Clear the SPECIFIC block instance this function decided to answer —
  // not unconditionally by id, and not merely by matching content. `rec`
  // (captured at the very top, before any of the writes above) could have
  // been REPLACED by another process in the meantime with either a
  // genuinely different block (a follow-up question, a re-block on
  // something else entirely) OR one that happens to be byte-for-byte
  // IDENTICAL in content (the exact same question asked again) — an
  // unconditional clear, or a content-only comparison, would silently erase
  // that other, newer block instance too, leaving the task looking
  // unblocked when a real, later block exists (codex-review Important,
  // sharpened round-17 to close the identical-content ABA case).
  // `blockRev` was captured from THIS specific read, before any of this
  // function's own writes could have bumped it.
  const record = await store.clearBlockIfMatches(taskId, rec.blockRev ?? 0);
  return { record, answerText };
}
