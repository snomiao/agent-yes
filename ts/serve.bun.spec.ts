import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "bun:test";
import {
  cmdServe,
  installerArgv,
  managerRunStateArgv,
  MANAGER_TIMED_OUT,
  runManagerCmd,
  probeDaemon,
  isNoNodeExecError,
  oxmgrVersionHasWindowsFix,
  parsePm2Daemon,
  shouldBootstrapOxmgrOverPm2,
  parseGitUrl,
  portlessConsoleUrl,
} from "./serve.ts";

describe("portlessConsoleUrl", () => {
  it("uses the stable local HTTPS hostname and keeps auth in the fragment", () => {
    expect(portlessConsoleUrl()).toBe("https://agent-yes.localhost/");
    expect(portlessConsoleUrl("a b")).toBe("https://agent-yes.localhost/#k=a%20b");
  });
});

// Guards the Windows daemon-manager selection: on Windows we only PREFER oxmgr
// when the installed build carries the daemon-socket-inheritance fix. Stock
// builds <= 0.4.0 still wedge and must fall back to pm2.
describe("oxmgrVersionHasWindowsFix", () => {
  it("accepts the winfix fork build", () => {
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0+winfix")).toBe(true);
    // Case-insensitive, and works as a prerelease tag too.
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0-WinFix.1")).toBe(true);
  });

  it("rejects stock builds at or below the last wedged release", () => {
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0")).toBe(false);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.3.9")).toBe(false);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.1.0")).toBe(false);
    // A plain 0.4.0 prerelease is not the fix.
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.0-rc1")).toBe(false);
  });

  it("assumes the fix is upstreamed in any release newer than 0.4.0", () => {
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.4.1")).toBe(true);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.5.0")).toBe(true);
    expect(oxmgrVersionHasWindowsFix("oxmgr 1.0.0")).toBe(true);
    expect(oxmgrVersionHasWindowsFix("oxmgr 0.5.0-rc1")).toBe(true);
  });

  it("returns false on unparseable output", () => {
    expect(oxmgrVersionHasWindowsFix("")).toBe(false);
    expect(oxmgrVersionHasWindowsFix("oxmgr (unknown)")).toBe(false);
  });
});

// Guards the serve-install diagnostic: a missing node runtime must be reported
// as such, never as a "glibc mismatch" (glibc doesn't even exist on macOS).
describe("isNoNodeExecError", () => {
  it("matches macOS/BSD env output", () => {
    expect(isNoNodeExecError("env: node: No such file or directory")).toBe(true);
  });

  it("matches GNU coreutils quoted env output", () => {
    expect(isNoNodeExecError("env: 'node': No such file or directory")).toBe(true);
  });

  it("matches Windows cmd output", () => {
    expect(isNoNodeExecError("'node' is not recognized as an internal or external command")).toBe(
      true,
    );
  });

  it("matches localized-then-normalized output (probe pins LC_ALL=C)", () => {
    // managerProbe spawns with LC_ALL=C precisely so this English form is what
    // we always see; this test documents the coupling.
    expect(isNoNodeExecError("env: node: No such file or directory")).toBe(true);
  });

  it("does not match a real native/glibc failure", () => {
    expect(
      isNoNodeExecError("oxmgr: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found"),
    ).toBe(false);
    expect(isNoNodeExecError("")).toBe(false);
  });
});

// Bun.spawn without an explicit `env` hands the child the environ captured at
// process startup, NOT the live process.env — so ensureNodeRuntime's shim PATH
// prepend never reached children spawned that way (`pm2 start` died with
// `env: node: No such file or directory` right after the probe passed). Guard
// the fix pattern: every spawn of a daemon-manager binary in serve.ts must pass
// an explicit env.
describe("manager spawns pass a live env snapshot", () => {
  it("every Bun.spawn of mgr.bin/startArgv/installer carries an env option", async () => {
    const src = await readFile(new URL("./serve.ts", import.meta.url), "utf-8");
    // Grab each Bun.spawn(...) call whose argv mentions a manager binary.
    // Capture from the call opening through the options object's closing `})`.
    const calls = src.match(
      /Bun\.spawn\((?:\[[^\]]*\bm(?:gr)?\.bin[^\]]*\]|startArgv|installer|cmd),[\s\S]*?\}\)/g,
    );
    // Most manager commands go through runManagerCmd's single `Bun.spawn(cmd, …)`.
    expect(calls?.length).toBeGreaterThanOrEqual(4);
    for (const call of calls!) {
      // Require a real liveEnv() env option, not just the substring "env:"
      // (which a comment inside the options object could satisfy).
      expect(call, `missing explicit env in: ${call.slice(0, 80)}`).toMatch(
        /env: (?:\{\s*(?:\.\.\.)?)?liveEnv\(\)/,
      );
    }
  });
});

