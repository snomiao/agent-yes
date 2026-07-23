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
  block?: TodoBlock;
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

export class TodoStore {
  private jsonl: JsonlStore<Omit<TodoRecord, "_id">>;
  private gates = new Map<string, GateRegistration>();
  private nextSeq = 1;

  private constructor(jsonl: JsonlStore<Omit<TodoRecord, "_id">>) {
    this.jsonl = jsonl;
  }

  static async open(projectRoot: string): Promise<TodoStore> {
    const filePath = path.join(projectRoot, ".agent-yes", "todos.jsonl");
    const jsonl = new JsonlStore<Omit<TodoRecord, "_id">>(filePath);
    await jsonl.load();
    const store = new TodoStore(jsonl);
    const existingIds = jsonl.getAll().map((d) => Number(String(d._id).replace(/^T/, "")) || 0);
    store.nextSeq = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    return store;
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
        const isBlocked =
          t.state !== DONE_STATE && (t.block !== undefined || t.blockedBy.length > 0);
        if (!isBlocked) return false;
      }
      return true;
    });
  }

  async create(input: CreateInput): Promise<TodoRecord> {
    const id = `T${this.nextSeq++}`;
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
    if (!validatorIdentity.trim()) {
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
    if (rec.owner && rec.owner.toLowerCase() === validatorIdentity.toLowerCase()) {
      throw new Error(
        `task ${id}: independent verification required — validator "${validatorIdentity}" is the same identity as owner "${rec.owner}"; the worker cannot certify their own work`,
      );
    }
    const satisfied = new Set(rec.satisfiedGates);
    satisfied.add(gateName);
    const evidenceEntry: GateEvidence = {
      gate: gateName,
      passedAt: new Date().toISOString(),
      validator: validatorIdentity,
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
   * If the check reports NOT passed, and there is a sibling transition from
   * the same state (e.g. the `code` kind's `verifying -> verify-failed`
   * alongside `verifying -> done`), that sibling is taken instead — this is
   * how a single automated check naturally produces the kind's real
   * pass/fail states without hardcoding kind-specific names here.
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
    return this.rawUpdate(id, { block: block ?? undefined });
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
