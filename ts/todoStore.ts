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

import { readFileSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { JsonlStore, type JsonlDoc } from "./JsonlStore.ts";
import {
  DONE_STATE,
  LIFECYCLES,
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
}

export interface TodoRecord extends JsonlDoc {
  kind: LifecycleKind;
  state: string;
  /** Which done-tier this task targets, e.g. a project may define "canary-done" vs "shipped-done". Optional: not every project uses tiers. */
  targetTier?: string;
  summary: string;
  description: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface CreateInput {
  summary: string;
  kind: LifecycleKind;
  description?: string;
  targetTier?: string;
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
  check: () => Promise<{ passed: boolean; note?: string; link?: string }>;
}

export class CycleError extends Error {}

/**
 * Ownership-safe file lock, extracted as standalone functions (rather than
 * inlined where they're used) so the release-only-if-still-owned invariant
 * is directly unit-testable without going through a full `create()` call —
 * the same reason this repo's `notifyStore.ts` extracts `shouldStealLock`.
 * See `TodoStore.withIdLock`'s doc comment for why this exists at all.
 */
export async function acquireIdLock(
  lockPath: string,
  opts: { staleMs: number; maxAttempts?: number },
): Promise<string | null> {
  const token = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  for (let attempt = 0; attempt < (opts.maxAttempts ?? 200); attempt++) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > opts.staleMs) {
          rmSync(lockPath, { force: true }); // stale — steal and retry
          continue;
        }
      } catch {
        continue; // lock vanished between attempts — retry immediately
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  return null;
}

/** Release ONLY while `lockPath` still contains `token` — never delete a lock some other holder has since acquired. */
export function releaseIdLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath, { force: true });
  } catch {
    // already gone — nothing to release
  }
}

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
   * Exclusive, cross-process, OWNERSHIP-SAFE id-allocation lock. This exists
   * because `_id` allocation ("max existing + 1") must happen atomically with
   * the append that claims it — computing the id from a snapshot and
   * appending afterward, even with `JsonlStore`'s own internal per-write
   * lock, leaves a window where two processes compute the SAME next id from
   * the same snapshot and then both append it; JsonlStore's "same `_id` →
   * last line wins" merge would silently make one of those two tasks
   * disappear (its create() line is superseded by the other's). This lock is
   * a SEPARATE file from JsonlStore's own internal `<path>.lock` (used by
   * `append`/`updateById`) — it only ever needs to be held around id
   * selection, not every write, and deliberately does not touch JsonlStore's
   * internals.
   *
   * Ownership-safe: the lock file's content is a random token unique to this
   * acquisition. A lock older than `staleMs` is stolen (so a crashed holder
   * cannot wedge every future create() call), but release ALWAYS re-checks
   * that the file still contains OUR token before removing it. Without this
   * check, a holder that merely ran slow (contention, not a crash) for
   * longer than `staleMs` would have its still-live lock stolen by another
   * process, and then — on finally reaching its own release — delete that
   * NEW holder's lock, breaking exclusivity for a third caller. (This is the
   * exact class of bug already fixed once in this lock's first draft, and
   * independently in a downstream closed-source consumer's own lockfile.)
   */
  private async withIdLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.idlock`;
    const token = await acquireIdLock(lockPath, { staleMs: 10_000 });
    // Falling through without ever acquiring the lock must NOT silently
    // proceed unlocked: with the default ~3s worst-case wait against a 10s
    // staleMs, a legitimately long-held lock would otherwise let this caller
    // both run the critical section AND (without the ownership check in
    // releaseIdLock) delete the other holder's still-live lock.
    if (token === null) {
      throw new Error(
        `task id allocation: timed out waiting for ${lockPath} (held by another process for over ~3s)`,
      );
    }
    try {
      return await fn();
    } finally {
      releaseIdLock(lockPath, token);
    }
  }

  registerGate(gate: GateRegistration): void {
    this.gates.set(gate.name, gate);
  }

  isRegisteredGate(name: string): boolean {
    return this.gates.has(name);
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
    return this.withIdLock(async () => {
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
   */
  async transition(id: string, toState: string): Promise<TodoRecord> {
    const rec = this.mustGet(id);
    if (!canTransition(rec.kind, rec.state, toState)) {
      throw new Error(
        `task ${id}: no transition ${rec.state} -> ${toState} for kind "${rec.kind}"`,
      );
    }
    const gate = requiredGate(rec.kind, rec.state, toState);
    if (gate) {
      if (this.gates.has(gate)) {
        throw new Error(
          `task ${id}: "${gate}" is a registered gate — it can only be satisfied by verify("${id}"), not a direct transition`,
        );
      }
      if (!rec.satisfiedGates.includes(gate)) {
        throw new Error(
          `task ${id}: transition ${rec.state} -> ${toState} requires gate "${gate}" — call approve("${id}", "${gate}") first`,
        );
      }
    }
    // No new evidence entry here: approve() already recorded one (with the
    // independently-verified validator identity) at approval time. This call
    // only consumes the satisfied-gate flag so it cannot be replayed.
    return this.applyTransition(id, toState, undefined, gate);
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
    const rec = this.mustGet(id);
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
    const evidenceEntry: GateEvidence = {
      gate: gateName,
      passedAt: new Date().toISOString(),
      validator,
      ...evidence,
    };
    await this.jsonl.updateById(id, {
      satisfiedGates: [...satisfied],
      verifyEvidence: [...rec.verifyEvidence, evidenceEntry],
      updatedAt: evidenceEntry.passedAt,
    } as Partial<Omit<TodoRecord, "_id">>);
    return this.mustGet(id);
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
    const result = await impl.check();
    if (result.passed) {
      // The gate's own name stands in for "validator" — a registered check is,
      // by construction, an independent system distinct from the worker, so
      // no separate identity argument is needed here (unlike approve()).
      return this.applyTransition(id, targetEdge.to, {
        gate: targetEdge.gate,
        validator: `gate:${targetEdge.gate}`,
        note: result.note,
        link: result.link,
      });
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
    return this.applyTransition(id, sibling.to, {
      gate: targetEdge.gate,
      validator: `gate:${targetEdge.gate}`,
      note: result.note ?? "gate reported not passed",
      link: result.link,
    });
  }

  private async applyTransition(
    id: string,
    toState: string,
    gateInfo?: { gate: string; validator: string; note?: string; link?: string },
    consumeGate?: string | null,
  ): Promise<TodoRecord> {
    const rec = this.mustGet(id);
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
      patch.verifyEvidence = [...rec.verifyEvidence, evidenceEntry];
    }
    if (consumeGate) {
      patch.satisfiedGates = rec.satisfiedGates.filter((g) => g !== consumeGate);
    }
    await this.jsonl.updateById(id, patch);
    return this.mustGet(id);
  }

  setBlock(id: string, block: TodoBlock | null): Promise<TodoRecord> {
    // `null`, never `undefined`: JSON.stringify drops `undefined` keys
    // entirely, so an update line with an omitted `block` would fail to
    // clear a previously-set value once merged on reload (see the field
    // doc comment on TodoRecord.block).
    return this.rawUpdate(id, { block });
  }

  async addDep(id: string, blockerId: string): Promise<TodoRecord> {
    const rec = this.mustGet(id);
    if (blockerId === id) throw new Error(`task ${id} cannot depend on itself`);
    if (!this.get(blockerId)) throw new Error(`no such task: ${blockerId}`);
    if (this.dependsOn(blockerId, id)) {
      throw new CycleError(`cycle: ${blockerId} already depends (transitively) on ${id}`);
    }
    const deps = new Set(rec.blockedBy);
    deps.add(blockerId);
    return this.rawUpdate(id, { blockedBy: [...deps].sort() });
  }

  async rmDep(id: string, blockerId: string): Promise<TodoRecord> {
    const rec = this.mustGet(id);
    return this.rawUpdate(id, { blockedBy: rec.blockedBy.filter((d) => d !== blockerId) });
  }

  /** True when `from` transitively depends on `target` via `blockedBy` edges. Ported from the equivalent, already-tested algorithm in symval-dev-cli's store.ts. */
  private dependsOn(from: string, target: string, seen: Set<string> = new Set()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const node = this.get(from);
    return (node?.blockedBy ?? []).some((d) => this.dependsOn(d, target, seen));
  }

  private async rawUpdate(
    id: string,
    patch: Partial<Omit<TodoRecord, "_id">>,
  ): Promise<TodoRecord> {
    this.mustGet(id);
    await this.jsonl.updateById(id, { ...patch, updatedAt: new Date().toISOString() });
    return this.mustGet(id);
  }
}

export async function openStore(projectRoot: string): Promise<TodoStore> {
  return TodoStore.open(projectRoot);
}
