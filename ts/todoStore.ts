/**
 * Persistence and gate-enforcement layer for the `ay todo` engine.
 *
 * Storage is one `JsonlStore` (see `JsonlStore.ts`) per project — append-only,
 * one line per create/update, "same `_id` → last line wins" merge, already
 * multi-process safe via `proper-lockfile`. This is deliberately reused
 * rather than reinvented: two agents editing two different tasks never
 * conflict (different `_id`s), and two agents editing the SAME task resolve
 * to last-write-wins without any manual JSON merge — the exact multi-writer
 * problem a from-scratch flat-JSON-array store would have to solve by hand.
 *
 * The single most important property of this module is INDEPENDENT
 * VERIFICATION: the identity that satisfies a gate must never be the same
 * identity as the task's owner (the one who did the work). This is not
 * "automated checks only" — a manual approval is entirely acceptable, as
 * long as the approver is provably someone (or something) other than the
 * worker. A task can only reach a gated state through one of two paths, and
 * both enforce this at the same choke point rather than leaving it to
 * caller discipline —
 *
 *   1. A REGISTERED gate (one whose check function was supplied via
 *      `registerGate`, e.g. a CI/QA check) can ONLY be satisfied by
 *      `verify()`, which actually calls that check function. `transition()`
 *      refuses to move a task across an edge whose gate is registered, even
 *      if asked to — there is no argument or flag that bypasses this. A
 *      registered check is, by construction, an independent system distinct
 *      from the worker, so it always satisfies the independence rule.
 *   2. A gate that is NOT registered is treated as a manual, attested gate
 *      (e.g. "a person approved this"): it can only be satisfied by
 *      `approve()`, which REQUIRES a `validatorIdentity` argument and
 *      refuses the call outright if that identity matches the task's
 *      `owner` — the worker can never certify their own work. This is the
 *      one rule this module enforces unconditionally; everything else about
 *      who is allowed to approve what is left to the consuming project.
 *
 * Nothing in this file mentions any specific product, company, or external
 * system — a consuming project supplies concrete gate behavior by calling
 * `registerGate` with its own check function (see `GateRegistration`).
 */

import path from "path";
import { lock } from "proper-lockfile";
import { JsonlStore, type JsonlDoc } from "./JsonlStore.ts";
import {
  DONE_STATE,
  LIFECYCLES,
  ORPHANED_STATE,
  canTransition,
  initialState,
  requiredGate,
  type LifecycleKind,
} from "./todoLifecycle.ts";
import type { TodoBlock } from "./todoBlock.ts";

export interface GateEvidence {
  gate: string;
  passedAt: string;
  /** Who/what satisfied the gate. For a registered gate this is the gate's own name (an automated system is inherently independent of the worker). For a manual gate this is the human-supplied `validatorIdentity` passed to `approve()`, always distinct from the task's owner at approval time. */
  validator: string;
  note?: string;
  link?: string;
  /** The task's `acceptanceCriteria` TEXT as it read at the moment this manual gate was approved (not merely a reference to the live field, which could be edited afterward) — durably records what the validator actually judged the work against. Absent if the task had no acceptance criteria set at approval time. Only set by `approve()`; a registered gate's own `check(record)` already receives the live `acceptanceCriteria` on the record it's passed, so no snapshot is needed there. */
  acceptanceCriteriaAtApproval?: string;
}

