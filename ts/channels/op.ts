// The immutable op — the single record type replicated through a channel.
//
// Every message, edit, delete, reaction, and presence beat is one Op, appended
// to every replica's log and merged as a grow-only set (store.ts). Ops are
// content-independent of transport: the same shape lands in the CLI's jsonl and
// the browser's LocalStorage, and travels verbatim inside the E2E sealed frame.
//
// Identity: `id = "<author>@<hlc>"`. An author's HLCs are strictly monotonic and
// never reused, so (author, hlc) is globally unique WITHOUT a content hash — a
// retransmit of the same op yields the same id and dedups for free. (Phase 3
// ed25519 `sig` will bind the body to this id so a peer can't forge a different
// body under an author's id; until then, channel-secret possession = trust.)
//
// Dependency-free and isomorphic (Node + browser).

// Chat/history kinds are persisted + CRDT-synced; the control kinds (presence,
// cmd, stream) are ephemeral live signals — see trust.ts `isEphemeral`. `cmd`
// carries an application-defined structured action (JSON in `body`); `stream`
// carries a delta of a running cmd. Both are only ever ACTED ON when authored by
// an agent and allowlisted by the consuming app (trust.ts `isActionableCmd`) — a
// public channel's guest must never act on another peer's behalf.
export type OpKind = "msg" | "edit" | "delete" | "reaction" | "presence" | "cmd" | "stream";
export type Role = "agent" | "human";

export interface Op {
  /** `<author>@<hlc>` — globally unique dedupe key. */
  id: string;
  /** Stable per-participant id (registry `author`); the HLC node + identity. */
  author: string;
  /** Display name at send time. */
  name: string;
  role: Role;
  /** Sortable Hybrid Logical Clock (hlc.ts). */
  hlc: string;
  kind: OpKind;
  /** msg/edit: text. reaction: the emoji/label. presence: status. Absent for delete. */
  body?: string;
  /** edit/delete/reaction: the target op id being amended. */
  ref?: string;
  /** Phase 3: ed25519 signature over `id` (author authenticity). */
  sig?: string;
}

const KINDS: ReadonlySet<string> = new Set([
  "msg",
  "edit",
  "delete",
  "reaction",
  "presence",
  "cmd",
  "stream",
]);
const ROLES: ReadonlySet<string> = new Set(["agent", "human"]);

/** Deterministic op id from author + hlc (no content hash needed — see file header). */
export function opId(author: string, hlc: string): string {
  return `${author}@${hlc}`;
}

/** Construct a well-formed op, filling `id` and dropping empty optional fields. */
export function makeOp(fields: {
  author: string;
  name: string;
  role: Role;
  hlc: string;
  kind: OpKind;
  body?: string;
  ref?: string;
}): Op {
  const op: Op = {
    id: opId(fields.author, fields.hlc),
    author: fields.author,
    name: fields.name,
    role: fields.role,
    hlc: fields.hlc,
    kind: fields.kind,
  };
  if (fields.body !== undefined) op.body = fields.body;
  if (fields.ref) op.ref = fields.ref;
  return op;
}

/**
 * Validate an op arriving from an untrusted source (peer wire, disk, storage).
 * Fail-closed: a malformed op is dropped, never coerced. Also enforces that `id`
 * matches `author@hlc` so a peer can't smuggle a colliding id.
 */
export function isValidOp(x: unknown): x is Op {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.author !== "string" || !o.author) return false;
  if (typeof o.name !== "string") return false;
  if (typeof o.hlc !== "string" || !o.hlc) return false;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return false;
  if (typeof o.role !== "string" || !ROLES.has(o.role)) return false;
  if (o.body !== undefined && typeof o.body !== "string") return false;
  if (o.ref !== undefined && typeof o.ref !== "string") return false;
  if (o.sig !== undefined && typeof o.sig !== "string") return false;
  if (o.id !== opId(o.author, o.hlc)) return false;
  // amendments must target something
  if ((o.kind === "edit" || o.kind === "delete" || o.kind === "reaction") && !o.ref) return false;
  // control ops carry a payload (cmd: JSON action; stream: delta) in `body`
  if ((o.kind === "cmd" || o.kind === "stream") && !o.body) return false;
  return true;
}