// Guards the oxmgr bootstrap: bun blocks untrusted postinstalls, and oxmgr's
// native binary only arrives via its postinstall — without --trust the install
// "succeeds" but leaves a launcher that dies with "oxmgr binary is missing"
// (the real reason bootstrap used to fall back to pm2 on fresh boxes).
describe("installerArgv", () => {
  it("trusts oxmgr's postinstall under bun", () => {
    expect(installerArgv("oxmgr", "/x/bun", null)).toEqual([
      "/x/bun",
      "add",
      "-g",
      "--trust",
      "oxmgr",
    ]);
  });

  it("keeps pm2 untrusted under bun (pure JS, no required scripts)", () => {
    expect(installerArgv("pm2", "/x/bun", "/x/npm")).toEqual(["/x/bun", "add", "-g", "pm2"]);
  });

  it("falls back to npm without a trust flag (npm runs scripts by default)", () => {
    expect(installerArgv("oxmgr", null, "/x/npm")).toEqual(["/x/npm", "install", "-g", "oxmgr"]);
  });

  it("returns null with neither installer", () => {
    expect(installerArgv("pm2", null, null)).toBeNull();
  });
});

// The raw-clone spawn path only handles NON-github git sources; github (and
// bare owner/repo, which never reaches this parser) goes through the provision
// module. Owner/repo come from the URL's last two path segments so the checkout
// lands in the standard <wsRoot>/<owner>/<repo>/tree/<branch> layout.
describe("parseGitUrl", () => {
  it("parses scp-style, ssh and https non-github URLs", () => {
    expect(parseGitUrl("git@gitlab.com:acme/tools.git")).toEqual({
      url: "git@gitlab.com:acme/tools.git",
      owner: "acme",
      repo: "tools",
    });
    expect(parseGitUrl("ssh://git@git.corp.io/team/app.git")).toEqual({
      url: "ssh://git@git.corp.io/team/app.git",
      owner: "team",
      repo: "app",
    });
    expect(parseGitUrl("https://gitlab.com/acme/tools")).toEqual({
      url: "https://gitlab.com/acme/tools",
      owner: "acme",
      repo: "tools",
    });
    // subgrouped gitlab paths use the LAST two segments
    expect(parseGitUrl("https://gitlab.com/org/group/proj.git")?.owner).toBe("group");
  });

  it("rejects github, bare specs, and traversal-looking segments", () => {
    expect(parseGitUrl("https://github.com/acme/tools")).toBeNull();
    expect(parseGitUrl("git@github.com:acme/tools.git")).toBeNull();
    expect(parseGitUrl("acme/tools")).toBeNull();
    expect(parseGitUrl("https://gitlab.com/tools")).toBeNull();
    expect(parseGitUrl("https://gitlab.com/../evil")).toBeNull();
    expect(parseGitUrl("file:///etc/passwd")).toBeNull();
  });
});

// `ay serve status` reported a LISTENING, answering daemon as "not running"
// because the probe's 3s budget expired on an overloaded host — a no-op
// /api/version measured 1.1s there. A timeout is not an absence, and the two
// want opposite responses (wait vs reinstall), so they must not collapse.
// node:net / node:http here, not Bun.*: this suite runs under BOTH runtimes.
describe("probeDaemon", () => {
  const listen = async (srv: { listen: (p: number, h: string, cb: () => void) => void }) => {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return (srv as unknown as { address(): { port: number } }).address().port;
  };

  it("reports down when nothing is listening on the port", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer();
    const port = await listen(srv);
    await new Promise<void>((r) => srv.close(() => r())); // free it, so the port refuses
    expect((await probeDaemon(port, "tok", 2000)).kind).toBe("down");
  });

  it("reports SLOW, not down, for a port that accepts but never answers", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer(() => {}); // accept, then hold — an overloaded daemon
    const port = await listen(srv);
    try {
      expect((await probeDaemon(port, "tok", 250)).kind).toBe("slow");
    } finally {
      srv.close();
    }
  });

  it("reports the version when the daemon answers", async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "9.9.9" }));
    });
    const port = await listen(srv);
    try {
      expect(await probeDaemon(port, "tok", 5000)).toEqual({ kind: "ok", version: "9.9.9" });
    } finally {
      srv.close();
    }
  });

  it("treats a null port as down without dialling", async () => {
    expect((await probeDaemon(null, "tok", 1)).kind).toBe("down");
  });
});