export interface TodoRecord extends JsonlDoc {
  kind: LifecycleKind;
  state: string;
  /** Which done-tier this task targets, e.g. a project may define "canary-done" vs "shipped-done". Optional: not every project uses tiers. */
  targetTier?: string;
  summary: string;
  description: string;
  /** Free-text definition of done for THIS task — what an independent validator should check before approving/verifying it. Optional at this layer (Part A stays neutral on whether it's required; a consuming project enforces that itself, e.g. by validating it in its own CLI wrapper before calling `create`). Editable via `setAcceptanceCriteria` since criteria may firm up after a task starts. */
  acceptanceCriteria?: string;
  /** A human name/handle, or a tracked agent's stable identifier. Opaque to this module. */
  owner?: string;
  /** `null` (not `undefined`) is the explicit "no block" value once a task has ever been blocked — JSON drops `undefined` keys entirely, so an update line with an omitted `block` would silently fail to clear a previous value on reload; `null` serializes and therefore actually overwrites (see `setBlock`). */
  block?: TodoBlock | null;
  /** Task-id dependencies — separate from `block`: a task can both structurally depend on other tasks AND be separately blocked-by-human at the same time. */
  blockedBy: string[];
  tags: string[];
  /** Gate names satisfied via `approve()` but not yet consumed by a `transition()` call. */
  satisfiedGates: string[];
  /** Append-only history of every gate that has ever passed for this task (manual or registered), the append-only proof trail `verifyEvidence` from the ExecPlan. */
  verifyEvidence: GateEvidence[];
  /** Set by `markOrphaned` (see `todoAutomation.ts`) — the state the task was in right before its owner agent vanished, so whoever picks it up knows where work left off. */
  orphanedFrom?: string;
  /** Up to a few currently-idle agent ids suggested as replacements, computed at the moment of orphaning — a snapshot, not live; re-run reconcile for a fresh list. */
  reassignCandidates?: string[];
  /**
   * Incremented every time `block` is written (set OR cleared) — never
   * reset, never derived from `block`'s own content. Exists specifically so
   * a caller that read a block, did other work, and now wants to clear
   * EXACTLY that block instance (`clearBlockIfMatches`) can detect an ABA
   * race: another process replacing the block with a byte-for-byte
   * IDENTICAL `{type, who, question/options/actionLink}` value would be
   * invisible to a content-only comparison, silently erasing that (distinct,
   * newer) block instance as if it were the one originally read
   * (codex-review round-17 Important). Absent on records written before
   * this field existed — treated as `0`.
   */
  blockRev?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInput {
  summary: string;
  kind: LifecycleKind;
  description?: string;
  targetTier?: string;
  acceptanceCriteria?: string;
  owner?: string;
  tags?: string[];
  blockedBy?: string[];
}

export interface ListFilter {
  kind?: LifecycleKind;
  state?: string;
  owner?: string;
  tag?: string;
  blocked?: boolean;
}

export interface GateRegistration {
  /** Opaque name supplied BY the consuming project — this module never inspects or hardcodes it. */
  name: string;
  /**
   * Receives the task record being verified (as of the moment `verify()`
   * started checking it), so a project's gate implementation can act on the
   * specific task — e.g. derive a commit/branch from its fields — instead of
   * relying on external mutable state to figure out which task this call is
   * for. Without the record, one registered gate name shared by concurrent
   * verify() calls on DIFFERENT tasks would have no way to tell them apart
   * (codex-review Important).
   */
  check: (record: TodoRecord) => Promise<{ passed: boolean; note?: string; link?: string }>;
}

export class CycleError extends Error {}

export class TodoStore {
  private jsonl: JsonlStore<Omit<TodoRecord, "_id">>;
  private filePath: string;
  private gates = new Map<string, GateRegistration>();

  private constructor(jsonl: JsonlStore<Omit<TodoRecord, "_id">>, filePath: string) {
    this.jsonl = jsonl;
    this.filePath = filePath;
  }

  static async open(projectRoot: string): Promise<TodoStore> {
    const filePath = path.join(projectRoot, ".agent-yes", "todos.jsonl");
    const jsonl = new JsonlStore<Omit<TodoRecord, "_id">>(filePath);
    await jsonl.load();
    return new TodoStore(jsonl, filePath);
  }

