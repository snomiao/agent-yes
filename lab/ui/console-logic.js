// Pure, DOM-free logic for the agent-yes console (lab/ui/index.html).
//
// Extracted into its own ES module so it can be unit-tested in vitest
// (tests/ui-logic/console-logic.spec.ts) while the browser imports it directly
// — no build step. Everything here is a pure function of its arguments: no
// document/window/localStorage access, no Date.now() except via an injected
// `now` so age() is deterministic under test.

// An agent entry as surfaced by /api/ls (the fields this module reads):
//   { cli, cwd, title, prompt, status, started_at, pid, _host }

// claude is the default CLI — show the cli name only when it differs, so the
// common case stays uncluttered and the identity (repo/branch) leads instead.
export const cliLabel = (e) => (e.cli && e.cli !== "claude" ? e.cli : "");

// Parse owner/repo/branch from a cwd like .../ws/<owner>/<repo>/tree/<branch>.
export function repoBranch(e) {
  const m = /\/([^/]+)\/([^/]+)\/tree\/([^/]+)/.exec(e.cwd || "");
  return m ? { owner: m[1], repo: m[2], branch: m[3] } : null;
}

// Identity string for the left panel. cap=true → repo/branch each clipped to
// 3 chars for the compact one-line view (e.g. "age/mai").
export function ident(e, cap) {
  const rb = repoBranch(e);
  if (!rb) return "";
  const c = (s) => (cap && s.length > 3 ? s.slice(0, 3) : s);
  return `${c(rb.repo)}/${c(rb.branch)}`;
}

// ---- device-aware identity (multi-room) -----------------------------------
// When several machines' agents are aggregated into one list, an agent's full
// identity is user@host:owner/repo/branch. The device (user@host) comes from the
// codehost peer label on `_host`; the path (owner/repo/branch) from the cwd.

// Split a codehost device label into { user, host }. "sno@taka" → both parts;
// "taka" (no @) → host only; "" / missing → both empty (a local/unknown device).
export function deviceParts(host) {
  if (!host) return { user: "", host: "" };
  const at = String(host).indexOf("@");
  return at >= 0
    ? { user: String(host).slice(0, at), host: String(host).slice(at + 1) }
    : { user: "", host: String(host) };
}

// The five identity fields, in display order, for one agent.
export function identFields(e) {
  const d = deviceParts(e._host);
  const rb = repoBranch(e) || { owner: "", repo: "", branch: "" };
  return { user: d.user, host: d.host, owner: rb.owner, repo: rb.repo, branch: rb.branch };
}

const IDENT_ORDER = ["user", "host", "owner", "repo", "branch"];

// Precompute, over the whole shown list: which fields are uniform (identical for
// every agent — so they can be omitted) and whether any device info exists at
// all (if not, we render the legacy path-only identity, no user@host: prefix).
export function identContext(entries) {
  const fields = entries.map(identFields);
  const uniform = {};
  for (const f of IDENT_ORDER) uniform[f] = new Set(fields.map((x) => x[f])).size <= 1;
  const anyDevice = fields.some((x) => x.user || x.host);
  return { uniform, anyDevice };
}

// Build an agent's compact identity against a precomputed identContext. Each
// field is clipped to `cap` chars (compact one-liner) and BLANKED when uniform
// across the list — but the separators (@ : / /) are kept so the string stays
// machine-parseable: e.g. all on one device → "@:age/mai", a mixed-device list →
// "sno@tak:age/mai". A purely local list (no devices anywhere) falls back to the
// legacy "own/rep/bra" with no device prefix.
export function compactIdent(e, ctx, cap = 3) {
  const m = identFields(e);
  const clip = (s) => (cap && s.length > cap ? s.slice(0, cap) : s);
  const v = (f) => (ctx.uniform[f] ? "" : clip(m[f]));
  const path = `${v("owner")}/${v("repo")}/${v("branch")}`;
  return ctx.anyDevice ? `${v("user")}@${v("host")}:${path}` : path;
}

// The full, uncapped identity for a hover title — every field shown, device
// prefix only when this agent actually has device info.
export function fullIdent(e) {
  const m = identFields(e);
  const path = `${m.owner}/${m.repo}/${m.branch}`;
  return m.user || m.host ? `${m.user}@${m.host}:${path}` : path;
}

// True when a compact identity carries at least one real character (not just
// separators) — used to decide whether to render the identity span at all.
export function hasIdent(s) {
  return /[^@:/]/.test(s || "");
}

// Count of distinct devices (user@host) present in the list. >1 means "not
// alone" → worth showing the device tag in the detailed view.
export function deviceCount(entries) {
  const set = new Set();
  for (const e of entries) {
    const { user, host } = deviceParts(e._host);
    if (user || host) set.add(user + "@" + host);
  }
  return set.size;
}

// Derive codehost-style mnemonic tags from a cwd like .../ws/<owner>/<repo>/tree/<wt>.
export function tagsFor(e) {
  const t = [];
  const rb = repoBranch(e);
  if (rb) {
    t.push(["repo", `${rb.owner}/${rb.repo}`], ["wt", rb.branch]);
  }
  const cli = cliLabel(e);
  if (cli) t.push(["cli", cli]);
  if (e._host) t.push(["host", e._host]); // codehost rooms: which machine
  return t;
}

// Human age of an agent ("12s" / "5m" / "3h"). `now` is injectable so tests
// don't depend on the wall clock; the browser calls age(e) and gets Date.now().
export function age(e, now = Date.now()) {
  if (!e.started_at) return "";
  const s = Math.max(0, (now - e.started_at) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

// Filter predicate: every space-separated token must match. A `key:value` token
// matches against the mnemonic tags (repo/wt/cli/host); a bare token is a
// case-insensitive substring search over title/prompt/cli/cwd/status.
export function matches(e, toks) {
  const hay =
    (e.title || "") + " " + (e.prompt || "") + " " + e.cli + " " + (e.cwd || "") + " " + e.status;
  return toks.every((tok) => {
    tok = tok.toLowerCase();
    const ci = tok.indexOf(":");
    if (ci > 0) {
      const k = tok.slice(0, ci),
        v = tok.slice(ci + 1);
      // room: / device: filter the aggregation by source and machine.
      if (k === "room")
        return String(e._room || "")
          .toLowerCase()
          .includes(v);
      if (k === "device" || k === "dev")
        return String(e._host || "")
          .toLowerCase()
          .includes(v);
      return tagsFor(e).some(([tk, tv]) => tk === k && tv.toLowerCase().includes(v));
    }
    return hay.toLowerCase().includes(tok);
  });
}

// Next selection index when stepping the list by `dir` (+1 down / -1 up).
// No current selection (i<0) lands on the first (down) or last (up) row;
// otherwise clamps at the ends. Returns -1 for an empty list.
export function nextIndex(len, i, dir) {
  if (len <= 0) return -1;
  if (i < 0) return dir > 0 ? 0 : len - 1;
  return Math.max(0, Math.min(len - 1, i + dir));
}
