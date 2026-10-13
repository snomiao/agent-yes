import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { claudeConfigPath, cmdTrust, markTrusted, trustKey } from "./claudeTrust.ts";

// Synthetic config only — never the real ~/.claude.json.
let root: string;
let file: string;
let project: string;
const seed = {
  numStartups: 3,
  projects: { "/repo/alpha": { hasTrustDialogAccepted: true, allowedTools: [] } },
};
const read = async () => JSON.parse(await readFile(file, "utf8"));

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ay-trust-")));
  file = path.join(root, ".claude.json");
  project = path.join(root, "work");
  await mkdir(project);
  await writeFile(file, JSON.stringify(seed, null, 2), { mode: 0o600 });
});
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(async () => {
  vi.restoreAllMocks();
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  await rm(root, { recursive: true, force: true });
});

describe("claudeConfigPath", () => {
  it("honours CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/.claude.json");
    expect(claudeConfigPath({})).toMatch(/\.claude\.json$/);
  });
});

describe("markTrusted", () => {
  it("adds the flag for exactly that path, keeping everything else", async () => {
    expect(await markTrusted(project, file)).toBe("trusted");
    const doc = await read();
    expect(doc.projects[project]).toEqual({ hasTrustDialogAccepted: true });
    expect(doc.projects["/repo/alpha"]).toEqual(seed.projects["/repo/alpha"]);
    expect(doc.numStartups).toBe(3);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(`${file}.ay-trust.bak`, "utf8"))).toEqual(seed);
    expect((await stat(`${file}.ay-trust.bak`)).mode & 0o777).toBe(0o600);
  });
  it("keeps an existing project entry's other fields", async () => {
    await writeFile(file, JSON.stringify({ projects: { [project]: { lastCost: 1 } } }));
    await markTrusted(project, file);
    expect((await read()).projects[project]).toEqual({ lastCost: 1, hasTrustDialogAccepted: true });
  });
  it("is a no-op (no write, no backup) when already trusted", async () => {
    const before = await stat(file);
    expect(await markTrusted("/repo/alpha", file)).toBe("already-trusted");
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    await expect(stat(`${file}.ay-trust.bak`)).rejects.toThrow();
  });
  it("retries when the file changes between read and rename, keeping the other write", async () => {
    let n = 0;
    const result = await markTrusted(project, file, {
      beforeRename: async () => {
        if (n++ === 0) {
          // A running claude rewrites the file meanwhile (different size).
          await writeFile(file, JSON.stringify({ ...seed, numStartups: 4, extra: "x" }, null, 2));
        }
      },
    });
    expect(result).toBe("trusted");
    const doc = await read();
    expect(doc.numStartups).toBe(4); // the concurrent write survived
    expect(doc.projects[project].hasTrustDialogAccepted).toBe(true);
  });
  it("gives up, leaving the file as the other writer left it, if it never settles", async () => {
    let n = 0;
    await expect(
      markTrusted(project, file, {
        beforeRename: () => writeFile(file, JSON.stringify({ ...seed, n: n++ })),
      }),
    ).rejects.toThrow(/kept changing/);
    expect((await read()).projects[project]).toBeUndefined();
  });
  it("refuses a missing or non-object file without creating anything", async () => {
    await expect(markTrusted(project, path.join(root, "nope.json"))).rejects.toThrow(/not found/);
    await writeFile(file, "[1,2]");
    await expect(markTrusted(project, file)).rejects.toThrow(/not a JSON object/);
    await writeFile(file, JSON.stringify({ projects: [] }));
    await expect(markTrusted(project, file)).rejects.toThrow(/"projects" is not a JSON object/);
    await writeFile(file, "{oops");
    await expect(markTrusted(project, file)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{oops");
  });
  it("writes through a symlinked config file instead of replacing the link", async () => {
    const link = path.join(root, "link.json");
    await symlink(file, link);
    await markTrusted(project, link);
    expect((await read()).projects[project].hasTrustDialogAccepted).toBe(true);
  });
});

describe("trustKey", () => {
  it("is the real path of an existing directory", async () => {
    const via = path.join(root, "via");
    await symlink(project, via);
    expect(await trustKey(via)).toBe(project);
    await expect(trustKey(file)).rejects.toThrow(/not a directory/);
  });
});

describe("ay trust", () => {
  let out: string;
  let err: string;
  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: any) => ((out += String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c: any) => ((err += String(c)), true));
  });
  it("--check reports, marking trusts, a second run is a no-op", async () => {
    expect(await cmdTrust([project, "--check", "--config", file])).toBe(1);
    expect(out).toMatch(/not marked trusted/);
    expect(await cmdTrust([project, `--config=${file}`])).toBe(0);
    expect(out).toMatch(/^trusted /m);
    expect(await cmdTrust([project, "--config", file])).toBe(0);
    expect(out).toMatch(/already trusted/);
    expect(await cmdTrust([project, "--check", "--config", file])).toBe(0);
  });
  it("rejects --config without a value instead of falling back to the default file", async () => {
    // If the value were dropped, the default file would be used: point that at
    // our synthetic config so a regression shows up here, never in ~/.claude.json.
    process.env.CLAUDE_CONFIG_DIR = root;
    expect(await cmdTrust([project, "--config"])).toBe(1);
    expect(await cmdTrust([project, "--config", "--check"])).toBe(1);
    expect(err).toMatch(/--config needs a file path/);
    expect((await read()).projects[project]).toBeUndefined();
  });
  it("rejects unknown options and extra args", async () => {
    expect(await cmdTrust(["--yes"])).toBe(1);
    expect(await cmdTrust([project, project, "--config", file])).toBe(1);
  });
});
