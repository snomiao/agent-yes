// Unit tests for the agent-yes console's pure logic (lab/ui/console-logic.js).
// These cover the behaviour the left panel relies on: default-CLI omission,
// repo/branch identity (incl. the 3-char compact cap), key:value + bare-token
// filtering, age formatting, and the Alt+PageUp/PageDown selection clamp.
import { describe, it, expect } from "vitest";
import {
  cliLabel,
  repoBranch,
  ident,
  tagsFor,
  gitLabel,
  age,
  matches,
  nextIndex,
  deviceParts,
  identFields,
  identContext,
  compactIdent,
  fullIdent,
  hasIdent,
  deviceCount,
  forestOrder,
  layeredRows,
  sortEntries,
  SORT_MODES,
  taskLabel,
  hashHue,
  selFromBottom,
  parseSel,
  selSegments,
  fitTransform,
  docTitle,
  statusGlyph,
  omniScore,
} from "../../lab/ui/console-logic.js";

const agent = (over = {}) => ({
  cli: "claude",
  cwd: "/home/u/ws/snomiao/agent-yes/tree/main",
  title: "",
  prompt: "",
  status: "active",
  pid: 1,
  ...over,
});

describe("cliLabel", () => {
  it("omits the default claude CLI", () => {
    expect(cliLabel(agent({ cli: "claude" }))).toBe("");
  });
  it("shows non-default CLIs", () => {
    expect(cliLabel(agent({ cli: "codex" }))).toBe("codex");
    expect(cliLabel(agent({ cli: "gemini" }))).toBe("gemini");
  });
  it("treats a missing cli as empty", () => {
    expect(cliLabel(agent({ cli: undefined }))).toBe("");
  });
});

describe("repoBranch", () => {
  it("parses owner/repo/branch from a .../tree/<branch> cwd", () => {
    expect(repoBranch(agent())).toEqual({
      owner: "snomiao",
      repo: "agent-yes",
      branch: "main",
      sub: "",
    });
  });
  it("returns null when the cwd doesn't match the layout", () => {
    expect(repoBranch(agent({ cwd: "/tmp/scratch" }))).toBeNull();
    expect(repoBranch(agent({ cwd: "" }))).toBeNull();
  });
  it("surfaces a submodule leaf below the worktree as `sub`", () => {
    // cwd inside a submodule keeps the superproject's owner/repo/branch (git
    // resolves it that way) but exposes the submodule dir so it's distinguishable.
    expect(repoBranch(agent({ cwd: "/x/symval/symval/tree/share/lib/bot" }))).toEqual({
      owner: "symval",
      repo: "symval",
      branch: "share",
      sub: "bot",
    });
  });
  it("parses a Windows backslash cwd (the daemon reports C:\\…\\tree\\branch)", () => {
    // Without normalization the regex never matches a Windows host's cwd, so its
    // agents render as a bare "user@host://" with no repo/branch identity.
    expect(
      repoBranch(agent({ cwd: "C:\\Users\\snomi\\ws\\snomiao\\agent-yes\\tree\\main" })),
    ).toEqual({ owner: "snomiao", repo: "agent-yes", branch: "main", sub: "" });
  });
});

describe("ident", () => {
  it("renders repo/branch in full when uncapped", () => {
    expect(ident(agent())).toBe("agent-yes/main");
  });
  it("caps repo and branch to 3 chars in compact mode", () => {
    expect(ident(agent(), true)).toBe("age/mai");
  });
  it("does not pad short names when capping", () => {
    expect(ident(agent({ cwd: "/x/me/ab/tree/cd" }), true)).toBe("ab/cd");
  });
  it("is empty when there's no repo/branch", () => {
    expect(ident(agent({ cwd: "/tmp" }), true)).toBe("");
  });
});

describe("deviceParts", () => {
  it("splits user@host", () => {
    expect(deviceParts("sno@taka")).toEqual({ user: "sno", host: "taka" });
  });
  it("treats a bare label as host-only", () => {
    expect(deviceParts("laptop")).toEqual({ user: "", host: "laptop" });
  });
  it("is empty for missing/empty device", () => {
    expect(deviceParts("")).toEqual({ user: "", host: "" });
    expect(deviceParts(undefined)).toEqual({ user: "", host: "" });
  });
});

