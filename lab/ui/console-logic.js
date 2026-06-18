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
// A cwd inside a git submodule keeps trailing path after the worktree branch
// (e.g. .../tree/share/lib/bot, where lib/bot is a submodule). The owner/repo/
// branch still describe the superproject worktree — git itself resolves a
// submodule cwd's identity to the superproject — so we surface the submodule's
// leaf dir as `sub` to keep nested repos distinguishable. `sub` is "" when the
// cwd is the worktree root.
export function repoBranch(e) {
  const m = /\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/.exec(e.cwd || "");
  if (!m) return null;
  const sub = (m[4] || "").split("/").filter(Boolean).pop() || "";
  return { owner: m[1], repo: m[2], branch: m[3], sub };
}

// Identity string for the left panel. cap=true → repo/branch each clipped to
// 3 chars for the compact one-line view (e.g. "age/mai").
export function ident(e, cap) {
  const rb = repoBranch(e);
  if (!rb) return "";
  const c = (s) => (cap && s.length > 3 ? s.slice(0, 3) : s);
  const sub = rb.sub ? `→${rb.sub}` : "";
  return `${c(rb.repo)}/${c(rb.branch)}${sub}`;
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
  const rb = repoBranch(e) || { owner: "", repo: "", branch: "", sub: "" };
  return {
    user: d.user,
    host: d.host,
    owner: rb.owner,
    repo: rb.repo,
    branch: rb.branch,
    sub: rb.sub,
  };
}

const IDENT_ORDER = ["user", "host", "owner", "repo", "branch", "sub"];

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
//
// `parent` is this row's tree parent entry (a subagent's superagent), when it
// has one. A field that matches the parent's is ALSO blanked: the nesting
// already conveys it, so a subagent in the same worktree as its parent shows
// only what differs — often just the submodule leaf (e.g. "//→bot"), or nothing
// at all (hidden by hasIdent) when it's the very same checkout.
export function compactIdent(e, ctx, cap = 3, parent = null) {
  const m = identFields(e);
  const p = parent ? identFields(parent) : null;
  const clip = (s) => (cap && s.length > cap ? s.slice(0, cap) : s);
  const blank = (f) => ctx.uniform[f] || (p != null && p[f] === m[f]);
  const v = (f) => (blank(f) ? "" : clip(m[f]));
  // Submodule leaf is shown in full (the finest-grain distinguisher) and joined
  // with → rather than / so it reads as "inside that worktree".
  const sub = blank("sub") ? "" : m.sub;
  const path = `${v("owner")}/${v("repo")}/${v("branch")}${sub ? `→${sub}` : ""}`;
  return ctx.anyDevice ? `${v("user")}@${v("host")}:${path}` : path;
}

// The full, uncapped identity for a hover title — every field shown, device
// prefix only when this agent actually has device info.
export function fullIdent(e) {
  const m = identFields(e);
  const sub = m.sub ? `→${m.sub}` : "";
  const path = `${m.owner}/${m.repo}/${m.branch}${sub}`;
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
    if (rb.sub) t.push(["sub", rb.sub]); // submodule leaf, when cwd is nested
  }
  const cli = cliLabel(e);
  if (cli) t.push(["cli", cli]);
  if (e._host) t.push(["host", e._host]); // codehost rooms: which machine
  return t;
}

// Compact git indicator from the record's `git` snapshot (server-side
// `git status --porcelain --branch`): "±3" changed files, "↑1" ahead, "↓2"
// behind. Returns "" when there's no git info or the tree is clean and in sync,
// so a tidy repo adds no noise. Branch itself is shown via the path identity.
export function gitLabel(e) {
  const g = e.git;
  if (!g) return "";
  const parts = [];
  if (g.changed > 0) parts.push("±" + g.changed);
  if (g.ahead > 0) parts.push("↑" + g.ahead);
  if (g.behind > 0) parts.push("↓" + g.behind);
  return parts.join(" ");
}

// Task-progress badge ("2/5") from the agent's parsed todo block (e.tasks =
// { done, total }, computed live in /api/ls). Empty string when no todo block was
// confidently detected — the badge is omitted entirely, never shown as "0/0".
export function taskLabel(e) {
  const t = e.tasks;
  if (!t || typeof t.total !== "number" || t.total <= 0) return "";
  return `${t.done}/${t.total}`;
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
    (e.title || "") +
    " " +
    (e.prompt || "") +
    " " +
    e.cli +
    " " +
    (e.cwd || "") +
    " " +
    e.status +
    (e.git?.dirty ? " dirty" : "");
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

// Box-drawing rail prefix for a node given the "is-last-child?" flags of each
// ancestor (root→node). depth 0 → "". Shared by the agent forest and the layered
// room/peer tree so all rails line up: "│  ", "   " for ancestors, "├ "/"└ " here.
function railPrefix(ancestorsLast) {
  const depth = ancestorsLast.length;
  let s = "";
  for (let i = 0; i < depth - 1; i++) s += ancestorsLast[i] ? "   " : "│  ";
  if (depth > 0) s += ancestorsLast[depth - 1] ? "└ " : "├ ";
  return s;
}

// Stable ordered grouping: [[key, items[]], ...] in first-seen key order.
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const e of arr) {
    const k = keyFn(e);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return [...m.entries()];
}

