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

// Windows daemons report cwds with backslashes (C:\Users\…\tree\main); every
// cwd parser/comparator below assumes forward slashes, so normalize once here.
// Without this a Windows host's agents parse no owner/repo/branch and render as
// a bare "user@host://" with no path identity.
export function normCwd(cwd) {
  return (cwd || "").replace(/\\/g, "/");
}

// Parse owner/repo/branch from a cwd like .../ws/<owner>/<repo>/tree/<branch>.
// A cwd inside a git submodule keeps trailing path after the worktree branch
// (e.g. .../tree/share/lib/bot, where lib/bot is a submodule). The owner/repo/
// branch still describe the superproject worktree — git itself resolves a
// submodule cwd's identity to the superproject — so we surface the submodule's
// leaf dir as `sub` to keep nested repos distinguishable. `sub` is "" when the
// cwd is the worktree root.
export function repoBranch(e) {
  const m = /\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/.exec(normCwd(e.cwd));
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
// `git status --porcelain=v2 --branch`): "±3" real changed files, "⑂2"
// submodule pin-bumps, "⊙1" submodule internal dirt, "↑1" ahead, "↓2" behind.
// Pins/sub-dirt are split out of "±" so submodule drift (constant in a repo with
// many submodules) never buries the real file edits. Returns "" when there's no
// git info or the tree is clean and in sync, so a tidy repo adds no noise. Branch
// itself is shown via the path identity.
export function gitLabel(e) {
  const g = e.git;
  if (!g) return "";
  const parts = [];
  if (g.changed > 0) parts.push("±" + g.changed);
  if (g.pins > 0) parts.push("⑂" + g.pins);
  if (g.subDirty > 0) parts.push("⊙" + g.subDirty);
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

// Display metadata for status flags matched server-side against an agent's
// screen (ts/badges.ts BADGE_DEFS — matching runs server-side; the API sends
// just the matched ids in e.badges). Keep the label/title text here in sync
// with ts/badges.ts. An id with no entry still renders (falls back to the raw
// id), so a newly-added server-side badge is never silently dropped.
export const BADGE_META = {
  "goal-active": { label: "goal", title: "A /goal Stop-hook loop is active on this agent" },
  "session-limit": {
    label: "limit",
    title: "Usage session limit hit — waiting for the reset time shown on screen",
  },
  retrying: {
    label: "retry",
    title: "Waiting for the API — the CLI is auto-retrying on its own backoff (no action needed)",
  },
};

// Status-flag chips ("badges") matched against the agent's screen — e.g. an
// active /goal loop. [] when e.badges is missing/empty. Returns
// { id, label, title } objects ready for the caller to render as chips.
export function badgesFor(e) {
  return (e.badges || []).map((id) => ({ id, ...(BADGE_META[id] || { label: id, title: id }) }));
}

// Time since the agent was last active ("12s" / "5m" / "3h") — measured from
// its last stdout write (last_active_at, the log file's mtime), so a long-lived
// but quiet agent reads as stale rather than "new". Falls back to started_at
// when the server hasn't stamped a last-active time (e.g. freshly spawned, no
// log yet). `now` is injectable so tests don't depend on the wall clock; the
// browser calls age(e) and gets Date.now().
export function age(e, now = Date.now()) {
  const at = e.last_active_at ?? e.started_at;
  if (!at) return "";
  const s = Math.max(0, (now - at) / 1000);
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
// per machine, so the caller must pre-scope by host). Primary link is the explicit
// spawn relationship (parent_pid === wrapper_pid). As a FALLBACK, an agent with no
// such parent whose cwd sits INSIDE another agent's cwd of the SAME worktree
// (owner/repo/branch) snaps under it — so a submodule/subdir agent nests under its
// superproject agent even without a parent_pid link. Returns root nodes
// { entry, children }; sibling/root order = input order. Cycles can't drop nodes:
// anything not reached from a root is appended as its own root.
function agentForestNodes(list) {
  const byWrapper = new Map();
  for (const e of list) if (e.wrapper_pid != null) byWrapper.set(e.wrapper_pid, e);
  const nodeOf = new Map(list.map((e) => [e, { entry: e, children: [] }]));

  const parentOf = new Map();
  // 1) explicit spawn link.
  for (const e of list) {
    const p = e.parent_pid != null ? byWrapper.get(e.parent_pid) : null;
    if (p && p !== e) parentOf.set(e, p);
  }
  // 2) cwd-containment fallback for the still-parentless. The closest ancestor
  //    (longest containing cwd) wins; same-worktree guard keeps an unrelated
  //    shared prefix (e.g. /Users/x/ws) from grouping strangers together.
  for (const e of list) {
    if (parentOf.has(e) || !e.cwd) continue;
    const rb = repoBranch(e);
    if (!rb) continue;
    const ecwd = normCwd(e.cwd);
    let best = null;
    for (const c of list) {
      if (c === e || !c.cwd || !ecwd.startsWith(normCwd(c.cwd) + "/")) continue;
      const crb = repoBranch(c);
      if (!crb || crb.owner !== rb.owner || crb.repo !== rb.repo || crb.branch !== rb.branch)
        continue;
      if (!best || normCwd(c.cwd).length > normCwd(best.cwd).length) best = c;
    }
    if (best) parentOf.set(e, best);
  }
  // Attach, refusing any edge that would close a cycle (a pre-existing parent_pid
  // cycle, or a pid/cwd mix) — such nodes stay roots.
  const wouldCycle = (parent, child) => {
    for (let cur = parent, i = 0; cur && i < list.length + 1; cur = parentOf.get(cur), i++)
      if (cur === child) return true;
    return false;
  };
  const roots = [];
  for (const e of list) {
    const p = parentOf.get(e);
    if (p && p !== e && !wouldCycle(p, e)) nodeOf.get(p).children.push(nodeOf.get(e));
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

// ---- display sort order -----------------------------------------------------
// The console cycles a button through these; the chosen comparator runs over the
// flat entry list BEFORE layeredRows builds the room/peer/agent tree (which keeps
// the given order for siblings and first-seen order for room/peer groups). So
// sorting reorders roots and siblings without breaking the nesting.
export const SORT_MODES = ["state", "active", "created", "identity"];

// Attention-first state ranking: someone scanning the fleet wants the agents that
// need them (needs_input) up top, then the wedged ones (stuck), then live work,
// then quiet/idle, then finished. Unknown states sort last.
const STATE_RANK = {
  needs_input: 0,
  stuck: 1,
  active: 2,
  running: 2,
  idle: 3,
  stopped: 4,
  exited: 4,
};
function stateRank(e) {
  const r = STATE_RANK[e.status];
  return r === undefined ? 5 : r;
}

// Git "busyness" for the state mode's secondary key: a dirty / ahead / behind
// repo outranks a clean one, and more outstanding changes rank higher. The +0.5
// for `dirty` breaks a 0-count tie toward the dirty tree.
function gitWeight(e) {
  const g = e.git || {};
  return (g.changed || 0) + (g.ahead || 0) + (g.behind || 0) + (g.dirty ? 0.5 : 0);
}

// Last-active instant for an entry: its last stdout write (last_active_at),
// falling back to started_at when the server hasn't stamped one yet.
function lastActive(e) {
  return e.last_active_at ?? e.started_at ?? 0;
}

// Return a NEW array sorted for display per `mode` (default "state"):
//   - "state":    attention-first state, then git busyness, then newest.
//   - "active":   most recently active first (last_active_at desc).
//   - "created":  newest first (started_at desc).
//   - "identity": user@host:owner/repo/branch (alphabetical).
// Every comparator falls back to newest-first so order is total & deterministic.
export function sortEntries(entries, mode = "state") {
  const byNewest = (a, b) => (b.started_at || 0) - (a.started_at || 0);
  const byActive = (a, b) => lastActive(b) - lastActive(a) || byNewest(a, b);
  const cmp =
    mode === "active"
      ? byActive
      : mode === "created"
        ? byNewest
        : mode === "identity"
          ? (a, b) => fullIdent(a).localeCompare(fullIdent(b)) || byNewest(a, b)
          : (a, b) => stateRank(a) - stateRank(b) || gitWeight(b) - gitWeight(a) || byNewest(a, b);
  return entries.slice().sort(cmp);
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

// ---------------------------------------------------------------------------
// multi-viewer presence + shared-canvas geometry
// index.html keeps the DOM glue (measuring elements, applying transforms); the
// coordinate math lives here so it's unit-testable without a browser.
// ---------------------------------------------------------------------------

// ---- collaborative presence: peer focus + stdin flash ----------------------
// The left panel colour-codes who's on which agent: your own selection is blue
// (the .sel bar), every OTHER human peer's focus is yellow (.peerfocus), and a
// row pulses when its stdin was just written — independent of focus, since an
// `ay send` feeds an agent no one is looking at. These pure helpers own the
// bookkeeping so index.html only measures the DOM.

// Detect agents whose stdin just advanced. `seen` maps _key -> the last
// last_stdin_at we observed; given the current entries, return the _keys whose
// last_stdin_at is NEWER than what we'd seen (someone typed / `ay send` pushed),
// and fold the new values into `seen`. A key seen for the FIRST time never
// flashes (else every agent would pulse on initial load) — only a later bump
// does. Keys no longer present are pruned so `seen` can't grow without bound.
export function advanceStdinFlashes(entries, seen) {
  const fresh = [];
  const alive = new Set();
  for (const e of entries) {
    const key = e._key;
    if (!key) continue;
    alive.add(key);
    const at = e.last_stdin_at;
    if (typeof at !== "number") continue;
    const prev = seen.get(key);
    if (prev !== undefined && at > prev) fresh.push(key);
    if (prev === undefined || at > prev) seen.set(key, at);
  }
  for (const key of [...seen.keys()]) if (!alive.has(key)) seen.delete(key);
  return fresh;
}

// Summarize fleet presence for the peers badge + per-row chips. `records` is one
// entry per OTHER viewer currently watching an agent: { key, viewer } (key = the
// composite _key of the agent they're on). Returns { total, byKey }: `total`
// distinct viewers (the "N peers" badge), `byKey` a Map of _key -> how many
// peers watch that agent (the yellow per-row chip + .peerfocus trigger).
export function focusSummary(records) {
  const viewers = new Set();
  const byKey = new Map();
  for (const r of records) {
    if (!r || !r.key || !r.viewer) continue;
    viewers.add(r.viewer);
    byKey.set(r.key, (byKey.get(r.key) || 0) + 1);
  }
  return { total: viewers.size, byKey };
}

// Stable per-viewer hue (0..359) for colour-coding peers' selections.
export function hashHue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

// Encode an xterm selection (getSelectionPosition() → {start:{x,y}, end:{x,y}},
// y = ABSOLUTE buffer line) as "fromBottomRow,col-fromBottomRow,col". Viewers
// connect at different times so absolute rows don't align, but the live-tail
// content does — distance from the bottom is a shared coordinate. `bufferLen` is
// the buffer's line count. Returns null when there's no selection.
export function selFromBottom(s, bufferLen) {
  if (!s || !s.start || !s.end) return null;
  const last = (bufferLen || 1) - 1;
  return `${last - s.start.y},${s.start.x}-${last - s.end.y},${s.end.x}`;
}

// Parse "fbRow,col-fbRow,col" (rows = lines-from-bottom). null if malformed.
export function parseSel(selStr) {
  const m = /^(\d+),(\d+)-(\d+),(\d+)$/.exec(selStr || "");
  if (!m) return null;
  return { fa: +m[1], ca: +m[2], fb: +m[3], cb: +m[4] };
}

// Per-row spans for a peer selection, in OUR buffer rows, clipped to the visible
// viewport [vy, vy+myRows). fromBottom is mapped against OUR buffer bottom
// (myLast) so the same tail line matches across viewers of different scrollback
// depth. A selection is per-row: top row cA→edge, full-width middle, bottom row
// 0→cB. Columns are EXACT when widths match, proportional only as a fallback.
export function selSegments(sel, myLast, vy, myRows, peerCols, myCols) {
  if (!sel) return [];
  const sameW = (peerCols || myCols) === myCols;
  const mapC = (c) => (sameW ? c : Math.round((c / (peerCols || myCols)) * myCols));
  let rA = myLast - sel.fa,
    rB = myLast - sel.fb,
    cA = sel.ca,
    cB = sel.cb;
  if (rA > rB) (([rA, rB] = [rB, rA]), ([cA, cB] = [cB, cA])); // rA = top row
  const segs = [];
  const from = Math.max(rA, vy),
    to = Math.min(rB, vy + myRows - 1);
  for (let r = from; r <= to; r++) {
    const a = r === rA ? cA : 0;
    const b = r === rB ? cB : myCols;
    segs.push({ row: r, a: Math.min(mapC(a), mapC(b)), b: Math.max(mapC(a), mapC(b)) });
  }
  return segs;
}

// Shared-canvas fit: the CSS transform that fits a grid (gridW×gridH px) into a
// pane (paneW×paneH px). Near-1 → "none" so the driver / single viewer (whose
// grid already fits) stays crisp and unchanged; otherwise "scale(s)". The
// 0.985–1.04 band absorbs FitAddon's whole-cell rounding slack.
export function fitTransform(gridW, gridH, paneW, paneH) {
  if (!gridW || !gridH || paneW <= 0 || paneH <= 0) return "none";
  const s = Math.min(paneW / gridW, paneH / gridH);
  return s > 0.985 && s < 1.04 ? "none" : "scale(" + s.toFixed(4) + ")";
}

// Browser-tab title: "<glyph> <selected agent title> - agent-yes", or the bare
// console title when nothing is selected (blank/whitespace name). The leading
// glyph mirrors the agent's status dot — ⌨ needs_input ("your turn"), ⚠ stuck,
// ● active, ○ idle, ✗ exited — so the tab shows liveness at a glance even in a
// background tab; an unknown status adds no glyph.
export function statusGlyph(status) {
  return status === "needs_input"
    ? "⌨"
    : status === "stuck"
      ? "⚠"
      : status === "active"
        ? "●"
        : status === "idle"
          ? "○"
          : status === "exited"
            ? "✗"
            : "";
}
export function docTitle(name, status) {
  const n = name && String(name).trim();
  if (!n) return "agent-yes · console";
  const g = statusGlyph(status);
  return (g ? g + " " : "") + n + " - agent-yes";
}

// Relevance score for the Cmd+K omnibox — higher ranks first. Title hits beat
// cwd/prompt hits so the "quick title match" surfaces at the top; 0 means no
// title/cwd/prompt hit (such an agent only appears via a tail-content match,
// which the caller scores separately and ranks below these).
export function omniScore(e, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return 0;
  const title = (e.title || "").toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.includes(q)) return 60;
  if ((e.cwd || "").toLowerCase().includes(q)) return 40;
  if ((e.prompt || "").toLowerCase().includes(q)) return 20;
  return 0;
}