describe("identFields", () => {
  it("combines device (user/host) and path (owner/repo/branch)", () => {
    expect(identFields(agent({ _host: "sno@taka" }))).toEqual({
      user: "sno",
      host: "taka",
      owner: "snomiao",
      repo: "agent-yes",
      branch: "main",
      sub: "",
    });
  });
  it("leaves device empty for a local agent and path empty off-layout", () => {
    expect(identFields(agent({ cwd: "/tmp" }))).toEqual({
      user: "",
      host: "",
      owner: "",
      repo: "",
      branch: "",
      sub: "",
    });
  });
});

describe("compactIdent (omit-if-uniform, separators kept)", () => {
  it("local-only list: path-only (owner/repo/branch), no device prefix", () => {
    const list = [agent(), agent({ cwd: "/x/me/widgets/tree/dev" })];
    const ctx = identContext(list);
    expect(ctx.anyDevice).toBe(false);
    expect(compactIdent(list[0], ctx)).toBe("sno/age/mai");
    expect(compactIdent(list[1], ctx)).toBe("me/wid/dev");
  });
  it("all on one device: device blanked but @ : kept", () => {
    const list = [
      agent({ _host: "sno@taka" }),
      agent({ _host: "sno@taka", cwd: "/x/me/widgets/tree/dev" }),
    ];
    const ctx = identContext(list);
    expect(compactIdent(list[0], ctx)).toBe("@:sno/age/mai");
    expect(compactIdent(list[1], ctx)).toBe("@:me/wid/dev");
  });
  it("mixed devices: device shown and capped; uniform user blanked", () => {
    const list = [
      agent({ _host: "sno@taka" }),
      agent({ _host: "sno@beelink", cwd: "/x/me/widgets/tree/dev" }),
    ];
    const ctx = identContext(list);
    // user "sno" is uniform → blanked; host differs → shown, capped to 3.
    expect(compactIdent(list[0], ctx)).toBe("@tak:sno/age/mai");
    expect(compactIdent(list[1], ctx)).toBe("@bee:me/wid/dev");
  });
  it("uniform owner blanked in a local list (separators kept)", () => {
    const list = [agent(), agent({ cwd: "/home/u/ws/snomiao/widgets/tree/dev" })];
    const ctx = identContext(list);
    // same owner snomiao → blanked; repo/branch differ.
    expect(compactIdent(list[0], ctx)).toBe("/age/mai");
    expect(compactIdent(list[1], ctx)).toBe("/wid/dev");
  });
  it("uniform repo blanked while branch differs (separators preserved)", () => {
    const list = [
      agent({ _host: "a@h1", cwd: "/x/me/repo/tree/main" }),
      agent({ _host: "b@h2", cwd: "/x/me/repo/tree/dev" }),
    ];
    const ctx = identContext(list);
    // owner+repo uniform → blanked; user+host+branch differ.
    expect(compactIdent(list[0], ctx)).toBe("a@h1://mai");
    expect(compactIdent(list[1], ctx)).toBe("b@h2://dev");
  });
  it("appends a submodule leaf with → when the cwd is nested", () => {
    const list = [
      agent({ cwd: "/x/symval/symval/tree/share/lib/bot" }),
      agent({ cwd: "/x/symval/symval/tree/share/lib/api" }),
    ];
    const ctx = identContext(list);
    // owner/repo/branch uniform → blanked; only the submodule leaf differs.
    expect(compactIdent(list[0], ctx)).toBe("//→bot");
    expect(compactIdent(list[1], ctx)).toBe("//→api");
  });
});

