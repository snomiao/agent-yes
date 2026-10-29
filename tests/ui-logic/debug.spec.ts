// The console's debug-mode switches (lab/ui/debug.js): when it is on, and what
// a session may see. The server enforces the same owner rule (cf/liagent.ts).
import { describe, expect, it } from "vitest";
import { debugRole, debugWanted } from "../../lab/ui/debug.js";

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("debugWanted", () => {
  it("is off by default, turned on by ?debug and remembered", () => {
    const s = memStore();
    expect(debugWanted("", s)).toBe(false);
    expect(debugWanted("?debug", s)).toBe(true);
    expect(debugWanted("", s)).toBe(true);
  });

  it("?debug=0 forgets it", () => {
    const s = memStore();
    debugWanted("?debug=1", s);
    expect(debugWanted("?debug=0", s)).toBe(false);
    expect(debugWanted("", s)).toBe(false);
  });

  it("follows the URL alone when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(debugWanted("?debug", broken)).toBe(true);
    expect(debugWanted("", broken)).toBe(false);
  });
});

describe("debugRole", () => {
  it("tells the owner from everyone else", () => {
    expect(debugRole(null)).toBe("none");
    expect(debugRole({})).toBe("none");
    expect(debugRole({ user: { email: "snomiao@gmail.com", emailVerified: true } })).toBe("owner");
    expect(debugRole({ user: { email: "snomiao@gmail.com", emailVerified: false } })).toBe("other");
    expect(debugRole({ user: { email: "alice@example.com", emailVerified: true } })).toBe("other");
  });
});