  /**
   * Exclusive, cross-process, whole-store write lock, delegated ENTIRELY to
   * `proper-lockfile` (already a dependency here — `JsonlStore` itself uses
   * it for `append`/`updateById`) rather than hand-rolled.
   *
   * EVERY mutating method (`create`, `transition`/`applyTransition`,
   * `approve`, `setBlock`, `addDep`, `rmDep`) runs its "reload from disk,
   * recompute from the FRESH record, write" sequence entirely inside this
   * lock. Two motivating races, both real and both found by review:
   *
   *   - `_id` allocation ("max existing + 1") must happen atomically with
   *     the append that claims it — computing the id from a snapshot and
   *     appending afterward, even with JsonlStore's own internal per-write
   *     lock, leaves a window where two processes compute the SAME next id
   *     from the same snapshot and then both append it; JsonlStore's "same
   *     `_id` → last line wins" merge would silently make one of those two
   *     tasks disappear.
   *   - Every other mutator reads a record's array fields (`verifyEvidence`,
   *     `satisfiedGates`, `blockedBy`) to build a new array and writes that
   *     whole array back. Without a lock, two concurrent mutations on the
   *     SAME task (e.g. two `approve()` calls, or an `approve()` racing a
   *     `verify()`) each compute their patch from a snapshot taken before
   *     either write lands; whichever write reaches JsonlStore SECOND
   *     silently overwrites the first one's array contents (JsonlStore's
   *     merge replaces whole fields, it does not merge array elements) —
   *     losing gate evidence or a satisfied-gate flag with no error at all.
   *
   * This lock is intentionally coarse (the WHOLE store, not per-task): a
   * per-task lock would need its own bookkeeping to avoid deadlock and
   * leaks, for a local, low-throughput CLI tool where store-wide
   * serialization of these fast (disk-only) critical sections has no
   * meaningful cost. The one thing that must NEVER happen inside this lock
   * is an arbitrarily slow external call (`verify()`'s `impl.check()`,
   * which can be a real CI/QA system taking minutes) — that stays outside;
   * only the fast reload-check-write that follows it is lock-protected.
   *
   * Two hand-rolled attempts at a narrower (id-only) version of this lock (a
   * plain mkdir-based lock, then a token-in-file "ownership-safe" variant)
   * each independently rediscovered why advisory file locks are hard to get
   * right from scratch: the second attempt's own stale-lock steal path —
   * read the stale mtime, THEN separately unlink and recreate — has a
   * time-of-check-to-time-of-use gap where a DIFFERENT waiter's fresh
   * acquisition can land in between, so the first waiter's unlink (issued
   * against what it still believes is the stale file) deletes that second
   * waiter's live lock instead. `proper-lockfile` solves exactly this class
   * of problem and is already trusted elsewhere in this same file — reusing
   * it here instead of a third from-scratch attempt is the correct fix.
   */
  private async withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    try {
      // Lock `this.filePath` itself (the todos.jsonl FILE), not its
      // containing directory — JsonlStore's own internal lock (used by
      // append/updateById, invoked from inside `fn()` below) locks the
      // DIRECTORY. proper-lockfile's internal bookkeeping keys by the `file`
      // argument's resolved path, so locking the same directory for two
      // independent purposes from the same process caused a spurious "Lock
      // is not acquired/owned by you" on release; locking a distinct target
      // (the file) avoids that collision entirely. `realpath: false` because
      // this file may not exist yet on a brand-new store (JsonlStore only
      // creates it on the first append) and default realpath resolution
      // would fail on a nonexistent path.
      release = await lock(this.filePath, {
        lockfilePath: `${this.filePath}.writelock`,
        realpath: false,
        stale: 10_000,
        retries: { retries: 200, minTimeout: 15, maxTimeout: 15 },
      });
    } catch (err) {
      throw new Error(
        `store write: timed out waiting for the write lock (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  registerGate(gate: GateRegistration): void {
    this.gates.set(gate.name, gate);
  }

  isRegisteredGate(name: string): boolean {
    return this.gates.has(name);
  }

  /** All currently-registered gate names — used by `todoAutomation.ts` to find tasks eligible for an automatic `verify()` without exposing the internal gate map. */
  registeredGateNames(): string[] {
    return [...this.gates.keys()];
  }

  all(): TodoRecord[] {
    return this.jsonl.getAll() as TodoRecord[];
  }

  get(id: string): TodoRecord | null {
    return (this.jsonl.getById(id) as TodoRecord | undefined) ?? null;
  }

  private mustGet(id: string): TodoRecord {
    const rec = this.get(id);
    if (!rec) throw new Error(`no such task: ${id}`);
    return rec;
  }

  list(filter: ListFilter = {}): TodoRecord[] {
    return this.all().filter((t) => {
      if (filter.kind && t.kind !== filter.kind) return false;
      if (filter.state && t.state !== filter.state) return false;
      if (filter.owner && t.owner?.toLowerCase() !== filter.owner.toLowerCase()) return false;
      if (filter.tag && !t.tags.some((x) => x.toLowerCase() === filter.tag!.toLowerCase()))
        return false;
      if (filter.blocked) {
        // `!= null` (not `!== undefined`): block is explicitly cleared to
        // `null`, not left as `undefined`, so both must read as "no block"
        const isBlocked = t.state !== DONE_STATE && (t.block != null || t.blockedBy.length > 0);
        if (!isBlocked) return false;
      }
      return true;
    });
  }

  async create(input: CreateInput): Promise<TodoRecord> {
    return this.withStoreLock(async () => {
      // Reload from disk WHILE holding the id lock: another process may have
      // appended tasks since this instance last loaded, and the id must be
      // computed from the freshest possible state or two concurrent create()
      // calls could still agree on the same "next" id before either writes.
      await this.jsonl.load();
      const existingIds = this.jsonl
        .getAll()
        .map((d) => Number(String(d._id).replace(/^T/, "")) || 0);
      const id = `T${(existingIds.length ? Math.max(...existingIds) : 0) + 1}`;
      const now = new Date().toISOString();
      for (const dep of input.blockedBy ?? []) {
        if (!this.get(dep)) throw new Error(`no such task: ${dep}`);
      }
      const doc: Omit<TodoRecord, "_id"> = {
        kind: input.kind,
        state: initialState(input.kind),
        summary: input.summary,
        description: input.description ?? "",
        blockedBy: input.blockedBy ?? [],
        tags: input.tags ?? [],
        satisfiedGates: [],
        verifyEvidence: [],
        createdAt: now,
        updatedAt: now,
        ...(input.targetTier ? { targetTier: input.targetTier } : {}),
        // Trimmed, and a whitespace-only value is treated as "not provided"
        // (same reasoning as setAcceptanceCriteria's own guard, codex-review
        // Important) — otherwise a blank-looking criteria string could be
        // stored and later snapshotted into approval evidence.
        ...(input.acceptanceCriteria?.trim()
          ? { acceptanceCriteria: input.acceptanceCriteria.trim() }
          : {}),
        ...(input.owner ? { owner: input.owner } : {}),
      };
      await this.jsonl.append({ ...doc, _id: id });
      return this.mustGet(id);
    });
  }

  /**
   * Move a task across an edge that either has no gate, or whose gate has
   * already been satisfied via `approve()`. Throws — refusing the write
   * entirely — for an edge with no such edge in the graph, or a gate that is
   * either registered (must go through `verify()`) or not yet satisfied.
   *
   * The check below (against `this.mustGet(id)`, a possibly-stale snapshot)
   * is a fast, cheap, EARLY rejection for an obviously-invalid call — it is
   * NOT the source of correctness. `applyTransition`'s `precondition`
   * callback re-runs the SAME check against a record reloaded from disk
   * while holding the write lock, immediately before writing, so a
   * concurrent mutation that changed the state or consumed the gate between
   * this early check and the lock being acquired is still caught.
   */
  async transition(id: string, toState: string): Promise<TodoRecord> {
    const rec = this.mustGet(id);
    if (!canTransition(rec.kind, rec.state, toState)) {
      throw new Error(
        `task ${id}: no transition ${rec.state} -> ${toState} for kind "${rec.kind}"`,
      );
    }
    const gate = requiredGate(rec.kind, rec.state, toState);
    if (gate && this.gates.has(gate)) {
      throw new Error(
        `task ${id}: "${gate}" is a registered gate — it can only be satisfied by verify("${id}"), not a direct transition`,
      );
    }
    // No new evidence entry here: approve() already recorded one (with the
    // independently-verified validator identity) at approval time. This call
    // only consumes the satisfied-gate flag so it cannot be replayed.
    return this.applyTransition(id, toState, undefined, gate, (fresh) => {
      if (!canTransition(fresh.kind, fresh.state, toState)) {
        throw new Error(
          `task ${id}: no transition ${fresh.state} -> ${toState} for kind "${fresh.kind}" (state changed concurrently)`,
        );
      }
      if (gate && !fresh.satisfiedGates.includes(gate)) {
        throw new Error(
          `task ${id}: transition ${fresh.state} -> ${toState} requires gate "${gate}", which is no longer satisfied (consumed or reset by a concurrent write) — call approve("${id}", "${gate}") again`,
        );
      }
    });
  }

  /**
   * Satisfy a manual (non-registered) gate. `validatorIdentity` names who is
   * satisfying it — REQUIRED, and rejected outright when it matches the
   * task's `owner` (case-insensitively): independent verification is the
   * one rule this module enforces unconditionally, so the worker can never
   * certify their own work, no matter who is running the CLI. A task with
   * no `owner` set has nothing to compare against, so approval is allowed
   * (with a required validator identity still recorded for the audit
   * trail) — but this is expected to be rare in practice, since a task
   * normally has an owner before it reaches a gated transition.
   */
  async approve(
    id: string,
    gateName: string,
    validatorIdentity: string,
    evidence?: { note?: string; link?: string },
  ): Promise<TodoRecord> {
    // Trim ONCE, up front, and use this value everywhere below — comparing a
    // trimmed owner against an untrimmed validatorIdentity (or vice versa)
    // would let "worker" vs "worker " sneak past the self-certification
    // check, and would also record untrimmed noise in the audit trail.
    const validator = validatorIdentity.trim();
    if (!validator) {
      throw new Error(
        `task ${id}: approve() requires a validatorIdentity (who is satisfying "${gateName}")`,
      );
    }
    if (this.gates.has(gateName)) {
      throw new Error(
        `task ${id}: "${gateName}" is a registered gate and cannot be approved manually — it is satisfied by verify("${id}")`,
      );
    }
    return this.withStoreLock(async () => {
      // Reload + re-fetch WHILE holding the lock: verifyEvidence/
      // satisfiedGates are arrays rebuilt from the current record and
      // written back whole, so building them from a stale snapshot would
      // silently drop a concurrent write to the SAME arrays (codex-review
      // Important — the same class of race id-allocation had, but for
      // per-task array fields instead of the id sequence).
      await this.jsonl.load();
      const rec = this.mustGet(id);
      const onGraph = LIFECYCLES[rec.kind].transitions.some(
        (t) => t.from === rec.state && t.gate === gateName,
      );
      if (!onGraph) {
        throw new Error(
          `task ${id}: "${gateName}" is not a gate on any transition from its current state "${rec.state}"`,
        );
      }
      if (rec.owner && rec.owner.trim().toLowerCase() === validator.toLowerCase()) {
        throw new Error(
          `task ${id}: independent verification required — validator "${validator}" is the same identity as owner "${rec.owner}"; the worker cannot certify their own work`,
        );
      }
      const satisfied = new Set(rec.satisfiedGates);
      satisfied.add(gateName);
      // Trusted fields (gate/passedAt/validator) are spread LAST so a
      // caller-supplied `evidence` object cannot override them — only
      // `note`/`link` are ever taken from it. Spreading `evidence` last (the
      // previous order) let a caller pass e.g. `{ validator: "...", gate:
      // "..." }` and silently falsify the audit trail (codex-review
      // Important).
      const evidenceEntry: GateEvidence = {
        note: evidence?.note,
        link: evidence?.link,
        gate: gateName,
        passedAt: new Date().toISOString(),
        validator,
        // Snapshot the FRESH record's acceptanceCriteria text, not a
        // reference to the live field — the criteria could be edited after
        // this approval, and the audit trail should durably show what the
        // validator actually judged the work against at the time.
        ...(rec.acceptanceCriteria ? { acceptanceCriteriaAtApproval: rec.acceptanceCriteria } : {}),
      };
      await this.jsonl.updateById(id, {
        satisfiedGates: [...satisfied],
        verifyEvidence: [...rec.verifyEvidence, evidenceEntry],
        updatedAt: evidenceEntry.passedAt,
      } as Partial<Omit<TodoRecord, "_id">>);
      return this.mustGet(id);
    });
  }