describe("compactIdent (parent-relative omission in a tree)", () => {
  it("omits fields a subagent shares with its tree parent, keeping the submodule delta", () => {
    const parent = agent({ cwd: "/x/symval/symval/tree/share" });
    const list = [
      parent,
      agent({ cwd: "/x/symval/symval/tree/share/lib/bot" }),
      agent({ cwd: "/x/symval/symval/tree/syn" }),
    ];
    const ctx = identContext(list);
    // Same owner/repo/branch as the parent → blanked; only →bot remains.
    expect(compactIdent(list[1], ctx, 3, parent)).toBe("//→bot");
    // owner/repo are uniform across the whole list (so blanked anyway), but the
    // branch differs from the parent → kept, proving the parent rule is per-field.
    expect(compactIdent(list[2], ctx, 3, parent)).toBe("//syn");
  });
  it("hides the identity entirely for a subagent in the very same checkout", () => {
    const parent = agent({ cwd: "/x/symval/symval/tree/share" });
    const child = agent({ cwd: "/x/symval/symval/tree/share" });
    const ctx = identContext([parent, child, agent()]);
    const id = compactIdent(child, ctx, 3, parent);
    expect(id).toBe("//");
    expect(hasIdent(id)).toBe(false);
  });
});

describe("layeredRows parentEntry", () => {
  it("links a subagent row to its superagent's entry, null for roots/headers", () => {
    const root = agent({ pid: 1, wrapper_pid: 1, cwd: "/x/symval/symval/tree/share" });
    const child = agent({
      pid: 2,
      wrapper_pid: 2,
      parent_pid: 1,
      cwd: "/x/symval/symval/tree/share/lib/bot",
    });
    const rows = layeredRows([root, child]);
    const rootRow = rows.find((r) => r.entry?.pid === 1);
    const childRow = rows.find((r) => r.entry?.pid === 2);
    expect(rootRow?.parentEntry).toBeNull();
    expect(childRow?.parentEntry).toBe(root);
  });
});

describe("fullIdent / hasIdent / deviceCount", () => {
  it("fullIdent is uncapped with device prefix only when present", () => {
    expect(fullIdent(agent({ _host: "sno@taka" }))).toBe("sno@taka:snomiao/agent-yes/main");
    expect(fullIdent(agent())).toBe("snomiao/agent-yes/main");
  });
  it("hasIdent is false for separator-only strings", () => {
    expect(hasIdent("@://")).toBe(false);
    expect(hasIdent("@:age/mai")).toBe(true);
    expect(hasIdent("")).toBe(false);
  });
  it("deviceCount counts distinct devices, ignoring local", () => {
    expect(deviceCount([agent(), agent()])).toBe(0);
    expect(
      deviceCount([agent({ _host: "a@h" }), agent({ _host: "a@h" }), agent({ _host: "b@h" })]),
    ).toBe(2);
  });
});

describe("tagsFor", () => {
  it("derives repo + wt tags, and omits the cli tag for default claude", () => {
    const tags = tagsFor(agent());
    expect(tags).toContainEqual(["repo", "snomiao/agent-yes"]);
    expect(tags).toContainEqual(["wt", "main"]);
    expect(tags.find(([k]) => k === "cli")).toBeUndefined();
  });
  it("adds a cli tag only for non-default CLIs, and a host tag for rooms", () => {
    const tags = tagsFor(agent({ cli: "codex", _host: "laptop" }));
    expect(tags).toContainEqual(["cli", "codex"]);
    expect(tags).toContainEqual(["host", "laptop"]);
  });
});

describe("gitLabel", () => {
  it("is empty without git info or for a clean, in-sync repo", () => {
    expect(gitLabel(agent())).toBe("");
    expect(gitLabel(agent({ git: { dirty: false, changed: 0, ahead: 0, behind: 0 } }))).toBe("");
  });
  it("shows ±changed, ↑ahead, ↓behind, omitting the zero parts", () => {
    expect(gitLabel(agent({ git: { dirty: true, changed: 3, ahead: 0, behind: 0 } }))).toBe("±3");
    expect(gitLabel(agent({ git: { dirty: true, changed: 2, ahead: 1, behind: 4 } }))).toBe(
      "±2 ↑1 ↓4",
    );
    expect(gitLabel(agent({ git: { dirty: false, changed: 0, ahead: 5, behind: 0 } }))).toBe("↑5");
  });
  it("splits submodule pin-bumps (⑂) and internal dirt (⊙) out of ±", () => {
    // pin-drift only: no ± (real files) — drift can't masquerade as file changes
    expect(
      gitLabel(
        agent({ git: { dirty: false, changed: 0, pins: 3, subDirty: 0, ahead: 0, behind: 0 } }),
      ),
    ).toBe("⑂3");
    // real files + pins + sub-dirt, in order
    expect(
      gitLabel(
        agent({ git: { dirty: true, changed: 2, pins: 1, subDirty: 4, ahead: 0, behind: 0 } }),
      ),
    ).toBe("±2 ⑂1 ⊙4");
    // zero pins/subDirty (or absent) add nothing
    expect(gitLabel(agent({ git: { dirty: true, changed: 1, pins: 0, subDirty: 0 } }))).toBe("±1");
  });
});

