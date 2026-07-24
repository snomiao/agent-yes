import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBookmarklet,
  buildEmbedSnippet,
  cmdCh,
  defaultName,
  defaultRole,
  formatMessage,
  readRegistry,
  resolveChannel,
} from "./channels.ts";
import type { Message } from "./channels/index.ts";

/** Capture stdout across a call. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    const code = await fn();
    return { code, out };
  } finally {
    spy.mockRestore();
  }
}

describe("ay ch identity defaults", () => {
  it("infers role from AGENT_YES_PID", () => {
    const prev = process.env.AGENT_YES_PID;
    process.env.AGENT_YES_PID = "123";
    expect(defaultRole()).toBe("agent");
    delete process.env.AGENT_YES_PID;
    expect(defaultRole()).toBe("human");
    if (prev !== undefined) process.env.AGENT_YES_PID = prev;
  });

  it("prefers $AY_CH_NAME for the display name", () => {
    const prev = process.env.AY_CH_NAME;
    process.env.AY_CH_NAME = "sonoda";
    expect(defaultName()).toBe("sonoda");
    delete process.env.AY_CH_NAME;
    expect(typeof defaultName()).toBe("string");
    if (prev !== undefined) process.env.AY_CH_NAME = prev;
  });
});

describe("formatMessage", () => {
  const base: Message = {
    id: "a@h",
    author: "a",
    name: "taku",
    role: "human",
    hlc: "h",
    text: "hello",
    deleted: false,
    reactions: [],
    ms: Date.UTC(2026, 0, 1, 3, 4, 5),
  };
  it("renders time, name(role initial), and text", () => {
    expect(formatMessage(base)).toBe("03:04:05  taku(h): hello");
  });
  it("shows (deleted) and reaction counts", () => {
    expect(formatMessage({ ...base, deleted: true, text: "" })).toContain("(deleted)");
    expect(formatMessage({ ...base, reactions: [{ emoji: "👍", by: ["a", "b"] }] })).toContain(
      "👍2",
    );
    expect(formatMessage({ ...base, reactions: [{ emoji: "🎉", by: ["a"] }] })).toContain("🎉");
  });
});

describe("ay ch CLI (local-only)", () => {
  let cwd: string;
  let origCwd: string;

  beforeEach(async () => {
    origCwd = process.cwd();
    cwd = await mkdtemp(path.join(os.tmpdir(), "ay-chcli-"));
    process.chdir(cwd);
  });
  afterEach(async () => {
    process.chdir(origCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("mk → send → read round-trips a message", async () => {
    const mk = await capture(() => cmdCh(["mk", "demo", "--name", "taku", "--role", "human"]));
    expect(mk.code).toBe(0);
    expect(mk.out).toContain("ay://ch/");

    const reg = await readRegistry(cwd);
    expect(reg.channels.demo).toBeTruthy();
    expect(reg.channels.demo!.name).toBe("taku");

    expect((await capture(() => cmdCh(["send", "demo", "hello", "world"]))).code).toBe(0);
    const read = await capture(() => cmdCh(["read", "demo"]));
    expect(read.out).toContain("taku(h): hello world");
  });

  it("lists channels with message counts", async () => {
    await capture(() => cmdCh(["mk", "demo", "--name", "a"]));
    await capture(() => cmdCh(["send", "demo", "one"]));
    const ls = await capture(() => cmdCh(["ls"]));
    expect(ls.out).toMatch(/demo\s+1/);
    const json = await capture(() => cmdCh(["ls", "--json"]));
    expect(JSON.parse(json.out).channels[0].messages).toBe(1);
  });

  it("join binds a topic to an invite link, and rm deletes the replica", async () => {
    const mk = await capture(() => cmdCh(["mk", "src"]));
    const link = /ay:\/\/\S+/.exec(mk.out)![0];

    const join = await capture(() => cmdCh(["join", link, "--as", "dst", "--name", "bob"]));
    expect(join.code).toBe(0);
    const reg = await readRegistry(cwd);
    // same underlying channel, different local topic + identity
    expect(reg.channels.dst!.channelId).toBe(reg.channels.src!.channelId);
    expect(reg.channels.dst!.author).not.toBe(reg.channels.src!.author);

    expect((await capture(() => cmdCh(["rm", "dst"]))).code).toBe(0);
    expect((await readRegistry(cwd)).channels.dst).toBeUndefined();
  });

  it("head and tail slice the thread", async () => {
    await capture(() => cmdCh(["mk", "c"]));
    for (const t of ["m1", "m2", "m3"]) await capture(() => cmdCh(["send", "c", t]));
    expect((await capture(() => cmdCh(["head", "c", "-n", "1"]))).out.trim()).toContain("m1");
    expect((await capture(() => cmdCh(["tail", "c", "-n", "1"]))).out.trim()).toContain("m3");
  });

  it("errors clearly on unknown channels, duplicate mk, and sending before join", async () => {
    expect((await capture(() => cmdCh(["mk", "dup"]))).code).toBe(0);
    // duplicate mk throws (surfaced by runSubcommand; here it rejects)
    await expect(cmdCh(["mk", "dup"])).rejects.toThrow(/already exists/);

    const reg = await readRegistry(cwd);
    await expect(resolveChannel(reg, "nope")).rejects.toThrow(/no channel/);

    // a link that isn't joined resolves read-only (no identity) → send refuses
    const mk = await capture(() => cmdCh(["mk", "src2"]));
    const link = /ay:\/\/\S+/.exec(mk.out)![0];
    const resolved = await resolveChannel(reg, "dup");
    expect(resolved.entry).toBeTruthy();
    const linkResolved = await resolveChannel(await readRegistry(cwd), link);
    expect(linkResolved.entry).toBeNull();
  });

  it("mk --topic derives the same channel for the same topic string", async () => {
    await capture(() => cmdCh(["mk", "a", "--topic", "https://example.com/p"]));
    await capture(() => cmdCh(["mk", "b", "--topic", "https://example.com/p"]));
    await capture(() => cmdCh(["mk", "c", "--topic", "https://example.com/other"]));
    const reg = await readRegistry(cwd);
    // same topic → same underlying channel; different topic → different channel
    expect(reg.channels.a!.channelId).toBe(reg.channels.b!.channelId);
    expect(reg.channels.c!.channelId).not.toBe(reg.channels.a!.channelId);
  });

  it("bookmarklet prints a javascript: URL that loads the widget by page topic", async () => {
    const out = (await capture(() => cmdCh(["bookmarklet"]))).out;
    expect(out).toMatch(/^javascript:/);
    expect(out).toContain("AyChannel.fromTopic");
    expect(out).toContain("agent-yes.com/w/channels.js");
    // custom host/sighost flow through
    const bm = buildBookmarklet("beta.example.dev", "sig.example.dev");
    expect(bm).toContain("beta.example.dev/w/channels.js");
    expect(bm).toContain("sig.example.dev");
    expect(bm).toContain("location.href"); // default topic = full page URL
  });

  it("embed modes trade off where the secret lives", async () => {
    await capture(() => cmdCh(["mk", "pub"]));
    // default (live): the secret IS in the file
    expect((await capture(() => cmdCh(["embed", "pub"]))).out).toContain("e1.");
    // --placeholder: no secret; runtime-injected global
    const ph = (await capture(() => cmdCh(["embed", "pub", "--placeholder"]))).out;
    expect(ph).not.toContain("e1.");
    expect(ph).toContain("window.AY_CH_LINK");
    // --from-url: no secret; derived from the page URL (safe for static pages)
    const fu = (await capture(() => cmdCh(["embed", "pub", "--from-url"]))).out;
    expect(fu).not.toContain("e1.");
    expect(fu).toContain("AyChannel.fromTopic(location.href)");
    // the two secret-less modes are mutually exclusive
    await expect(cmdCh(["embed", "pub", "--from-url", "--placeholder"])).rejects.toThrow(
      /mutually/,
    );
  });

  it("buildEmbedSnippet: always a <script> (never an iframe), across modes", () => {
    const live = buildEmbedSnippet("agent-yes.com", "t", {
      kind: "live",
      link: "ay://ch/h/r#e1.dead",
    });
    expect(live).toContain("<script");
    expect(live).not.toContain("<iframe");
    expect(live).toContain("ay://ch/h/r#e1.dead");
    const fu = buildEmbedSnippet("self.example", "t", { kind: "from-url" });
    expect(fu).toContain("self.example/w/channels.js");
    expect(fu).toContain("fromTopic(location.href)");
    expect(fu).not.toContain("e1.");
    expect(buildEmbedSnippet("h", "t", { kind: "placeholder" })).toContain("window.AY_CH_LINK");
  });

  it("prints help for no subcommand and rejects unknown ones", async () => {
    expect((await capture(() => cmdCh([]))).out).toContain("ay ch -");
    const bad = await capture(() => cmdCh(["frobnicate"]));
    expect(bad.code).toBe(1);
  });
});