  /**
   * Run a registered gate's check function and, based on its result, apply
   * whichever transition out of the task's current state that gate governs.
   *
   * The PRIMARY edge from a state is, by this graph's declaration-order
   * convention (see `todoLifecycle.ts` — e.g. `code`'s `verifying` state
   * lists `verify-green` before `verify-red`), the first gated edge. Only a
   * check registered against the primary edge may fall back to a sibling
   * edge on a not-passed result (e.g. `verifying -> verify-failed` alongside
   * `verifying -> done`) — this is how a single automated check naturally
   * produces the kind's real pass/fail states without hardcoding
   * kind-specific gate names here.
   *
   * A check registered against a NON-primary edge (e.g. a project that
   * registers "verify-red" instead of "verify-green") must itself report
   * `passed: true` to take its own edge; if it reports not-passed, this
   * throws rather than falling back to the sibling. A secondary/failure-
   * oriented gate reporting "not passed" only means "the specific bad thing
   * this check looks for did not happen" — that is a strictly weaker claim
   * than "verified good," and silently treating it as license to reach a
   * possibly `done`-bound sibling would be exactly the kind of unverified
   * done state this whole module exists to prevent.
   */
  async verify(id: string, gateName?: string): Promise<TodoRecord> {
    const rec = this.mustGet(id);
    const edges = LIFECYCLES[rec.kind].transitions.filter((t) => t.from === rec.state && t.gate);
    if (edges.length === 0)
      throw new Error(`task ${id}: no gated transition from state "${rec.state}"`);
    const targetEdge = gateName
      ? edges.find((e) => e.gate === gateName)
      : edges.find((e) => this.gates.has(e.gate!));
    if (!targetEdge || !targetEdge.gate) {
      throw new Error(
        `task ${id}: no registered gate found for a transition from "${rec.state}"${gateName ? ` matching "${gateName}"` : ""}`,
      );
    }
    const impl = this.gates.get(targetEdge.gate);
    if (!impl)
      throw new Error(
        `task ${id}: gate "${targetEdge.gate}" is not registered — call registerGate() first`,
      );
    const isPrimaryEdge = edges[0] === targetEdge;
    const stateAtCheckStart = rec.state;
    const result = await impl.check(rec); // may be slow (a real CI/QA system) — the task's state can change while this runs
    // `impl.check()` can take an arbitrarily long time (a real external
    // system), and another writer (a concurrent transition/verify/approve)
    // can change the task's state during that window. The precondition
    // passed to `applyTransition` below re-checks this AFTER the await,
    // atomically with the write, inside the store's write lock — not here,
    // and not as a separate unlocked re-fetch (codex-review Critical, then
    // strengthened again after review found the first fix's re-check was
    // itself outside any lock and so could race a concurrent WRITE, not
    // just be stale relative to one).
    const precondition = (fresh: TodoRecord): void => {
      if (fresh.state !== stateAtCheckStart) {
        throw new Error(
          `task ${id}: state changed from "${stateAtCheckStart}" to "${fresh.state}" while gate "${targetEdge.gate}" was being checked — refusing to apply a transition computed against the old state; re-run verify()`,
        );
      }
    };
    if (result.passed) {
      // The gate's own name stands in for "validator" — a registered check is,
      // by construction, an independent system distinct from the worker, so
      // no separate identity argument is needed here (unlike approve()).
      return this.applyTransition(
        id,
        targetEdge.to,
        {
          gate: targetEdge.gate,
          validator: `gate:${targetEdge.gate}`,
          note: result.note,
          link: result.link,
        },
        undefined,
        precondition,
      );
    }
    if (!isPrimaryEdge) {
      throw new Error(
        `task ${id}: gate "${targetEdge.gate}" (a non-primary gate on this state) reported not passed — this alone is not evidence of success, so no transition was applied. Register and satisfy the primary gate for this state instead.`,
      );
    }
    const sibling = edges.find((e) => e !== targetEdge);
    if (!sibling) {
      throw new Error(
        `task ${id}: gate "${targetEdge.gate}" reported not passed and there is no alternate transition to record it against`,
      );
    }
    // Record the SIBLING's own gate name as evidence (falling back to
    // targetEdge's name only if the sibling declares none) — `verifyEvidence`
    // entries are meant to be read as "this gate passed"; attributing this
    // entry to targetEdge.gate (which reported NOT passed) would let a
    // downstream reader scanning evidence by gate name misread a failed
    // check as successful evidence for that gate (codex-review Important).
    return this.applyTransition(
      id,
      sibling.to,
      {
        // non-null: `edges` was filtered to only entries with a truthy `gate`
        gate: sibling.gate!,
        validator: `gate:${targetEdge.gate}`,
        note: result.note ?? `gate "${targetEdge.gate}" reported not passed`,
        link: result.link,
      },
      undefined,
      precondition,
    );
  }