describe("age", () => {
  const now = 1_000_000_000_000;
  it("returns empty without a start time", () => {
    expect(age(agent({ started_at: 0 }), now)).toBe("");
  });
  it("formats seconds, minutes, and hours", () => {
    expect(age(agent({ started_at: now - 5_000 }), now)).toBe("5s");
    expect(age(agent({ started_at: now - 5 * 60_000 }), now)).toBe("5m");
    expect(age(agent({ started_at: now - 3 * 3_600_000 }), now)).toBe("3h");
  });
  it("clamps a future start time to 0s instead of going negative", () => {
    expect(age(agent({ started_at: now + 10_000 }), now)).toBe("0s");
  });
});

describe("matches", () => {
  it("matches a bare token as a case-insensitive substring", () => {
    expect(matches(agent({ title: "Fix the parser" }), ["parser"])).toBe(true);
    expect(matches(agent({ title: "Fix the parser" }), ["PARSER"])).toBe(true);
    expect(matches(agent(), ["nope"])).toBe(false);
  });
  it("ANDs every token", () => {
    const a = agent({ title: "fix parser bug" });
    expect(matches(a, ["fix", "bug"])).toBe(true);
    expect(matches(a, ["fix", "missing"])).toBe(false);
  });
  it("matches key:value tokens against the mnemonic tags", () => {
    expect(matches(agent(), ["repo:agent-yes"])).toBe(true);
    expect(matches(agent(), ["wt:main"])).toBe(true);
    expect(matches(agent({ cli: "codex" }), ["cli:codex"])).toBe(true);
    expect(matches(agent(), ["repo:nope"])).toBe(false);
    // default claude has no cli tag, so a cli: filter must not match it
    expect(matches(agent({ cli: "claude" }), ["cli:claude"])).toBe(false);
  });
});

describe("nextIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(nextIndex(0, -1, 1)).toBe(-1);
  });
  it("lands on the first row going down / last going up when nothing is selected", () => {
    expect(nextIndex(5, -1, 1)).toBe(0);
    expect(nextIndex(5, -1, -1)).toBe(4);
  });
  it("steps and clamps at both ends", () => {
    expect(nextIndex(5, 2, 1)).toBe(3);
    expect(nextIndex(5, 2, -1)).toBe(1);
    expect(nextIndex(5, 4, 1)).toBe(4); // clamp at bottom, no wrap
    expect(nextIndex(5, 0, -1)).toBe(0); // clamp at top, no wrap
  });
});

