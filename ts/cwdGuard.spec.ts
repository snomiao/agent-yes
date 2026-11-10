import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { applyCwdGuard, checkCwd } from "./cwdGuard.ts";

// Every case injects its deps: the real guard chdir()s the process, and a spec
// that actually parked vitest in a deleted directory would break module
// resolution for the rest of the run. The end-to-end behaviour is covered by
// running the built CLI from a deleted cwd (see the PR).
const gone = () => {
  throw Object.assign(new Error("ENOENT: uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
};

describe("checkCwd", () => {
  it("passes through when the cwd is fine", () => {
    const chdir = vi.fn();
    expect(checkCwd({ cwd: () => "/repo/alpha", chdir, pwd: "/repo/alpha" })).toEqual({
      state: "ok",
    });
    expect(chdir).not.toHaveBeenCalled();
  });

  it("recovers into $PWD when the directory was recreated", () => {
    // The `ay ws new` case: the shell's inode is gone but the path exists again,
    // and it is exactly where the user typed the command.
    const chdir = vi.fn();
    expect(
      checkCwd({ cwd: gone, chdir, pwd: "/x/acme/acme/tree/main", isDir: () => true }),
    ).toEqual({ state: "recovered", dir: "/x/acme/acme/tree/main" });
    expect(chdir).toHaveBeenCalledWith("/x/acme/acme/tree/main");
  });

  it("reports when $PWD is gone too, naming the path and the way out", () => {
    const v = checkCwd({
      cwd: gone,
      chdir: vi.fn(),
      pwd: "/x/acme/acme/tree/main",
      isDir: () => false,
    });
    expect(v.state).toBe("stale");
    const msg = v.state === "stale" ? v.message : "";
    expect(msg).toContain("/x/acme/acme/tree/main");
    expect(msg).toContain("no longer exists");
    expect(msg).toContain('cd "$PWD"');
    // One readable block, not a stack trace: no `    at <frame>` lines.
    expect(msg).not.toMatch(/\n\s+at /);
  });

  it("does not trust a relative or missing $PWD", () => {
    const chdir = vi.fn();
    // A relative $PWD cannot be resolved without the cwd we just lost.
    expect(checkCwd({ cwd: gone, chdir, pwd: "tree/main", isDir: () => true }).state).toBe("stale");
    expect(checkCwd({ cwd: gone, chdir, pwd: undefined, isDir: () => true }).state).toBe("stale");
    expect(chdir).not.toHaveBeenCalled();
  });

  it("reports when chdir itself fails (a race with another delete)", () => {
    const v = checkCwd({
      cwd: gone,
      chdir: () => {
        throw new Error("ENOENT");
      },
      pwd: "/repo/alpha",
      isDir: () => true,
    });
    expect(v.state).toBe("stale");
  });
});

describe("applyCwdGuard", () => {
  it("warns once on recovery and does not fail", () => {
    const warn = vi.fn();
    const fail = vi.fn(() => {
      throw new Error("should not fail");
    }) as unknown as (s: string) => never;
    const v = applyCwdGuard(
      { cwd: gone, chdir: vi.fn(), pwd: "/repo/alpha", isDir: () => true },
      { warn, fail },
    );
    expect(v.state).toBe("recovered");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("/repo/alpha");
  });

  it("fails with the message when there is nothing to recover to", () => {
    const warn = vi.fn();
    const fail = vi.fn() as unknown as (s: string) => never;
    applyCwdGuard({ cwd: gone, chdir: vi.fn(), pwd: undefined }, { warn, fail });
    expect(warn).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the cwd is healthy", () => {
    const warn = vi.fn();
    const fail = vi.fn() as unknown as (s: string) => never;
    applyCwdGuard({ cwd: () => "/repo/alpha", chdir: vi.fn() }, { warn, fail });
    expect(warn).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("cli.ts import order", () => {
  // The guard only works if it is evaluated before any import that touches the
  // cwd. Reordering the imports would silently restore the raw-stack-trace
  // crash, with nothing failing to show it — so pin the position here.
  it("imports ./cwdGuard.ts before anything else", async () => {
    const src = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
    const firstImport = src.split("\n").find((l) => l.trimStart().startsWith("import "));
    expect(firstImport).toContain("./cwdGuard.ts");
  });
});
