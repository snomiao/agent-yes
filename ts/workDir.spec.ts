import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWithin, resolveWorkDir, workdirSamplePath } from "./workDir.ts";

describe("resolveWorkDir", () => {
  let root: string;
  const saved = process.env.AGENT_YES_HOME;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "ay-workdir-")));
    process.env.AGENT_YES_HOME = path.join(root, "ay");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = saved;
  });

  function sample(pid: number, workdir: string, at: number, agent_id?: string) {
    const p = workdirSamplePath(pid);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ workdir, at, agent_id }));
  }

  it("falls back to the spawn dir until the wrapper has sampled a workdir", async () => {
    expect(await resolveWorkDir({ pid: 1111, cwd: "/repo/alpha/tree/main" })).toEqual({
      workdir: "/repo/alpha/tree/main",
      workdir_source: "spawn",
      workdir_at: null,
    });
  });

  it("uses the sampled repo when the lane works outside its spawn dir", async () => {
    const wt = path.join(root, "feat-x");
    mkdirSync(wt);
    sample(1111, wt, 42, "abc123");
    expect(
      await resolveWorkDir({ pid: 1111, agent_id: "abc123", cwd: path.join(root, "main") }),
    ).toEqual({ workdir: wt, workdir_source: "observed", workdir_at: 42 });
  });

  it("ignores a sample left by an earlier agent with the same pid", async () => {
    const wt = path.join(root, "feat-x");
    mkdirSync(wt);
    sample(1111, wt, 42, "old000");
    expect(
      await resolveWorkDir({ pid: 1111, agent_id: "new111", cwd: "/repo/alpha" }),
    ).toMatchObject({ workdir: "/repo/alpha", workdir_source: "spawn" });
  });

  it("ignores a sample when either side lacks an agent_id", async () => {
    const wt = path.join(root, "feat-x");
    mkdirSync(wt);
    sample(1111, wt, 42);
    expect(
      await resolveWorkDir({ pid: 1111, agent_id: "abc123", cwd: "/repo/alpha" }),
    ).toMatchObject({ workdir_source: "spawn" });
    sample(1111, wt, 42, "abc123");
    expect(await resolveWorkDir({ pid: 1111, cwd: "/repo/alpha" })).toMatchObject({
      workdir_source: "spawn",
    });
  });

  it("keeps the more precise spawn dir when the sampled repo contains it", async () => {
    const spawn = path.join(root, "lib", "x");
    mkdirSync(spawn, { recursive: true });
    sample(1111, root, 1, "abc123");
    expect(await resolveWorkDir({ pid: 1111, agent_id: "abc123", cwd: spawn })).toMatchObject({
      workdir: spawn,
      workdir_source: "spawn",
    });
  });

  it("ignores a sampled dir that no longer exists (worktree removed)", async () => {
    sample(1111, path.join(root, "gone"), 1, "abc123");
    expect(
      await resolveWorkDir({ pid: 1111, agent_id: "abc123", cwd: "/repo/alpha" }),
    ).toMatchObject({
      workdir: "/repo/alpha",
      workdir_source: "spawn",
    });
  });

  it("isWithin is path-segment aware", () => {
    expect(isWithin("/repo/a/b", "/repo/a")).toBe(true);
    expect(isWithin("/repo/a", "/repo/a")).toBe(true);
    expect(isWithin("/repo/ab", "/repo/a")).toBe(false);
  });
});
