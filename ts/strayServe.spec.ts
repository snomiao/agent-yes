import { describe, expect, it } from "vitest";
import { parseStrayServeProcesses } from "./strayServe.ts";

describe("parseStrayServeProcesses", () => {
  it("finds foreground ay serve processes", () => {
    const rows = parseStrayServeProcesses(
      [
        "  101 /Users/me/.bun/bin/bun /Users/me/.bun/bin/ay serve --webrtc",
        "  102 bun /repo/dist/agent-yes.js serve --share",
      ].join("\n"),
      { selfPid: 999, parentPid: 998 },
    );

    expect(rows).toEqual([
      { pid: 101, command: "/Users/me/.bun/bin/bun /Users/me/.bun/bin/ay serve --webrtc" },
      { pid: 102, command: "bun /repo/dist/agent-yes.js serve --share" },
    ]);
  });

  it("excludes management commands and this process family", () => {
    const rows = parseStrayServeProcesses(
      [
        "  200 ay serve install --webrtc",
        "  201 ay serve uninstall",
        "  202 ay serve status",
        "  203 ay serve logs",
        "  204 ay serve restart",
        "  300 ay serve --webrtc",
        "  301 ay serve --webrtc",
        "  302 ay serve --webrtc",
      ].join("\n"),
      { selfPid: 300, parentPid: 301 },
    );

    expect(rows).toEqual([{ pid: 302, command: "ay serve --webrtc" }]);
  });

  it("ignores unrelated commands", () => {
    const rows = parseStrayServeProcesses(
      [
        "  401 ay send serve --webrtc",
        "  402 agent-yes status",
        "  403 node ./dist/cli.js share",
      ].join("\n"),
      { selfPid: 999, parentPid: 998 },
    );

    expect(rows).toEqual([]);
  });
});