describe("forestOrder (agent>subagent tree)", () => {
  const a = (pid: number, over = {}) => ({
    pid,
    wrapper_pid: pid,
    parent_pid: null,
    _host: "h1",
    ...over,
  });

  it("leaves a flat fleet untouched (every row a root, empty branch)", () => {
    const out = forestOrder([a(1), a(2), a(3)]);
    expect(out.map((e) => e.pid)).toEqual([1, 2, 3]);
    expect(out.every((e) => e._branch === "" && e._depth === 0)).toBe(true);
  });

  it("nests children under their parent in DFS order with branch glyphs", () => {
    // root 1 → children 2,3 ; 2 → grandchild 4
    const out = forestOrder([
      a(1),
      a(2, { parent_pid: 1 }),
      a(3, { parent_pid: 1 }),
      a(4, { parent_pid: 2 }),
    ]);
    expect(out.map((e) => e.pid)).toEqual([1, 2, 4, 3]); // DFS: 2's subtree before 3
    const branch = Object.fromEntries(out.map((e) => [e.pid, e._branch]));
    expect(branch[1]).toBe("");
    expect(branch[2]).toBe("├ ");
    expect(branch[4]).toBe("│  └ ");
    expect(branch[3]).toBe("└ ");
  });

  it("scopes linking per host so identical pids on two machines don't cross-link", () => {
    const out = forestOrder([
      a(1, { _host: "h1" }),
      a(2, { _host: "h1", parent_pid: 1 }),
      a(1, { _host: "h2" }), // same pid, different machine
    ]);
    // h2's pid-1 has parent_pid null → its own root, not a child of h1's pid 1.
    const h2root = out.find((e) => e._host === "h2");
    expect(h2root?._depth).toBe(0);
    expect(out.filter((e) => e._depth === 0).length).toBe(2);
  });

  it("does not loop on a parent_pid cycle", () => {
    const out = forestOrder([a(1, { parent_pid: 2 }), a(2, { parent_pid: 1 })]);
    expect(out.length).toBe(2);
  });

  it("snaps a submodule-cwd agent under its superproject agent (no parent_pid)", () => {
    const out = forestOrder([
      a(1, { cwd: "/x/me/repo/tree/main" }),
      a(2, { cwd: "/x/me/repo/tree/main/lib/bot" }),
    ]);
    expect(out.map((e) => e.pid)).toEqual([1, 2]);
    const depth = Object.fromEntries(out.map((e) => [e.pid, e._depth]));
    expect(depth[1]).toBe(0);
    expect(depth[2]).toBe(1);
  });

  it("nests under the closest containing cwd (deepest ancestor wins)", () => {
    const out = forestOrder([
      a(1, { cwd: "/x/me/repo/tree/main" }),
      a(2, { cwd: "/x/me/repo/tree/main/lib" }),
      a(3, { cwd: "/x/me/repo/tree/main/lib/bot" }),
    ]);
    const depth = Object.fromEntries(out.map((e) => [e.pid, e._depth]));
    expect(depth[1]).toBe(0);
    expect(depth[2]).toBe(1);
    expect(depth[3]).toBe(2); // 3 under 2, not directly under 1
  });

  it("does not snap across an unrelated shared prefix (non-worktree)", () => {
    const out = forestOrder([
      a(1, { cwd: "/x/me" }), // not a .../tree/<branch> worktree → repoBranch null
      a(2, { cwd: "/x/me/repo/tree/main" }),
    ]);
    expect(out.filter((e) => e._depth === 0).length).toBe(2);
  });

  it("does not snap a different worktree of the same repo", () => {
    const out = forestOrder([
      a(1, { cwd: "/x/me/repo/tree/main" }),
      a(2, { cwd: "/x/me/repo/tree/main-2/lib/bot" }), // different branch dir, not contained
    ]);
    expect(out.filter((e) => e._depth === 0).length).toBe(2);
  });

  it("lets an explicit parent_pid override the cwd-containment fallback", () => {
    const out = forestOrder([
      a(1, { cwd: "/x/me/repo/tree/main" }),
      a(2, { cwd: "/x/me/repo/tree/main/lib" }),
      a(3, { cwd: "/x/me/repo/tree/main/lib/bot", parent_pid: 1 }), // closest cwd is 2, but spawn parent is 1
    ]);
    const byPid = Object.fromEntries(out.map((e) => [e.pid, e]));
    // 3 sits at depth 1 (directly under 1), not depth 2 (under 2)
    expect(byPid[3]._depth).toBe(1);
  });
});

describe("taskLabel (progress badge)", () => {
  it("formats done/total", () => {
    expect(taskLabel({ tasks: { done: 2, total: 5 } })).toBe("2/5");
    expect(taskLabel({ tasks: { done: 5, total: 5 } })).toBe("5/5");
  });
  it("omits the badge when there is no todo block (never 0/0)", () => {
    expect(taskLabel({})).toBe("");
    expect(taskLabel({ tasks: null })).toBe("");
    expect(taskLabel({ tasks: { done: 0, total: 0 } })).toBe("");
  });
});

