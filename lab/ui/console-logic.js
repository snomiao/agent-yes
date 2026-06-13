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