  /**
   * Apply a state write, entirely inside the store write lock: reload from
   * disk, re-fetch the record, run the caller's `precondition` (if any)
   * against that FRESH record (throws to abort with no write), then build
   * the patch from the fresh record's arrays and write it. Building the
   * patch from a pre-lock snapshot (the previous design) let a concurrent
   * mutation on the same task silently lose its own array write once this
   * one landed — this method exists specifically so every caller (`verify`,
   * `transition`) gets that protection uniformly rather than each
   * reimplementing its own reload dance (codex-review Important).
   */
  private async applyTransition(
    id: string,
    toState: string,
    gateInfo?: { gate: string; validator: string; note?: string; link?: string },
    consumeGate?: string | null,
    precondition?: (fresh: TodoRecord) => void,
  ): Promise<TodoRecord> {
    return this.withStoreLock(async () => {
      await this.jsonl.load();
      const fresh = this.mustGet(id);
      precondition?.(fresh);
      const now = new Date().toISOString();
      const patch: Partial<Omit<TodoRecord, "_id">> = { state: toState, updatedAt: now };
      if (gateInfo) {
        const evidenceEntry: GateEvidence = {
          gate: gateInfo.gate,
          passedAt: now,
          validator: gateInfo.validator,
          note: gateInfo.note,
          link: gateInfo.link,
        };
        patch.verifyEvidence = [...fresh.verifyEvidence, evidenceEntry];
      }
      if (consumeGate) {
        patch.satisfiedGates = fresh.satisfiedGates.filter((g) => g !== consumeGate);
      }
      await this.jsonl.updateById(id, patch);
      return this.mustGet(id);
    });
  }