describe("layeredRows (rooms>peers>agents folding)", () => {
  const a = (pid: number, over = {}) => ({
    pid,
    wrapper_pid: pid,
    parent_pid: null,
    _room: "local",
    _host: "",
    _key: "local#" + pid,
    ...over,
  });
  const kinds = (rows: any[]) => rows.map((r) => r.kind);

  it("local fleet (1 room, unlabelled host): no headers, just agent rows", () => {
    const rows = layeredRows([a(1), a(2)]);
    expect(kinds(rows)).toEqual(["agent", "agent"]);
    expect(rows.every((r) => r.branch === "")).toBe(true);
  });

  it("hides the room layer when there is only one room", () => {
    const rows = layeredRows([a(1, { _host: "h1" }), a(2, { _host: "h1" })]);
    expect(rows.find((r) => r.kind === "room")).toBeUndefined();
  });

  it("single room, ≥2 peers: peer headers appear, no room header", () => {
    const rows = layeredRows([a(1, { _host: "sno@taka" }), a(2, { _host: "sno@mini" })]);
    expect(rows.filter((r) => r.kind === "room").length).toBe(0);
    expect(rows.filter((r) => r.kind === "peer").map((r) => r.label)).toEqual([
      "sno@taka",
      "sno@mini",
    ]);
    // Peer headers are top-level roots (no rail); the agent under each is railed.
    const peerRows = rows.filter((r) => r.kind === "peer");
    expect(peerRows.every((r) => r.branch === "")).toBe(true);
    expect(rows.find((r) => r.kind === "agent" && r.entry.pid === 1)!.branch).toBe("└ ");
  });

  it("≥2 rooms: room headers appear (top-level roots), agents railed beneath", () => {
    const rows = layeredRows([
      a(1, { _room: "roomA", _host: "" }),
      a(2, { _room: "roomB", _host: "" }),
    ]);
    const rooms = rows.filter((r) => r.kind === "room");
    expect(rooms.map((r) => r.label)).toEqual(["roomA", "roomB"]);
    expect(rooms.every((r) => r.branch === "")).toBe(true);
    // each room's single agent nests one rail deeper
    expect(rows.find((r) => r.kind === "agent" && r.entry.pid === 1)!.branch).toBe("└ ");
  });

  it("nests subagents under their parent within a peer, below the peer header", () => {
    // one room, two peers (so peer headers show); peer h1 has a subagent tree
    const rows = layeredRows([
      a(1, { _host: "h1" }),
      a(2, { _host: "h1", parent_pid: 1 }),
      a(9, { _host: "h2" }),
    ]);
    // h1 header, then agent 1, then its child 2 (deeper), then h2 header + agent 9
    const seq = rows.map((r) => (r.kind === "agent" ? "a" + r.entry.pid : r.kind));
    expect(seq).toEqual(["peer", "a1", "a2", "peer", "a9"]);
    const child = rows.find((r) => r.kind === "agent" && r.entry.pid === 2)!;
    // child is indented one rail deeper than its parent agent
    const parent = rows.find((r) => r.kind === "agent" && r.entry.pid === 1)!;
    expect(child.branch.length).toBeGreaterThan(parent.branch.length);
  });
});

// ---------------------------------------------------------------------------
// multi-viewer presence + shared-canvas geometry
// ---------------------------------------------------------------------------

