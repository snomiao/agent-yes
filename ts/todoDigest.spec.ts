import { describe, expect, it } from "vitest";
import {
  buildTreeJSON,
  openBlockers,
  renderDigest,
  renderTree,
  unblockedTasks,
} from "./todoDigest";
import type { TodoRecord } from "./todoStore";

function task(over: Partial<TodoRecord> & { _id: string }): TodoRecord {
  return {
    kind: "code",
    state: "doing",
    summary: `task ${over._id}`,
    description: "",
    blockedBy: [],
    tags: [],
    satisfiedGates: [],
    verifyEvidence: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("unblockedTasks", () => {
  it("fires only when ALL blockers reached done, never for a finished task, never with zero declared deps", () => {
    const tasks = [
      task({ _id: "T1", state: "done" }),
      task({ _id: "T2", state: "done" }),
      task({ _id: "T3", state: "shipped", blockedBy: ["T1", "T2"] }), // both done -> unblocked
      task({ _id: "T4", state: "shipped", blockedBy: ["T1", "T5"] }), // T5 not done -> still blocked
      task({ _id: "T5", state: "doing" }),
      task({ _id: "T6", state: "done", blockedBy: ["T1"] }), // finished -> not surfaced
      task({ _id: "T7", state: "shipped" }), // no declared deps -> nothing to detect
    ];
    expect(unblockedTasks(tasks).map((t) => t._id)).toEqual(["T3"]);
  });
});

describe("unblockedTasks with a blocked-by-task block", () => {
  it("treats block:{type:blocked-by-task,taskId} as an additional dependency, so it self-clears once the target reaches done, matching todoBlock.ts's documented promise (codex-review round-6 Important — this was previously inert)", () => {
    const tasks = [
      task({ _id: "T1", state: "done" }),
      task({
        _id: "T2",
        state: "doing",
        block: { type: "blocked-by-task", taskId: "T1" },
      }),
      task({
        _id: "T3",
        state: "doing",
        block: { type: "blocked-by-task", taskId: "T4" },
      }),
      task({ _id: "T4", state: "doing" }), // T3's target not done yet -> still blocked
    ];
    expect(unblockedTasks(tasks).map((t) => t._id)).toEqual(["T2"]);
  });

  it("folds a blocked-by-task block in ALONGSIDE blockedBy — both must clear", () => {
    const tasks = [
      task({ _id: "T1", state: "done" }),
      task({ _id: "T2", state: "doing" }), // not done
      task({
        _id: "T3",
        state: "doing",
        blockedBy: ["T2"],
        block: { type: "blocked-by-task", taskId: "T1" },
      }),
    ];
    expect(unblockedTasks(tasks)).toEqual([]); // T2 still open
  });
});

describe("openBlockers", () => {
  it("reports only the not-yet-done blockers, including a missing id as open", () => {
    const byId = new Map([
      ["T1", task({ _id: "T1", state: "done" })],
      ["T2", task({ _id: "T2", state: "doing" })],
    ]);
    const t = task({ _id: "T3", blockedBy: ["T1", "T2", "T99"] });
    expect(openBlockers(t, byId)).toEqual(["T2", "T99"]);
  });
});

describe("renderTree", () => {
  const tasks = [
    task({ _id: "T1", state: "done", summary: "schema" }),
    task({ _id: "T2", state: "doing", summary: "api", owner: "cto", blockedBy: ["T1"] }),
    task({ _id: "T3", state: "shipped", summary: "ui", blockedBy: ["T2"] }),
  ];

  it("renders roots (nothing depends on them, they have deps) down blockedBy edges", () => {
    const out = renderTree(tasks);
    expect(out).toContain("T3 [shipped] ui");
    expect(out).toContain("└─ T2 [doing] api");
    expect(out).toContain("owner:cto");
  });

  it("accepts an explicit root id and throws on an unknown one", () => {
    expect(renderTree(tasks, "T2")).toContain("└─ T1 [done] schema");
    expect(() => renderTree(tasks, "T99")).toThrow(/no such task/);
  });

  it("reports a friendly message when there are no dependency links at all", () => {
    expect(renderTree([task({ _id: "T1" })])).toContain("no dependency links");
  });
});

describe("buildTreeJSON", () => {
  const tasks = [
    task({ _id: "T1", state: "done", summary: "schema" }),
    task({ _id: "T2", state: "doing", summary: "api", owner: "cto", blockedBy: ["T1"] }),
    task({ _id: "T3", state: "shipped", summary: "ui", blockedBy: ["T2"] }),
  ];

  it("renders the same structure as renderTree, as nested data", () => {
    expect(buildTreeJSON(tasks)).toEqual([
      {
        id: "T3",
        state: "shipped",
        summary: "ui",
        children: [
          {
            id: "T2",
            state: "doing",
            summary: "api",
            owner: "cto",
            children: [{ id: "T1", state: "done", summary: "schema", children: [] }],
          },
        ],
      },
    ]);
  });

  it("throws on an unknown explicit root, like renderTree", () => {
    expect(() => buildTreeJSON(tasks, "T99")).toThrow(/no such task/);
  });

  it("faithfully expands a DIAMOND dependency under EACH branch, not just the first-visited one (codex-review nitpick)", () => {
    // A depends on both B and C, which both depend on the same D
    const diamond = [
      task({ _id: "A", blockedBy: ["B", "C"] }),
      task({ _id: "B", blockedBy: ["D"] }),
      task({ _id: "C", blockedBy: ["D"] }),
      task({ _id: "D", state: "done" }),
    ];
    const [root] = buildTreeJSON(diamond, "A");
    const b = root!.children.find((c) => c.id === "B")!;
    const c = root!.children.find((c) => c.id === "C")!;
    // BOTH branches show D's full (childless-but-present) node — neither is
    // a bare stub just because the other branch already "saw" D first.
    expect(b.children).toEqual([{ id: "D", state: "done", summary: "task D", children: [] }]);
    expect(c.children).toEqual([{ id: "D", state: "done", summary: "task D", children: [] }]);
  });
});

describe("renderDigest", () => {
  it("groups by tag with per-state counts, and surfaces blocked/waiting/unblocked info inline", () => {
    const tasks = [
      task({ _id: "T1", state: "done", tags: ["proj-x"] }),
      task({ _id: "T2", state: "doing", tags: ["proj-x"], owner: "cto", blockedBy: ["T1"] }),
      task({
        _id: "T3",
        state: "shipped",
        tags: ["proj-y"],
        blockedBy: ["T2"],
        block: { type: "blocked-by-human", who: "taku" },
      }),
    ];
    const out = renderDigest(tasks);
    expect(out).toContain("## proj-x");
    expect(out).toContain("## proj-y");
    expect(out).toContain("block:blocked-by-human");
    expect(out).toContain("blockedBy:T2"); // T3's blocker T2 isn't done yet
    expect(out).toContain("unblocked (all blockers reached done");
    expect(out).toContain("T2 task T2"); // T2's blocker T1 IS done -> unblocked section
  });

  it("empty task list renders a friendly message, not a crash", () => {
    expect(renderDigest([])).toBe("(no tasks)");
  });
});
