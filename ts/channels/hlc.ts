// Hybrid Logical Clock (HLC) for ay channels.
//
// A channel is a grow-only set of immutable ops replicated across peers with no
// coordinator (see store.ts). To display those ops in a stable, causally-sensible
// order every replica must agree on, each op carries an HLC timestamp: a wall
// clock reading fused with a per-node counter so that (a) order roughly tracks
// real time, (b) concurrent ops from different nodes get a deterministic
// tie-break, and (c) an op always sorts AFTER every op its author had already
// seen when it was created (causality).
//
// The timestamp is encoded as a FIXED-WIDTH, lexicographically-sortable string
//   "<ms:15><SEP><ctr:6><SEP><node>"
// so a plain string compare reproduces the numeric HLC order — which lets the
// jsonl store and the wire protocol sort without parsing. This module is
// dependency-free and isomorphic (Node + browser).

const MS_WIDTH = 15; // ms since epoch; 15 digits lasts past year 33000
const CTR_WIDTH = 6; // per-ms counter; 10^6 ops sharing one ms is astronomically safe
const SEP = "."; // 0x2e < '0' (0x30) so, with fixed widths, it never reorders fields

export interface Hlc {
  ms: number;
  ctr: number;
  node: string;
}

/** Encode an HLC as its sortable string form. */
export function formatHlc(ms: number, ctr: number, node: string): string {
  if (ms < 0 || ctr < 0) throw new Error("hlc: negative component");
  if (ms >= 10 ** MS_WIDTH || ctr >= 10 ** CTR_WIDTH) throw new Error("hlc: component overflow");
  return `${String(ms).padStart(MS_WIDTH, "0")}${SEP}${String(ctr).padStart(CTR_WIDTH, "0")}${SEP}${node}`;
}

/** Parse a sortable HLC string back into its components. Throws on malformed input. */
export function parseHlc(s: string): Hlc {
  const parts = s.split(SEP);
  if (parts.length < 3) throw new Error("hlc: malformed");
  const ms = Number(parts[0]);
  const ctr = Number(parts[1]);
  // node ids never contain SEP, but be defensive if one ever does.
  const node = parts.slice(2).join(SEP);
  if (!Number.isInteger(ms) || !Number.isInteger(ctr) || !node) throw new Error("hlc: malformed");
  return { ms, ctr, node };
}

/**
 * Numeric HLC comparison. Equivalent to a plain string compare of the sortable
 * form (that's the point of the fixed-width encoding), but exposed explicitly so
 * callers reading structured HLCs don't have to reconstruct the string.
 */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Produce the HLC for a new local op. `prevMax` is the greatest HLC this replica
 * has already stored (from ANY author — see store.maxHlc); passing it makes the
 * result monotonic across process restarts and causally after everything seen,
 * with no separate clock-state file to persist. `physNow` is the wall clock
 * (Date.now()); `node` is this participant's stable id.
 */
export function hlcSend(prevMax: string | null, physNow: number, node: string): string {
  const prev = prevMax ? parseHlc(prevMax) : { ms: 0, ctr: 0 };
  if (physNow > prev.ms) return formatHlc(physNow, 0, node);
  // wall clock hasn't advanced past what we've seen — keep the ms, bump the counter
  return formatHlc(prev.ms, prev.ctr + 1, node);
}
