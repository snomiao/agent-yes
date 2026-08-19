import { describe, expect, it } from "bun:test";
import { buildTermEmbedSnippet } from "./terminal.ts";

describe("buildTermEmbedSnippet", () => {
  it("discover mode: no token in the file, imports terminal.js, mounts", () => {
    const s = buildTermEmbedSnippet("agent-yes.com", "12345", { kind: "discover" });
    expect(s).toContain(`import AyTerminal from "https://agent-yes.com/w/terminal.js"`);
    expect(s).toContain(`new AyTerminal({ pid: "12345" })`);
    expect(s).toContain(`.mount(document.getElementById("ay-term") ?? undefined)`);
    expect(s).not.toContain("token:"); // safe default — no secret baked in
    expect(s).not.toContain("readOnly"); // read-only is the default
    expect(s).toContain("read-only view");
  });

  it("placeholder mode: reads window.AY_TERM_TOKEN at runtime", () => {
    const s = buildTermEmbedSnippet("agent-yes.com", "42", { kind: "placeholder" });
    expect(s).toContain("token: window.AY_TERM_TOKEN");
    expect(s).not.toContain('"undefined"');
  });

  it("live mode: bakes the token, warns in the comment", () => {
    const s = buildTermEmbedSnippet("h.example", "7", { kind: "live", token: "tok-abc" });
    expect(s).toContain(`token: "tok-abc"`);
    expect(s).toContain("LIVE token");
    expect(s).toContain(`import AyTerminal from "https://h.example/w/terminal.js"`);
  });

  it("interactive opt-in sets readOnly:false and labels the comment", () => {
    const s = buildTermEmbedSnippet("agent-yes.com", "9", {
      kind: "live",
      token: "t",
      interactive: true,
    });
    expect(s).toContain("readOnly: false");
    expect(s).toContain("interactive view");
  });

  it("origin is threaded through for a cross-origin daemon", () => {
    const s = buildTermEmbedSnippet("agent-yes.com", "9", {
      kind: "discover",
      origin: "https://box.local:8787",
    });
    expect(s).toContain(`origin: "https://box.local:8787"`);
  });

  it("escapes the pid into a JSON string (no injection into the snippet)", () => {
    const s = buildTermEmbedSnippet("agent-yes.com", 'a"b', { kind: "discover" });
    expect(s).toContain(`pid: "a\\"b"`);
  });
});
