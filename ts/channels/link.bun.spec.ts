import { describe, expect, it } from "bun:test";
import {
  deriveChannelId,
  deriveRoom,
  formatChannelLink,
  formatChannelWebLink,
  isChannelLink,
  parseChannelLink,
  secretFromTopic,
} from "./link.ts";

const S = "a".repeat(64); // a valid 64-hex secret

describe("channel identity derivation", () => {
  it("derives a stable, topic-blind channelId and room from the secret", async () => {
    const [id1, id2] = await Promise.all([deriveChannelId(S), deriveChannelId(S)]);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
    const room = await deriveRoom(S);
    expect(room).toMatch(/^c[0-9a-f]{12}$/); // matches the signaling room grammar
    // different secret → different identity
    expect(await deriveChannelId("b".repeat(64))).not.toBe(id1);
  });

  it("rejects a non-hex secret before hashing", async () => {
    await expect(deriveChannelId("not-hex")).rejects.toThrow();
  });

  it("derives a deterministic, valid secret from a topic (same URL → same channel)", async () => {
    const url = "https://example.com/docs/page";
    const [a, b] = await Promise.all([secretFromTopic(url), secretFromTopic(url)]);
    expect(a).toBe(b); // deterministic
    expect(a).toMatch(/^[0-9a-f]{64}$/); // a valid S
    // usable as a real secret end-to-end
    await expect(deriveChannelId(a)).resolves.toMatch(/^[0-9a-f]{16}$/);
    // distinct topics (incl. a differing hash) yield distinct channels
    expect(await secretFromTopic(url + "#section")).not.toBe(a);
    expect(await secretFromTopic("https://example.com/other")).not.toBe(a);
  });
});

describe("channel invite links", () => {
  const link = { sighost: "s.agent-yes.com", room: "cabc123", s: S };

  it("round-trips the ay:// form", () => {
    const str = formatChannelLink(link);
    expect(str).toBe(`ay://ch/s.agent-yes.com/cabc123#e1.${S}`);
    expect(parseChannelLink(str)).toEqual(link);
    expect(isChannelLink(str)).toBe(true);
  });

  it("round-trips the browser https form, defaulting the sighost", () => {
    const web = formatChannelWebLink(link);
    expect(web).toBe(`https://agent-yes.com/w/#ch=cabc123:e1.${S}`);
    expect(parseChannelLink(web)).toEqual(link);
    // a non-default sighost is carried explicitly
    const custom = { ...link, sighost: "sig.example.com" };
    expect(parseChannelLink(formatChannelWebLink(custom))).toEqual(custom);
  });

  it("returns null for non-links and throws on a malformed secret slot", () => {
    expect(parseChannelLink("just a topic name")).toBeNull();
    expect(isChannelLink("topic")).toBe(false);
    // http url without the #ch= fragment is not a channel link
    expect(isChannelLink("https://example.com/page")).toBe(false);
    expect(parseChannelLink("https://example.com/page")).toBeNull();
    // https channel form missing the room:secret separator → null
    expect(parseChannelLink("https://x/w/#ch=noseparator")).toBeNull();
    expect(() => parseChannelLink("ay://ch/host/room#e1.short")).toThrow();
    expect(() => parseChannelLink("https://x/w/#ch=room:e1.short")).toThrow();
  });
});