describe("hashHue", () => {
  it("is stable and in [0,360)", () => {
    expect(hashHue("ab12")).toBe(hashHue("ab12"));
    const h = hashHue("ab12");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe("selFromBottom", () => {
  it("encodes a selection as lines-from-bottom (length-1 - y)", () => {
    // buffer length 60 (last line index 59); selection rows 5..7
    const s = { start: { x: 2, y: 5 }, end: { x: 10, y: 7 } };
    expect(selFromBottom(s, 60)).toBe("54,2-52,10");
  });
  it("returns null when there is no selection", () => {
    expect(selFromBottom(undefined, 60)).toBeNull();
    expect(selFromBottom(null, 60)).toBeNull();
    expect(selFromBottom({ start: { x: 0, y: 0 } } as any, 60)).toBeNull();
  });
});

describe("parseSel", () => {
  it("parses fromBottom endpoints", () => {
    expect(parseSel("54,2-52,10")).toEqual({ fa: 54, ca: 2, fb: 52, cb: 10 });
  });
  it("rejects malformed input", () => {
    expect(parseSel("undefined,x-y,z")).toBeNull();
    expect(parseSel("")).toBeNull();
    expect(parseSel(null as any)).toBeNull();
  });
});

describe("selSegments", () => {
  // round-trip: a selection at buffer rows 5..7 (cols 2..10) of a length-60 buffer
  const sel = parseSel(selFromBottom({ start: { x: 2, y: 5 }, end: { x: 10, y: 7 } }, 60)!)!;

  it("maps to the SAME viewport rows across different buffer lengths (the core fix)", () => {
    // viewer A: buffer 60, top of viewport at line 6
    const a = selSegments(sel, 59, 6, 54, 80, 80).map((s) => ({ vr: s.row - 6, a: s.a, b: s.b }));
    // viewer B: buffer 100, scrolled to bottom (viewportY 46)
    const b = selSegments(sel, 99, 46, 54, 80, 80).map((s) => ({ vr: s.row - 46, a: s.a, b: s.b }));
    expect(a).toEqual(b);
  });

  it("emits proper per-row spans when fully visible", () => {
    // unscrolled: rows 5,6,7 visible at viewport rows 5,6,7
    const segs = selSegments(sel, 59, 0, 54, 80, 80).map((s) => ({ row: s.row, a: s.a, b: s.b }));
    expect(segs).toEqual([
      { row: 5, a: 2, b: 80 }, // top: c0 → edge
      { row: 6, a: 0, b: 80 }, // middle: full width
      { row: 7, a: 0, b: 10 }, // bottom: 0 → c1
    ]);
  });

  it("clips rows scrolled out of the viewport", () => {
    // viewport [vy=10 .. 10+5) shows nothing of a selection at buffer rows 5..7
    expect(selSegments(sel, 59, 10, 5, 80, 80)).toEqual([]);
  });

  it("falls back to proportional columns when the peer width differs", () => {
    const s1 = parseSel("0,10-0,20")!; // single bottom line, cols 10..20 in an 80-wide peer
    const seg = selSegments(s1, 0, 0, 24, 80, 160)[0]; // we are 160 wide
    expect(seg).toEqual({ row: 0, a: 20, b: 40 }); // 10/80*160=20, 20/80*160=40
  });

  it("returns [] for null", () => {
    expect(selSegments(null, 59, 0, 54, 80, 80)).toEqual([]);
  });
});

describe("fitTransform", () => {
  it("is 'none' near 1 (driver / single viewer — absorbs fit rounding)", () => {
    expect(fitTransform(800, 480, 800, 480)).toBe("none");
    expect(fitTransform(800, 480, 810, 490)).toBe("none"); // slack within band
  });
  it("scales down a larger grid to fit (letterbox watcher)", () => {
    expect(fitTransform(1600, 480, 800, 480)).toBe("scale(0.5000)");
  });
  it("scales up a smaller grid", () => {
    expect(fitTransform(400, 240, 800, 480)).toBe("scale(2.0000)");
  });
  it("guards bad dimensions", () => {
    expect(fitTransform(0, 480, 800, 480)).toBe("none");
    expect(fitTransform(800, 480, 0, 480)).toBe("none");
  });
});

describe("statusGlyph", () => {
  it("maps status → glyph", () => {
    expect(statusGlyph("needs_input")).toBe("⌨");
    expect(statusGlyph("stuck")).toBe("⚠");
    expect(statusGlyph("active")).toBe("●");
    expect(statusGlyph("idle")).toBe("○");
    expect(statusGlyph("exited")).toBe("✗");
  });
  it("is empty for unknown/missing status", () => {
    expect(statusGlyph(undefined as any)).toBe("");
    expect(statusGlyph("whatever" as any)).toBe("");
  });
});

describe("docTitle", () => {
  it("suffixes the selected agent's title (no status → no glyph)", () => {
    expect(docTitle("fix the bug")).toBe("fix the bug - agent-yes");
  });
  it("prefixes the status glyph when given", () => {
    expect(docTitle("fix the bug", "active")).toBe("● fix the bug - agent-yes");
    expect(docTitle("fix the bug", "idle")).toBe("○ fix the bug - agent-yes");
    expect(docTitle("fix the bug", "exited")).toBe("✗ fix the bug - agent-yes");
  });
  it("trims whitespace", () => {
    expect(docTitle("  build  ", "active")).toBe("● build - agent-yes");
  });
  it("falls back to the bare console title when empty (regardless of status)", () => {
    expect(docTitle("", "active")).toBe("agent-yes · console");
    expect(docTitle("   ")).toBe("agent-yes · console");
    expect(docTitle(null as any)).toBe("agent-yes · console");
    expect(docTitle(undefined as any)).toBe("agent-yes · console");
  });
});

describe("omniScore", () => {
  const e = (over: any) => ({ title: "", cwd: "", prompt: "", ...over });
  it("ranks title hits above cwd/prompt hits", () => {
    expect(omniScore(e({ title: "fix login" }), "fix")).toBeGreaterThan(
      omniScore(e({ cwd: "/x/fix" }), "fix"),
    );
    expect(omniScore(e({ cwd: "/x/fix" }), "fix")).toBeGreaterThan(
      omniScore(e({ prompt: "fix it" }), "fix"),
    );
  });
  it("exact > startsWith > includes for titles", () => {
    expect(omniScore(e({ title: "deploy" }), "deploy")).toBe(100);
    expect(omniScore(e({ title: "deploy the app" }), "deploy")).toBe(80);
    expect(omniScore(e({ title: "please deploy" }), "deploy")).toBe(60);
  });
  it("is case-insensitive and trims the query", () => {
    expect(omniScore(e({ title: "Deploy" }), "  DEPLOY  ")).toBe(100);
  });
  it("returns 0 for no hit or empty query", () => {
    expect(omniScore(e({ title: "abc" }), "xyz")).toBe(0);
    expect(omniScore(e({ title: "abc" }), "")).toBe(0);
    expect(omniScore(e({ title: "abc" }), "   ")).toBe(0);
  });
});

describe("sortEntries", () => {
  const a = (over = {}) => agent({ started_at: 1000, ...over });
  const keys = (arr, k = "_k") => arr.map((e) => e[k]);

  it("SORT_MODES is the documented cycle", () => {
    expect(SORT_MODES).toEqual(["state", "created", "identity"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [a({ _k: "x" }), a({ _k: "y" })];
    const out = sortEntries(input, "created");
    expect(out).not.toBe(input);
    expect(keys(input)).toEqual(["x", "y"]); // original order untouched
  });

  it("state mode: attention-first state order (needs_input < stuck < active < idle < stopped)", () => {
    const list = [
      a({ _k: "idle", status: "idle" }),
      a({ _k: "stopped", status: "stopped" }),
      a({ _k: "needs", status: "needs_input" }),
      a({ _k: "active", status: "active" }),
      a({ _k: "stuck", status: "stuck" }),
    ];
    expect(keys(sortEntries(list, "state"))).toEqual([
      "needs",
      "stuck",
      "active",
      "idle",
      "stopped",
    ]);
  });

  it("state mode: within the same state, a busier git tree ranks higher", () => {
    const list = [
      a({ _k: "clean", status: "active", git: { changed: 0 } }),
      a({ _k: "dirty", status: "active", git: { changed: 3, dirty: true } }),
      a({ _k: "ahead", status: "active", git: { ahead: 1 } }),
    ];
    expect(keys(sortEntries(list, "state"))).toEqual(["dirty", "ahead", "clean"]);
  });

  it("state is the default mode", () => {
    const list = [a({ _k: "idle", status: "idle" }), a({ _k: "needs", status: "needs_input" })];
    expect(keys(sortEntries(list))).toEqual(["needs", "idle"]);
  });

  it("created mode: newest started_at first", () => {
    const list = [
      a({ _k: "old", started_at: 100 }),
      a({ _k: "new", started_at: 900 }),
      a({ _k: "mid", started_at: 500 }),
    ];
    expect(keys(sortEntries(list, "created"))).toEqual(["new", "mid", "old"]);
  });

  it("identity mode: alphabetical by full identity (user@host:owner/repo/branch)", () => {
    const list = [
      a({ _k: "zed", cwd: "/x/zoe/repo/tree/main" }),
      a({ _k: "amy", cwd: "/x/amy/repo/tree/main" }),
    ];
    expect(keys(sortEntries(list, "identity"))).toEqual(["amy", "zed"]);
  });
});
