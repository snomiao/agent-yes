// The channel CRDT — pure, isomorphic (Node + browser), storage-agnostic.
//
// A channel is a grow-only set of immutable ops (op.ts) keyed by `id`. Because
// ids are content-independent-but-unique and the set only grows, MERGE is a
// union and always converges: any two replicas that have exchanged the same ops
// hold the same set regardless of arrival order (commutative, associative,
// idempotent). Display order is the total order over `hlc`.
//
// Amendments (edit/delete/reaction) are folded per target message as
// last-writer-wins by HLC, so the rendered thread is likewise a pure function of
// the op set — every replica renders identically.
//
// This module never touches disk or network; backends (store.node.ts,
// store.browser.ts) provide the ops, and peer.ts moves them between replicas.

import { compareHlc, parseHlc } from "./hlc.ts";
import type { Op, Role } from "./op.ts";

/** Order ops by HLC (then id, for a fully deterministic tie-break). */
export function sortOps(ops: Op[]): Op[] {
  return [...ops].sort(
    (a, b) => compareHlc(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Union `incoming` into `existing`, deduping by id. Returns the merged set
 * (sorted) and the ops that were actually new — the backend appends `added`, and
 * peer.ts rebroadcasts them. Idempotent: merging the same ops twice adds nothing.
 */
export function mergeOps(existing: Op[], incoming: Op[]): { merged: Op[]; added: Op[] } {
  const byId = new Map<string, Op>();
  for (const op of existing) byId.set(op.id, op);
  const added: Op[] = [];
  for (const op of incoming) {
    if (byId.has(op.id)) continue;
    byId.set(op.id, op);
    added.push(op);
  }
  return { merged: sortOps([...byId.values()]), added };
}

/** The greatest HLC in the set (used to seed the next local send), or null if empty. */
export function maxHlc(ops: Op[]): string | null {
  let max: string | null = null;
  for (const op of ops) if (max === null || compareHlc(op.hlc, max) > 0) max = op.hlc;
  return max;
}

// --- rendered thread --------------------------------------------------------

export interface Reaction {
  /** The emoji/label. */
  emoji: string;
  /** Distinct author ids that reacted with it. */
  by: string[];
}

/** A message as shown in the UI: a base `msg` op with amendments folded in. */
export interface Message {
  id: string;
  author: string;
  name: string;
  role: Role;
  /** Base op HLC — the thread sort key. */
  hlc: string;
  /** Current text (after the latest edit); empty when deleted. */
  text: string;
  /** True if a delete op is the latest amendment. */
  deleted: boolean;
  /** HLC of the latest edit/delete applied, if any. */
  amendedHlc?: string;
  reactions: Reaction[];
  ms: number;
}

/**
 * Fold an op set into the ordered list of messages. Pure function of the ops:
 * for each `msg` op, its `edit`/`delete` amendments are applied in HLC order
 * (last wins — an edit after a delete revives it, a delete after an edit hides
 * it), and `reaction` ops are grouped by emoji into distinct authors.
 */
export function renderThread(ops: Op[]): Message[] {
  const sorted = sortOps(ops);
  const messages = new Map<string, Message>();

  for (const op of sorted) {
    if (op.kind !== "msg") continue;
    messages.set(op.id, {
      id: op.id,
      author: op.author,
      name: op.name,
      role: op.role,
      hlc: op.hlc,
      text: op.body ?? "",
      deleted: false,
      reactions: [],
      ms: parseHlc(op.hlc).ms,
    });
  }

  // reactions grouped as emoji -> ordered distinct authors, per target message
  const reactions = new Map<string, Map<string, string[]>>();

  for (const op of sorted) {
    if (!op.ref) continue;
    const target = messages.get(op.ref);
    if (!target) continue; // amendment for an op we don't (yet) have — ignore
    if (op.kind === "edit") {
      // amendments always sort after the base (author is causal); LWW by HLC
      if (compareHlc(op.hlc, target.amendedHlc ?? target.hlc) > 0) {
        target.text = op.body ?? "";
        target.deleted = false;
        target.amendedHlc = op.hlc;
      }
    } else if (op.kind === "delete") {
      if (compareHlc(op.hlc, target.amendedHlc ?? target.hlc) > 0) {
        target.text = "";
        target.deleted = true;
        target.amendedHlc = op.hlc;
      }
    } else if (op.kind === "reaction" && op.body) {
      let group = reactions.get(op.ref);
      if (!group) reactions.set(op.ref, (group = new Map()));
      const authors = group.get(op.body) ?? [];
      if (!authors.includes(op.author)) authors.push(op.author);
      group.set(op.body, authors);
    }
  }

  for (const [msgId, group] of reactions) {
    const target = messages.get(msgId);
    if (!target) continue;
    target.reactions = [...group.entries()].map(([emoji, by]) => ({ emoji, by }));
  }

  return [...messages.values()].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

// --- anti-entropy sync ------------------------------------------------------
//
// On each new peer connection the two sides exchange a compact per-author
// summary of what they hold, then each sends the ops the other lacks. This is
// why an intermittent / partial mesh still converges: a peer that was offline
// receives the suffix it missed on reconnect.

/** Per-author greatest HLC held — the compact "have" summary sent to a peer. */
export function haveVector(ops: Op[]): Record<string, string> {
  const have: Record<string, string> = {};
  for (const op of ops) {
    const cur = have[op.author];
    if (cur === undefined || compareHlc(op.hlc, cur) > 0) have[op.author] = op.hlc;
  }
  return have;
}

/**
 * The ops in `local` that a peer with summary `remoteHave` is missing: any op
 * from an author the peer hasn't heard from, or newer than the peer's max for
 * that author. Relies on an author's ops forming a contiguous HLC suffix on each
 * replica (sync always transfers whole suffixes), which holds under this protocol.
 */
export function opsMissing(local: Op[], remoteHave: Record<string, string>): Op[] {
  return sortOps(
    local.filter((op) => {
      const peerMax = remoteHave[op.author];
      return peerMax === undefined || compareHlc(op.hlc, peerMax) > 0;
    }),
  );
}