  /**
   * Set or update a task's acceptance criteria (free text) after creation —
   * criteria may firm up once a task is underway, not just at `create()`
   * time. Requires non-empty text: this method updates criteria, it does
   * not clear them (clearing would need a `null`-vs-`undefined` sentinel
   * distinction, like `block` has, which isn't needed for the "set/update"
   * use case this exists for).
   */
  async setAcceptanceCriteria(id: string, text: string): Promise<TodoRecord> {
    // `async` (not a plain function returning rawUpdate's promise) so this
    // guard's throw becomes a rejected promise like every other validating
    // mutator here, rather than throwing synchronously before any promise
    // exists — matching `addDep`'s same convention.
    //
    // Trim BEFORE checking and store the trimmed value: a whitespace-only
    // string (e.g. `ay todo set-criteria T1 "   "`) is truthy and would
    // otherwise pass an `if (!text)` check, get stored, and later be
    // snapshotted into approval evidence as if it were a real definition of
    // done — violating this method's own "must not be empty" contract
    // (codex-review Important).
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`task ${id}: acceptance criteria text must not be empty`);
    return this.rawUpdate(id, () => ({ acceptanceCriteria: trimmed }));
  }

  setBlock(id: string, block: TodoBlock | null): Promise<TodoRecord> {
    // `null`, never `undefined`: JSON.stringify drops `undefined` keys
    // entirely, so an update line with an omitted `block` would fail to
    // clear a previously-set value once merged on reload (see the field
    // doc comment on TodoRecord.block). `block` is a scalar-ish field (not
    // built from the record's own prior array contents), so this needs no
    // reload-and-recompute-from-fresh dance the way `blockedBy` does below —
    // it still goes through the write lock via `rawUpdate` for existence
    // validation to run against a fresh record.
    //
    // `blockRev` bumps on every write regardless of whether `block` actually
    // changed value — see the field's doc comment for why identity, not
    // content, is what `clearBlockIfMatches` needs.
    return this.rawUpdate(id, (fresh) => ({ block, blockRev: (fresh.blockRev ?? 0) + 1 }));
  }

