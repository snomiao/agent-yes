import { describe, expect, it } from "vitest";
import { isMissingRoute, pickRemoteRow, statusSnapshotFromLsRow } from "./subcommands.ts";

// Older Rust `ay serve` hosts have no /api/status/ or /api/read/; the client
// falls back to /api/ls and the raw /api/tail snapshot. These pin the pieces
// that decide WHEN to fall back and WHAT the fallback prints.
describe("remote status/read fallback for hosts without the routes", () => {
  it("tells a missing route from a missing agent", () => {
    expect(isMissingRoute(404, "not found")).toBe(true);
    expect(isMissingRoute(404, "Not Found\n")).toBe(true);
    // the resolver's own 404s mean the route exists and the agent doesn't
    expect(isMissingRoute(404, 'no agent matches "zz"')).toBe(false);
    expect(isMissingRoute(404, 'no agent matched "zz"')).toBe(false);
    expect(isMissingRoute(401, "not found")).toBe(false);
  });

  it("picks the row like resolveOne: exact pid, then agent_id, then a live one", () => {
    const rows = [
      { pid: 2222, status: "exited", agent_id: "aaaa0000bbbb" },
      { pid: 3333, status: "idle", prompt: "peer 1111" },
      { pid: 1111, status: "active" },
    ];
    expect(pickRemoteRow(rows, "1111").pid).toBe(1111);
    expect(pickRemoteRow(rows, "AAAA0000BBBB").pid).toBe(2222);
    expect(pickRemoteRow(rows, "alpha").pid).toBe(3333);
  });

  it("maps an /api/ls row to the `ay status` snapshot shape", () => {
    const snap = statusSnapshotFromLsRow(
      {
        pid: 1111,
        cli: "claude",
        cwd: "/repo/alpha",
        status: "needs_input",
        status_text: "✻ Working",
        question: "Allow?",
        last_active_at: 5_000,
        started_at: 1_000,
        exit_code: null,
        log_file: "/repo/alpha/.agent-yes/1111.raw.log",
      },
      9_000,
    );
    expect(snap).toEqual({
      pid: 1111,
      cli: "claude",
      cwd: "/repo/alpha",
      workdir: "/repo/alpha",
      workdir_source: "spawn",
      state: "needs_input",
      activity: "✻ Working",
      question: "Allow?",
      note: null,
      log_mtime_ms: 5_000,
      started_at: 1_000,
      age_ms: 8_000,
      exit_code: null,
      exit_reason: null,
      log_file: "/repo/alpha/.agent-yes/1111.raw.log",
    });
    const gone = statusSnapshotFromLsRow({ pid: 1, status: "exited", started_at: 0 }, 1);
    expect(gone.state).toBe("stopped");
    expect(gone.log_mtime_ms).toBeNull();
  });
});