// Build the agent>subagent forest for ONE host's entries (pids are only unique
// per machine, so the caller must pre-scope by host). Links via parent_pid ===
// wrapper_pid. Returns root nodes { entry, children }, sibling/root order = input
// order. A parent_pid cycle can't drop nodes: anything not reached from a root is
// appended as its own root.
function agentForestNodes(list) {
  const byWrapper = new Map();
  for (const e of list) if (e.wrapper_pid != null) byWrapper.set(e.wrapper_pid, e);
  const nodeOf = new Map(list.map((e) => [e, { entry: e, children: [] }]));
  const roots = [];
  for (const e of list) {
    const parent = e.parent_pid != null ? byWrapper.get(e.parent_pid) : null;
    if (parent && parent !== e) nodeOf.get(parent).children.push(nodeOf.get(e));
    else roots.push(nodeOf.get(e));
  }
  // Cycle safety: collect nodes reachable from roots; append the rest as roots.
  const seen = new Set();
  const mark = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const e of list) if (!seen.has(nodeOf.get(e))) roots.push(nodeOf.get(e));
  return roots;
}

// Order entries as agent>subagent forests so a nested `ay` (one agent spawning
// another) renders indented under its parent. SCOPED PER HOST. Returns a NEW
// array in depth-first order; each entry is shallow-copied with `_branch` (a
// box-drawing tree prefix like "│  └ ") and `_depth`. A fleet with no nesting
// renders exactly as before (every row a root, empty `_branch`).
export function forestOrder(entries) {
  const out = [];
  for (const [, list] of groupBy(entries, (e) => e._host || "")) {
    const seen = new Set();
    const walk = (node, ancestorsLast) => {
      if (seen.has(node)) return; // break a pathological parent_pid cycle
      seen.add(node);
      out.push(
        Object.assign({}, node.entry, {
          _branch: railPrefix(ancestorsLast),
          _depth: ancestorsLast.length,
        }),
      );
      node.children.forEach((c, i) =>
        walk(c, ancestorsLast.concat(i === node.children.length - 1)),
      );
    };
    for (const r of agentForestNodes(list)) walk(r, []);
  }
  return out;
}

// Build the full console hierarchy — signalling-server > rooms > peers(hosts) >
// agents > subagents — and flatten it into ordered render rows, VSCode-explorer
// style: a container layer (room/peer) with a single node in its scope is HIDDEN
// (its children float up a level); a layer with ≥2 siblings becomes a tree with
// ├ └ │ rails. Agents always get their own row, with their subagent forest nested
// beneath. The server layer is implicit (always one) so it never shows.
//
// Returns [{ kind:'room'|'peer'|'agent', label, entry, branch, depth }] in
// display order. Headers (room/peer) are non-selectable; only 'agent' rows are.
// A purely local fleet (one room, one unlabelled host) yields only agent rows —
// identical to forestOrder — so the common case stays a plain agent tree.
export function layeredRows(entries) {
  const multiRoom = new Set(entries.map((e) => e._room || "")).size > 1;

  // Container nodes carry a `kind`/`label` for headers; agent nodes carry an
  // `entry`. A hidden layer simply isn't created — its agents/peers attach to the
  // parent — which is what makes single-node layers vanish.
  const roomNodes = [];
  for (const [rid, re] of groupBy(entries, (e) => e._room || "")) {
    const peerGroups = groupBy(re, (e) => e._host || "");
    const multiPeer = peerGroups.length > 1;
    const underRoom = [];
    for (const [host, pe] of peerGroups) {
      const agentNodes = agentForestNodes(pe).map(toAgentNode);
      if (multiPeer && host)
        underRoom.push({ kind: "peer", label: host, room: rid, host, children: agentNodes });
      else underRoom.push(...agentNodes); // single/unlabelled peer hidden
    }
    if (multiRoom && rid) roomNodes.push({ kind: "room", label: rid, children: underRoom });
    else roomNodes.push(...underRoom); // single room hidden
  }

  const rows = [];
  const seen = new Set();
  // parentAgent carries the nearest ancestor agent's entry down the walk so a
  // subagent row knows its superagent — used to omit identity fields the tree
  // nesting already conveys (see compactIdent). Room/peer headers are skipped.
  const walk = (node, ancestorsLast, parentAgent) => {
    if (seen.has(node)) return; // break a pathological parent_pid cycle
    seen.add(node);
    rows.push({
      kind: node.kind,
      label: node.label,
      entry: node.entry,
      room: node.room, // peer headers: (room,host) keys the connection-type cache
      host: node.host,
      parentEntry: node.kind === "agent" ? parentAgent : null,
      branch: railPrefix(ancestorsLast),
      depth: ancestorsLast.length,
    });
    const nextParent = node.kind === "agent" ? node.entry : parentAgent;
    (node.children || []).forEach((c, i) =>
      walk(c, ancestorsLast.concat(i === node.children.length - 1), nextParent),
    );
  };
  for (const r of roomNodes) walk(r, [], null);
  return rows;
}

// Wrap an agent forest node { entry, children } into a layered-tree node.
function toAgentNode(n) {
  return { kind: "agent", entry: n.entry, children: n.children.map(toAgentNode) };
}

// Next selection index when stepping the list by `dir` (+1 down / -1 up).
// No current selection (i<0) lands on the first (down) or last (up) row;
// otherwise clamps at the ends. Returns -1 for an empty list.
export function nextIndex(len, i, dir) {
  if (len <= 0) return -1;
  if (i < 0) return dir > 0 ? 0 : len - 1;
  return Math.max(0, Math.min(len - 1, i + dir));
}
