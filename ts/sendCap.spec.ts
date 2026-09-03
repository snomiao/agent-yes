import { describe, expect, it } from "vitest";
import { SEND_BODY_MAX_CHARS, sendPayloadCapError } from "./subcommands.ts";

describe("sendPayloadCapError", () => {
  it("measures the cap on the TRANSMITTED payload, not the body alone", () => {
    // The defect: a body under the cap was accepted and then transmitted with a
    // ~134-char envelope on top, so the enforced number was never the sent one.
    const body = SEND_BODY_MAX_CHARS - 50;
    expect(sendPayloadCapError(body, 0)).toBeNull();
    expect(sendPayloadCapError(body, 134)).toContain("would transmit");
  });

  it("passes a send that fits once the envelope is counted", () => {
    expect(sendPayloadCapError(SEND_BODY_MAX_CHARS - 134, 134)).toBeNull();
    expect(sendPayloadCapError(SEND_BODY_MAX_CHARS, 0)).toBeNull();
  });

  it("names the sender's real budget, which depends on their own envelope", () => {
    // The envelope carries the sender's cwd, branch and pid, so no constant
    // body budget can be quoted — it has to be computed per send.
    const short = sendPayloadCapError(SEND_BODY_MAX_CHARS, 100)!;
    const long = sendPayloadCapError(SEND_BODY_MAX_CHARS, 200)!;
    expect(short).toContain(`${SEND_BODY_MAX_CHARS - 100} chars of body`);
    expect(long).toContain(`${SEND_BODY_MAX_CHARS - 200} chars of body`);
  });

  it("reports the split so the sender can see where the overflow came from", () => {
    const err = sendPayloadCapError(1000, 134)!;
    expect(err).toContain("1134");
    expect(err).toContain("1000 of body");
    expect(err).toContain("134 of <ay-msg");
  });

  it("says nothing about an envelope when there is none", () => {
    // --raw and slash commands go out unwrapped; the whole cap is theirs.
    const err = sendPayloadCapError(SEND_BODY_MAX_CHARS + 1, 0)!;
    expect(err).not.toContain("envelope");
    expect(err).toContain(`≤${SEND_BODY_MAX_CHARS} chars`);
  });

  it("still points at the remedy that works — a path, not `-`", () => {
    const err = sendPayloadCapError(5000, 0)!;
    expect(err).toContain("the PATH");
    expect(err).toMatch(/'-' hits this same/);
  });

  it("refuses to quote a budget when the envelope alone exceeds the cap", () => {
    // Reachable by construction: nothing bounds a cwd's depth or a branch name's
    // length. Quoting a budget here printed "-76 chars of body" and then
    // "shorten to <=0" — contradictory, and impossible advice, since no body
    // length works. Caught in review by a lane that probed the boundary.
    const err = sendPayloadCapError(1, SEND_BODY_MAX_CHARS + 76)!;
    expect(err).not.toMatch(/-\d+ chars/);
    expect(err).not.toContain("budget");
    expect(err).toContain("no body length can fit");
    expect(err).toContain("--raw");
  });

  it("treats an envelope exactly at the cap as leaving no room", () => {
    const err = sendPayloadCapError(1, SEND_BODY_MAX_CHARS)!;
    expect(err).toContain("no body length can fit");
  });

  it("still quotes a real budget one char below that boundary", () => {
    const err = sendPayloadCapError(500, SEND_BODY_MAX_CHARS - 1)!;
    expect(err).toContain("1 chars of body");
    expect(err).not.toContain("no body length can fit");
  });
});
