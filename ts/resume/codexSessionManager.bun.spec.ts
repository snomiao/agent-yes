import { describe, expect, it } from "bun:test";
import { extractSessionId, extractSessionIdFromSessionMeta } from "./codexSessionManager";

describe("codexSessionManager", () => {
  describe("extractSessionId", () => {
    it("should extract UUID session ID from output", () => {
      const output = "Some text with session ID: 0199e659-0e5f-7843-8876-5a65c64e77c0 in it";
      const sessionId = extractSessionId(output);
      expect(sessionId).toBe("0199e659-0e5f-7843-8876-5a65c64e77c0");
    });

    it("should return null if no session ID found", () => {
      const output = "Some text without session ID";
      const sessionId = extractSessionId(output);
      expect(sessionId).toBe(null);
    });

    it("should handle uppercase UUIDs", () => {
      const output = "Session: 0199E659-0E5F-7843-8876-5A65C64E77C0";
      const sessionId = extractSessionId(output);
      expect(sessionId).toBe("0199E659-0E5F-7843-8876-5A65C64E77C0");
    });
  });

  describe("extractSessionIdFromSessionMeta", () => {
    it("should extract session ID from session metadata JSON", () => {
      const sessionContent = `{"timestamp":"2025-10-15T05:30:20.265Z","type":"session_meta","payload":{"id":"0199e659-0e5f-7843-8876-5a65c64e77c0","timestamp":"2025-10-15T05:30:20.127Z","cwd":"/some/path"}}
{"timestamp":"2025-10-15T05:30:20.415Z","type":"response_item","payload":{"type":"message","role":"user"}}`;

      const sessionId = extractSessionIdFromSessionMeta(sessionContent);
      expect(sessionId).toBe("0199e659-0e5f-7843-8876-5a65c64e77c0");
    });

    it("should fall back to regex extraction if JSON parsing fails", () => {
      const sessionContent = "Invalid JSON but contains 0199e659-0e5f-7843-8876-5a65c64e77c0";
      const sessionId = extractSessionIdFromSessionMeta(sessionContent);
      expect(sessionId).toBe("0199e659-0e5f-7843-8876-5a65c64e77c0");
    });

    it("should return null if no session ID found", () => {
      const sessionContent = "No session ID here";
      const sessionId = extractSessionIdFromSessionMeta(sessionContent);
      expect(sessionId).toBe(null);
    });
  });
});