describe("serve without portless installed", () => {
  it("warns once and keeps serving plain HTTP instead of exiting", async () => {
    const home = await (
      await import("fs/promises")
    ).mkdtemp(path.join((await import("os")).tmpdir(), "ay-noportless-"));
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { cmdServe } = await import(${JSON.stringify(path.join(import.meta.dir, "serve.ts"))}); process.exit(await cmdServe(["--no-rust"]));`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: path.dirname(process.execPath),
          AGENT_YES_PORTLESS_CHILD: "",
          PORTLESS: "",
        },
      },
    );
    const exited = proc.exited.then(() => "exited");
    const outcome = await Promise.race([exited, Bun.sleep(35000).then(() => "alive")]);
    proc.kill();
    const err = await new Response(proc.stderr).text();
    expect(err).not.toContain("Portless is required");
    expect(err.match(/Portless not found/g)?.length).toBe(1);
    expect(outcome).toBe("alive");
  }, 60000);
});

describe("managerRunStateArgv", () => {
  const oxmgr = { id: "oxmgr" as const, bin: "/bin/oxmgr" };
  const pm2 = { id: "pm2" as const, bin: "/bin/pm2" };
  it("restarts the registered daemon by name under both managers", () => {
    expect(managerRunStateArgv(oxmgr, "restart")).toEqual(["/bin/oxmgr", "restart", "agent-yes"]);
    expect(managerRunStateArgv(pm2, "restart")).toEqual(["/bin/pm2", "restart", "agent-yes"]);
  });
  it("starts an existing oxmgr app via restart (oxmgr's start takes a command)", () => {
    expect(managerRunStateArgv(oxmgr, "start")).toEqual(["/bin/oxmgr", "restart", "agent-yes"]);
    expect(managerRunStateArgv(pm2, "start")).toEqual(["/bin/pm2", "start", "agent-yes"]);
    expect(managerRunStateArgv(oxmgr, "stop")).toEqual(["/bin/oxmgr", "stop", "agent-yes"]);
  });
});

describe("runManagerCmd", () => {
  it("returns the exit code and captured stdout", async () => {
    const r = await runManagerCmd(["sh", "-c", "echo hi; exit 3"], { capture: true });
    expect(r).toEqual({ code: 3, stdout: "hi\n", timedOut: false });
  });

  it("kills a command that overruns its deadline instead of hanging", async () => {
    const t0 = Date.now();
    const r = await runManagerCmd(["sh", "-c", "sleep 30"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(MANAGER_TIMED_OUT);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("does not wait on a pipe a grandchild still holds after the timeout", async () => {
    const t0 = Date.now();
    // The grandchild `sleep` inherits stdout and outlives the killed shell.
    const r = await runManagerCmd(["sh", "-c", "sleep 30 & wait"], {
      capture: true,
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("reports a spawn failure as exit 1", async () => {
    const r = await runManagerCmd(["/nonexistent/oxmgr-binary", "status"]);
    expect(r).toEqual({ code: 1, stdout: "", timedOut: false });
  });
});

describe("cmdServe unknown subcommand", () => {
  it("fails fast instead of starting a foreground server", async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      writes.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await cmdServe(["bogus-subcommand"])).toBe(2);
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.join("")).toContain("unknown subcommand 'bogus-subcommand'");
    expect(writes.join("")).toContain("restart");
  });
});

// pm2 -> oxmgr migration: `ay serve install` reads a daemon still held by pm2
// (args + forwarded env) so oxmgr re-creates the same daemon.
describe("parsePm2Daemon", () => {
  const jlist = (procs: unknown[]) => JSON.stringify(procs);
  it("reads args (leading serve stripped), env and online status", () => {
    const out = jlist([
      { name: "other", pm2_env: { args: ["x"], status: "online" } },
      {
        name: "agent-yes",
        pm2_env: {
          args: ["serve", "--webrtc"],
          status: "online",
          env: { AGENT_YES_FOO: "1", N: 3 },
        },
      },
    ]);
    expect(parsePm2Daemon(out)).toEqual({
      args: ["--webrtc"],
      env: { AGENT_YES_FOO: "1" },
      online: true,
    });
  });
  it("reports a stopped daemon and missing args", () => {
    expect(parsePm2Daemon(jlist([{ name: "agent-yes", pm2_env: { status: "stopped" } }]))).toEqual({
      args: [],
      env: {},
      online: false,
    });
  });
  it("returns null when absent or unparsable", () => {
    expect(parsePm2Daemon(jlist([{ name: "other" }]))).toBeNull();
    expect(parsePm2Daemon("not json")).toBeNull();
    expect(parsePm2Daemon("{}")).toBeNull();
  });
});

describe("shouldBootstrapOxmgrOverPm2", () => {
  const base = {
    resolved: "pm2" as const,
    oxmgrPresent: false,
    platform: "linux" as const,
    env: {},
  };
  it("installs oxmgr when pm2 won only because oxmgr is absent", () => {
    expect(shouldBootstrapOxmgrOverPm2(base)).toBe(true);
    expect(shouldBootstrapOxmgrOverPm2({ ...base, platform: "darwin" })).toBe(true);
  });
  it("leaves oxmgr / no-manager / present-oxmgr cases alone", () => {
    expect(shouldBootstrapOxmgrOverPm2({ ...base, resolved: "oxmgr" })).toBe(false);
    expect(shouldBootstrapOxmgrOverPm2({ ...base, resolved: null })).toBe(false);
    expect(shouldBootstrapOxmgrOverPm2({ ...base, oxmgrPresent: true })).toBe(false);
  });
  it("respects Windows, a forced manager and the bootstrap opt-out", () => {
    expect(shouldBootstrapOxmgrOverPm2({ ...base, platform: "win32" })).toBe(false);
    expect(shouldBootstrapOxmgrOverPm2({ ...base, env: { AGENT_YES_DAEMON_MANAGER: "pm2" } })).toBe(
      false,
    );
    expect(shouldBootstrapOxmgrOverPm2({ ...base, env: { AGENT_YES_NO_PM_BOOTSTRAP: "1" } })).toBe(
      false,
    );
  });
});