  /**
   * Clears a `waiting-on-agent` block ONLY if the FRESH record's block is
   * still that exact type and `agentId` — used by automation
   * (`todoAutomation.ts`'s `reconcile`), which decides from a snapshot that
   * can be stale by the time this runs. Clearing unconditionally by `id`
   * alone could erase a genuinely different, newer block (e.g. a manual
   * `blocked-by-human` set after the decision was made) that happened to
   * land in between (codex-review Important). Throws instead of silently
   * no-op-ing so the caller can report the skip rather than claim success.
   */
  clearWaitingOnAgentBlock(id: string, expectedAgentId: string): Promise<TodoRecord> {
    return this.rawUpdate(id, (fresh) => {
      if (fresh.block?.type !== "waiting-on-agent" || fresh.block.agentId !== expectedAgentId) {
        throw new Error(
          `task ${id}: block changed since this was decided (expected waiting-on-agent for "${expectedAgentId}") — not clearing`,
        );
      }
      return { block: null, blockRev: (fresh.blockRev ?? 0) + 1 };
    });
  }

  /**
   * Clears `block` ONLY if the FRESH record's `blockRev` still equals
   * `expectedBlockRev` — the generalized form of `clearWaitingOnAgentBlock`
   * above, for a caller (e.g. `askApi.ts`'s `answerAsk`) that decided to
   * clear a specific `blocked-by-human` block instance from a snapshot
   * taken at the start of a longer operation.
   *
   * Compares `blockRev`, NOT the block's own content: an earlier version of
   * this method compared `JSON.stringify(fresh.block)` against the snapshot,
   * which missed an ABA race — another process could replace the block with
   * a byte-for-byte IDENTICAL `{type, who, question/options/actionLink}`
   * value (e.g. the exact same question asked again) between the caller's
   * read and this call, and the content-only check would see no difference,
   * silently erasing that distinct, newer block instance as if it were the
   * one the caller actually decided to answer (codex-review round-17
   * Important). `blockRev` increments on every write to `block` regardless
   * of whether the new value differs from the old one, so it uniquely
   * identifies THIS PARTICULAR block-setting event, not just its shape.
   *
   * Clearing unconditionally by `id` alone (or by content alone) could
   * silently erase a genuinely different, newer block that another process
   * set in the meantime — the task would then look unblocked even though a
   * real, later block exists (codex-review Important). Throws instead of
   * silently no-op-ing so the caller can report the conflict rather than
   * claim success.
   */
  clearBlockIfMatches(id: string, expectedBlockRev: number): Promise<TodoRecord> {
    return this.rawUpdate(id, (fresh) => {
      if ((fresh.blockRev ?? 0) !== expectedBlockRev) {
        throw new Error(`task ${id}: block changed since this was decided — not clearing`);
      }
      return { block: null, blockRev: (fresh.blockRev ?? 0) + 1 };
    });
  }

  /**
   * Atomically clears a `blocked-by-human` block AND, if `gate` is given,
   * appends its evidence and advances the transition it names — all inside
   * ONE `rawUpdate` write (one lock acquisition, one reload, one write).
   *
   * This exists specifically so `askApi.ts`'s `answerAsk()` never composes
   * "verify blockRev, approve() a gate, transition(), clearBlockIfMatches()"
   * as separate locked writes again. That composition (this method's
   * predecessor) had a real gap: `approve()`/`transition()` could durably
   * succeed — evidence appended, state advanced — and ONLY THEN could the
   * final `clearBlockIfMatches()` fail because another process replaced the
   * block in between. The task was left in a state no caller intended:
   * already transitioned/evidenced for the OLD block, while `block` still
   * held a DIFFERENT, newer `blocked-by-human` ask that was never gated at
   * all (codex-review round-18 Important — the exact race this module's
   * whole `blockRev` mechanism exists to close, just one step further out
   * than `clearBlockIfMatches` alone could reach). Folding everything into
   * one `rawUpdate` cycle makes the two outcomes (nothing changed / gate +
   * transition + clear all changed together) the only two possible ones —
   * there is no window in which one succeeded and the other didn't.
   *
   * `blockRev` re-validates `canTransition` against the FRESH state (not a
   * value captured before this call), matching `transition()`'s own
   * concurrent-state-drift defense — a state change unrelated to `block`
   * (and so invisible to the `blockRev` check alone) must still be caught.
   *
   * Independent verification (this module's single most important
   * invariant — see the file's own header comment) is re-checked here
   * against the FRESH owner, exactly as `approve()` checks it: `gate`, when
   * given, is never applied if its `validator` is the task's own owner.
   * This method does not call `approve()` (it is not a separate write), so
   * skipping this check here would silently let a human answer their own
   * gated ask with no independent-verification enforcement at all.
   */
  answerHumanBlock(
    id: string,
    expectedBlockRev: number,
    gate: { name: string; toState: string; validator: string; note: string } | null,
  ): Promise<TodoRecord> {
    return this.rawUpdate(id, (fresh) => {
      if ((fresh.blockRev ?? 0) !== expectedBlockRev) {
        throw new Error(
          `task ${id}: this ask has changed since it was loaded (expected blockRev ${expectedBlockRev}, current ${fresh.blockRev ?? 0}) — refresh and try again`,
        );
      }
      const patch: Partial<Omit<TodoRecord, "_id">> = {
        block: null,
        blockRev: (fresh.blockRev ?? 0) + 1,
      };
      if (gate) {
        if (
          fresh.owner &&
          fresh.owner.trim().toLowerCase() === gate.validator.trim().toLowerCase()
        ) {
          throw new Error(
            `task ${id}: independent verification required — validator "${gate.validator}" is the same identity as owner "${fresh.owner}"; the worker cannot certify their own work`,
          );
        }
        if (!canTransition(fresh.kind, fresh.state, gate.toState)) {
          throw new Error(
            `task ${id}: no transition ${fresh.state} -> ${gate.toState} for kind "${fresh.kind}" (state changed concurrently) — not clearing`,
          );
        }
        const evidenceEntry: GateEvidence = {
          gate: gate.name,
          passedAt: new Date().toISOString(),
          validator: gate.validator,
          note: gate.note,
        };
        patch.verifyEvidence = [...fresh.verifyEvidence, evidenceEntry];
        patch.state = gate.toState;
      }
      return patch;
    });
  }

