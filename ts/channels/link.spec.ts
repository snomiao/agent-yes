import { describe, expect, it } from "vitest";
import {
  deriveChannelId,
  deriveRoom,
  formatChannelLink,
  formatChannelWebLink,
  isChannelLink,
  parseChannelLink,
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
