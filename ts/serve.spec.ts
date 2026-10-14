import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import {
  installerArgv,
  LEGACY_AYRS_TASK,
  legacyAyrsTaskArgv,
  serveLauncher,
  probeDaemon,
  isNoNodeExecError,
  oxmgrCmd,
  oxmgrVersionHasWindowsFix,
  parseGitUrl,
  portlessConsoleUrl,
  shareLinkStatus,
  vendorAssetType,
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
      /Bun\.spawn\((?:\[[^\]]*\bm(?:gr)?\.bin[^\]]*\]|startArgv|installer),[\s\S]*?\}\)/g,
    );
    expect(calls?.length).toBeGreaterThanOrEqual(7);
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
      expect(await probeDaemon(port, "tok", 5000)).toEqual({
        kind: "ok",
        version: "9.9.9",
      });
    } finally {
      srv.close();
    }
  });

  it("treats a null port as down without dialling", async () => {
    expect((await probeDaemon(null, "tok", 1)).kind).toBe("down");
  });
});

// `ay serve status` reads ~/.agent-yes/.share-link, which outlives the daemon
// config that minted it: reinstalling without --share leaves the file behind
// while nothing hosts the room. The link must then be flagged stale, not shown
// as if it were live.
describe("shareLinkStatus", () => {
  const link = "https://agent-yes.com/w/#r111111:e1.aaaa";
  it("reports a link as live when the registered daemon shares", () => {
    expect(shareLinkStatus(link, true, true)).toEqual({ link, stale: false });
  });
  it("flags the link stale when the daemon is installed without --share/--webrtc", () => {
    expect(shareLinkStatus(link, true, false)).toEqual({ link, stale: true });
  });
  it("does not call it stale when no daemon is registered (a foreground serve may host it)", () => {
    expect(shareLinkStatus(link, false, false)).toEqual({ link, stale: false });
  });
  it("returns no link when the file is absent", () => {
    expect(shareLinkStatus(null, true, false)).toEqual({
      link: null,
      stale: false,
    });
  });
});

// oxmgr takes its command as ONE string and shell-splits it, treating `\` as
// an escape: an unquoted Windows path lost every separator on the way in
// (`C:\Users\…\ay.exe` → `C:Users…ay.exe` → "failed to spawn"). Quoting is what
// suppresses that, so every arg carrying a backslash, whitespace or a quote
// must be double-quoted; plain args stay bare.
describe("oxmgrCmd", () => {
  it("quotes args with backslashes or spaces and leaves plain ones bare", () => {
    expect(oxmgrCmd([String.raw`C:\x\ay.exe`, "serve", "--share"])).toBe(
      String.raw`"C:\x\ay.exe" serve --share`,
    );
    expect(oxmgrCmd(["/usr/bin/bun", "/x/a b/ay", "serve"])).toBe('/usr/bin/bun "/x/a b/ay" serve');
  });
  it("escapes an embedded double quote inside a quoted arg", () => {
    expect(oxmgrCmd(['say "hi"'])).toBe(String.raw`"say \"hi\""`);
  });
});

// The console self-hosts xterm from ./vendor/ (#317), but the TS daemon's
// static allowlist never routed /vendor/*, so those render-blocking scripts
// fell through to the token-gated API and came back 401 — the terminal pane
// sat on "connecting…" with `Terminal is not defined`. Exactly the shipped
// files are served; anything else (a traversal, a stray file) is a 404.
describe("vendorAssetType", () => {
  it("types the pinned xterm builds the page loads", () => {
    expect(vendorAssetType("xterm.min.css")).toBe("text/css; charset=utf-8");
    for (const js of [
      "xterm.min.js",
      "addon-fit.min.js",
      "addon-web-links.min.js",
      "addon-clipboard.min.js",
    ]) {
      expect(vendorAssetType(js)).toBe("text/javascript; charset=utf-8");
    }
  });
  it("refuses anything that is not a shipped vendor asset", () => {
    expect(vendorAssetType("../index.html")).toBeNull();
    expect(vendorAssetType("xterm.min.js.map")).toBeNull();
    expect(vendorAssetType("")).toBeNull();
  });
});

// The daemon manager stores this argv verbatim and re-runs it on every
// restart: a baked-in `~/.bun/bin/ay` symlink (recreated on each global
// upgrade, absent on some images until the first one) or a bare `ay` that a
// manager's minimal PATH cannot resolve both turn into an ENOENT restart loop.
describe("serveLauncher", () => {
  const realpath = (p: string) =>
    p.replace(
      "/home/alice/.bun/bin/ay",
      "/home/alice/.bun/install/global/node_modules/agent-yes/dist/cli.js",
    );

  it("resolves the PATH symlink to the real script and runs it under bun", () => {
    expect(
      serveLauncher({
        which: "/home/alice/.bun/bin/ay",
        script: "/x/cli.js",
        execPath: "/usr/bin/bun",
        platform: "linux",
        realpath,
      }),
    ).toEqual([
      "/usr/bin/bun",
      "/home/alice/.bun/install/global/node_modules/agent-yes/dist/cli.js",
    ]);
  });

  it("falls back to the running script, never to a bare `ay`, when nothing is on PATH", () => {
    expect(
      serveLauncher({
        which: null,
        script: "/repo/alpha/dist/cli.js",
        execPath: "/usr/bin/bun",
        platform: "linux",
        realpath,
      }),
    ).toEqual(["/usr/bin/bun", "/repo/alpha/dist/cli.js"]);
  });

  it("survives a realpath failure by keeping the path it was given", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(
      serveLauncher({
        which: "/opt/ay",
        script: undefined,
        execPath: "/usr/bin/bun",
        platform: "linux",
        realpath: boom,
      }),
    ).toEqual(["/usr/bin/bun", "/opt/ay"]);
  });

  it("runs a Windows exe shim directly and a script under bun", () => {
    const id = (p: string) => p;
    expect(
      serveLauncher({
        which: "C:/Users/alice/.bun/bin/ay.exe",
        script: undefined,
        execPath: "C:/bun.exe",
        platform: "win32",
        realpath: id,
      }),
    ).toEqual(["C:/Users/alice/.bun/bin/ay.exe"]);
    expect(
      serveLauncher({
        which: null,
        script: "C:/repo/alpha/dist/cli.js",
        execPath: "C:/bun.exe",
        platform: "win32",
        realpath: id,
      }),
    ).toEqual(["C:/bun.exe", "C:/repo/alpha/dist/cli.js"]);
  });
});

// A scheduled-task host from before the oxmgr move keeps the WebRTC room; the
// new daemon then waits on it forever. Install and uninstall both clear it.
describe("legacyAyrsTaskArgv", () => {
  it("names the task ayrs serve install registered, with the right schtasks verbs", () => {
    expect(LEGACY_AYRS_TASK).toBe("com.snomiao.ayrs-serve");
    expect(legacyAyrsTaskArgv("query")).toEqual([
      "schtasks",
      "/query",
      "/tn",
      LEGACY_AYRS_TASK,
      "/fo",
      "LIST",
    ]);
    expect(legacyAyrsTaskArgv("end")).toEqual(["schtasks", "/end", "/tn", LEGACY_AYRS_TASK]);
    expect(legacyAyrsTaskArgv("delete")).toEqual([
      "schtasks",
      "/delete",
      "/tn",
      LEGACY_AYRS_TASK,
      "/f",
    ]);
  });
});