  /**
   * Side-channel transition to `orphaned` (see `ORPHANED_STATE`'s doc comment
   * in `todoLifecycle.ts`) — deliberately NOT gated through `canTransition`,
   * since no kind's graph declares an edge into it: this is automation
   * (`todoAutomation.ts`) observing that the task's owner process is gone,
   * not a statement about the work reaching some declared state. Refuses to
   * orphan a task that is already `done` or already `orphaned` (finished
   * work, or already-recorded, should never be re-flagged), OR whose FRESH
   * owner no longer matches `expectedOwner` — the decision was made from a
   * snapshot, and another process may have reassigned the task to a still-
   * live owner in the meantime; orphaning it anyway would be acting on stale
   * information (codex-review Important).
   */
  markOrphaned(
    id: string,
    expectedOwner: string,
    reassignCandidates: string[],
  ): Promise<TodoRecord> {
    return this.rawUpdate(id, (fresh) => {
      if (fresh.state === DONE_STATE || fresh.state === ORPHANED_STATE) {
        throw new Error(`task ${id}: cannot mark orphaned — already "${fresh.state}"`);
      }
      if (fresh.owner !== expectedOwner) {
        throw new Error(
          `task ${id}: owner changed since this was decided (expected "${expectedOwner}", now "${fresh.owner ?? "(none)"}") — not orphaning`,
        );
      }
      return { orphanedFrom: fresh.state, reassignCandidates, state: ORPHANED_STATE };
    });
  }

  async addDep(id: string, blockerId: string): Promise<TodoRecord> {
    if (blockerId === id) throw new Error(`task ${id} cannot depend on itself`);
    // Cheap early check outside the lock (missing-target is a fast, obvious
    // rejection); `rawUpdate`'s `computePatch` re-validates the cycle check
    // against the FRESH record below, since `blockedBy` is exactly the kind
    // of array field a concurrent `addDep`/`rmDep` on the same task could
    // race on otherwise (codex-review Important).
    if (!this.get(blockerId)) throw new Error(`no such task: ${blockerId}`);
    return this.rawUpdate(id, (fresh) => {
      if (this.dependsOn(blockerId, id)) {
        throw new CycleError(`cycle: ${blockerId} already depends (transitively) on ${id}`);
      }
      const deps = new Set(fresh.blockedBy);
      deps.add(blockerId);
      return { blockedBy: [...deps].sort() };
    });
  }

  async rmDep(id: string, blockerId: string): Promise<TodoRecord> {
    return this.rawUpdate(id, (fresh) => ({
      blockedBy: fresh.blockedBy.filter((d) => d !== blockerId),
    }));
  }

  /** True when `from` transitively depends on `target` via `blockedBy` edges. Ported from the equivalent, already-tested algorithm in symval-dev-cli's store.ts. */
  private dependsOn(from: string, target: string, seen: Set<string> = new Set()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const node = this.get(from);
    return (node?.blockedBy ?? []).some((d) => this.dependsOn(d, target, seen));
  }

  /**
   * Reload, re-fetch, run `computePatch` against the FRESH record (inside
   * the write lock), then write whatever it returns. Every array-field
   * mutator (`setBlock`/`addDep`/`rmDep`) goes through this so none of them
   * has to hand-roll its own reload discipline.
   */
  private async rawUpdate(
    id: string,
    computePatch: (fresh: TodoRecord) => Partial<Omit<TodoRecord, "_id">>,
  ): Promise<TodoRecord> {
    return this.withStoreLock(async () => {
      await this.jsonl.load();
      const fresh = this.mustGet(id);
      const patch = computePatch(fresh);
      await this.jsonl.updateById(id, { ...patch, updatedAt: new Date().toISOString() });
      return this.mustGet(id);
    });
  }
}

export async function openStore(projectRoot: string): Promise<TodoStore> {
  return TodoStore.open(projectRoot);
}
