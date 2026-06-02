import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "os";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

describe("agentYesHome", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.AGENT_YES_HOME;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = original;
  });

  it("uses $AGENT_YES_HOME when set", () => {
    process.env.AGENT_YES_HOME = "/custom/ay-home";
    expect(agentYesHome()).toBe("/custom/ay-home");
  });

  it("falls back to ~/.agent-yes when unset", () => {
    delete process.env.AGENT_YES_HOME;
    expect(agentYesHome()).toBe(path.join(homedir(), ".agent-yes"));
  });
});
