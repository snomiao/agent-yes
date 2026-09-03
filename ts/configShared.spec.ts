import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileRegexSource,
  findSharedCliDefaultsPath,
  isRegexSource,
  loadSharedCliDefaults,
  normalizeAgentYesConfig,
  normalizeCliConfig,
} from "./configShared.ts";

describe("configShared", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("compiles structured regex sources with flags", () => {
    const regex = compileRegexSource({ pattern: "^foo$", flags: "m" });
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex.flags).toContain("m");
  });

  it("returns RegExp instances unchanged", () => {
    const regex = /foo/;
    expect(compileRegexSource(regex)).toBe(regex);
  });

  it("normalizes legacy exitCommand to exitCommands", () => {
    const config = normalizeCliConfig({ exitCommand: ["/quit"] });
    expect(config.exitCommands).toEqual(["/quit"]);
  });

  it("normalizes configDir, logsDir, and regex arrays", () => {
    const config = normalizeAgentYesConfig({
      configDir: "/cfg",
      logsDir: "/logs",
      clis: {
        claude: {
          ready: [{ pattern: "^ready$", flags: "m" }],
          typingRespond: {
            "1\n": ["^confirm$"],
          },
        },
      },
    });

    expect(config.configDir).toBe("/cfg");
    expect(config.logsDir).toBe("/logs");
    expect(config.clis?.claude.ready?.[0]).toBeInstanceOf(RegExp);
    expect(config.clis?.claude.typingRespond?.["1\n"]?.[0]).toBeInstanceOf(RegExp);
  });

  it("loads shared YAML defaults for codex", async () => {
    const clis = await loadSharedCliDefaults(import.meta.url);
    expect(clis.codex).toBeDefined();
    expect(clis.codex.ready?.some((regex) => regex.test("› "))).toBe(true);
    expect(clis.codex.ready?.some((regex) => regex.test("⏎ send"))).toBe(true);
  });

  it("auto-confirms opencode's Always-allow permission dialog", async () => {
    const clis = await loadSharedCliDefaults(import.meta.url);
    expect(clis.opencode).toBeDefined();
    expect(clis.opencode.promptArg).toBe("--prompt");
    // Real screen excerpt from OpenCode 1.18.15 (focus defaults to Confirm,
    // footer advertises "enter confirm" — a bare Enter accepts).
    const dialog =
      "△ Always allow\n\nThis will allow the following patterns until OpenCode is restarted\n\n- /Users/sno/*\n\n Confirm   Cancel                                  ⇆ select  enter confirm";
    expect(clis.opencode.enter?.some((regex) => regex.test(dialog))).toBe(true);
    // Prose merely mentioning the buttons must not trigger an Enter.
    expect(
      clis.opencode.enter?.some((regex) =>
        regex.test("click Confirm or Cancel in the Always allow dialog"),
      ),
    ).toBe(false);
    expect(
      clis.opencode.needsInput?.some((regex) =>
        regex.test(" Confirm   Cancel        ⇆ select  enter confirm"),
      ),
    ).toBe(true);
  });

  it("declares bracketed paste only for CLIs measured to enable the mode", async () => {
    const clis = await loadSharedCliDefaults(import.meta.url);
    // Enabled where the agents' PTY logs actually carry ESC[?2004h.
    expect(clis.claude?.bracketedPaste).toBe(true);
    expect(clis.codex?.bracketedPaste).toBe(true);
    // A shell is not opted in: it never turns the mode on, so the markers would
    // land as literal text — and a multi-line body there is several commands,
    // which is what the sender meant.
    expect(clis.bash?.bracketedPaste).toBeFalsy();
  });

  // The DECIDE half of paste framing: BOTH send paths — cmdSend and serve.ts's
  // POST /api/send — compose the same config lookup, the body, and
  // isSlashCommand into shouldFramePaste. Each piece is tested on its own; this
  // pins the JOIN, which is the part that rots SILENTLY, and it speaks for both
  // sites because the composition is what it asserts, not one call site. A renamed
  // config key, a CLI added to default.config.yaml without the flag, or
  // isSlashCommand drifting would each leave `supported` false — nothing goes
  // red, messages just start losing their heads again (the failure #455 fixed).
  //
  // Needs no FIFO, so unlike the byte-level DELIVER assertions it runs on every
  // platform. It does NOT replace those: it cannot prove framed bytes reach the
  // pipe, only that the decision this config drives is still the right one.
  it("decides framing from the real config, the way both send paths compose it", async () => {
    const { isSlashCommand } = await import("./subcommands.ts");
    const { shouldFramePaste } = await import("./bracketedPaste.ts");
    const clis = await loadSharedCliDefaults(import.meta.url);
    const decide = (cli: string, body: string) =>
      shouldFramePaste({
        supported: Boolean(clis[cli]?.bracketedPaste),
        body,
        isSlashCommand: isSlashCommand(body),
      });

    expect(decide("claude", "the deploy is green")).toBe(true);
    expect(decide("codex", "the deploy is green")).toBe(true);
    // A shell never enables the mode; the markers would land as literal text.
    expect(decide("bash", "echo hi")).toBe(false);
    // Recognized only when typed — pasted text is not typing.
    expect(decide("claude", "/model opus")).toBe(false);
    // An unknown CLI is unconfigured, so it must not be framed on a guess.
    expect(decide("no-such-cli", "the deploy is green")).toBe(false);
  });

  it("finds the shared defaults file by walking upward", async () => {
    const found = await findSharedCliDefaultsPath(import.meta.url);
    expect(found.endsWith("default.config.yaml")).toBe(true);
  });

  it("throws when no shared defaults file exists in parent directories", async () => {
    const tempDir = path.join(os.tmpdir(), `agent-yes-config-shared-${Date.now()}-missing`);
    tempRoots.push(tempDir);
    await mkdir(tempDir, { recursive: true });

    await expect(
      findSharedCliDefaultsPath(pathToFileURL(path.join(tempDir, "entry.js")).href),
    ).rejects.toThrow("Unable to locate");
  });

  it("throws when the located shared defaults file is not an object", async () => {
    const tempDir = path.join(os.tmpdir(), `agent-yes-config-shared-${Date.now()}-invalid`);
    tempRoots.push(tempDir);
    await mkdir(tempDir, { recursive: true });
    await writeFile(path.join(tempDir, "default.config.yaml"), "123\n");

    await expect(
      loadSharedCliDefaults(pathToFileURL(path.join(tempDir, "entry.js")).href),
    ).rejects.toThrow("Invalid shared CLI defaults file");
  });

  it("recognizes valid and invalid regex source shapes", () => {
    expect(isRegexSource("^ready$")).toBe(true);
    expect(isRegexSource({ pattern: "^ready$", flags: "m" })).toBe(true);
    expect(isRegexSource({ pattern: 123 })).toBe(false);
    expect(isRegexSource({ pattern: "^ready$", flags: 1 })).toBe(false);
  });
});
